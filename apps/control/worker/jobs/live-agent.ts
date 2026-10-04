import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, tool, type ModelMessage, type ToolResultPart } from 'ai';
import { z } from 'zod';
import {
  ChangeIntent,
  SHARED_SYSTEM_INSTRUCTION,
  type SourceBundle,
  type TaskSpec,
  digestBytes,
  estimateMaxCost,
  matchesAny,
  usageCost,
} from '@converge/domain';
import { runSuite } from '@converge/verification';
import { evidencePrefix, verifyEvidence, writeEvidence } from '../evidence.ts';
import type { AgentInput } from './agent.ts';
import { sealRevision } from './agent.ts';
import { projectDefinition } from '../projects.ts';
import { type JobContext, isStaleFence, retrying } from './context.ts';

const MAX_INPUT_TOKENS = 120_000;
const MAX_OUTPUT_TOKENS = 8_000;
const MAX_TOOL_CALLS_PER_TURN = 8;
const MAX_TOOL_RESULT_CHARS = 32 * 1024;
const MODEL_TIMEOUT_MS = 150_000;

/** Durable state carried between workflow steps: only references and small counters. */
interface AgentState {
  source: { key: string; sha256: string };
  messages: { key: string; sha256: string } | null;
  inboxCursor: number;
  intentVersion: number;
  done: null | { kind: 'finish'; summary: string } | { kind: 'blocked'; reason: string; code: string };
}

const tools = {
  list_files: tool({
    description: 'List repository files (bounded). Optionally filter by path prefix.',
    inputSchema: z.object({ prefix: z.string().max(200).optional() }),
  }),
  read_file: tool({
    description: 'Read one file with its current sha256 digest. Use the digest as expectedSha256 when editing.',
    inputSchema: z.object({ path: z.string().min(1).max(240) }),
  }),
  search_files: tool({
    description: 'Literal (not regex) text search across files. Returns path:line matches (bounded).',
    inputSchema: z.object({ query: z.string().min(1).max(200), prefix: z.string().max(200).optional() }),
  }),
  apply_edits: tool({
    description:
      'Atomically replace whole files. Each edit gives the full new content and the sha256 you read (null for a new file). All edits apply or none do. Only your editable paths are allowed.',
    inputSchema: z.object({
      edits: z
        .array(z.object({ path: z.string().min(1).max(240), expectedSha256: z.string().nullable(), content: z.string().max(256 * 1024) }))
        .min(1)
        .max(8),
    }),
  }),
  declare_intent: tool({
    description:
      'Create or update your structured ChangeIntent. Pass expectedVersion = the version you last saw (0 before the first declaration).',
    inputSchema: z.object({ expectedVersion: z.number().int().min(0), intent: ChangeIntent }),
  }),
  read_inbox: tool({ description: 'Read targeted coordination messages addressed to you since your cursor.', inputSchema: z.object({}) }),
  request_context: tool({
    description: 'Read the shared baseline contract facts and other agents\' declared intent summaries (never their transcripts).',
    inputSchema: z.object({}),
  }),
  run_check: tool({
    description: 'Run an allowlisted developer check on your workspace in an isolated container: typecheck, unit, or build.',
    inputSchema: z.object({ check: z.enum(['typecheck', 'unit', 'build']) }),
  }),
  request_verification: tool({
    description:
      'Build your workspace and run the protected HTTP checks that apply to your task. Feedback only: authoritative verification happens after sealing.',
    inputSchema: z.object({}),
  }),
  checkpoint: tool({ description: 'Persist your workspace state now (it is also persisted after every turn).', inputSchema: z.object({}) }),
  finish: tool({
    description: 'Request sealing. Describe implemented behavior, remaining assumptions, evidence, and limitations.',
    inputSchema: z.object({ summary: z.string().min(1).max(4000) }),
  }),
  report_blocker: tool({ description: 'Stop and ask for human attention with a concrete reason.', inputSchema: z.object({ reason: z.string().min(1).max(2000) }) }),
};

type ToolName = keyof typeof tools;

export async function runLiveAgent(ctx: JobContext, input: AgentInput, baseline: { key: string; sha256: string }): Promise<void> {
  const { lease, step, coordinator, config, env } = ctx;
  if (!env.ANTHROPIC_API_KEY) {
    await step.do('block: no provider key', retrying, () => coordinator.wfAgentBlocked(lease.jobId, lease.fence, 'model provider secret is not configured', 'DEPENDENCY_UNAVAILABLE'));
    return;
  }
  const task = await step.do('read task spec', retrying, async () => (await coordinator.getProposal(input.proposalId)).taskSpec as TaskSpec);
  let state: AgentState = { source: baseline, messages: null, inboxCursor: 0, intentVersion: 0, done: null };
  const startedAt = Date.now();

  for (let turn = 0; turn < config.MAX_AGENT_TURNS && !state.done; turn++) {
    const prev: AgentState = state;
    try {
      state = await step.do(`turn ${turn}`, { retries: { limit: 1, delay: '5 seconds', backoff: 'constant' }, timeout: '8 minutes' }, () =>
        runTurn(ctx, input, task, prev, turn),
      );
    } catch (err) {
      if (isStaleFence(err)) return; // cancelled or superseded: stop quietly
      throw err;
    }
  }

  const done = state.done;
  if (!done) {
    await step.do('block: turn limit', retrying, () =>
      coordinator.wfAgentBlocked(lease.jobId, lease.fence, `agent reached the ${config.MAX_AGENT_TURNS}-turn limit without finishing`, 'TURN_LIMIT'),
    );
    return;
  }
  if (done.kind === 'blocked') {
    await step.do('report blocker', retrying, () => coordinator.wfAgentBlocked(lease.jobId, lease.fence, done.reason, done.code));
    return;
  }
  const edits = await step.do('diff workspace against baseline', retrying, async () => {
    const [base, current] = await Promise.all([
      verifyEvidence<SourceBundle>(env.EVIDENCE, baseline.key, baseline.sha256),
      verifyEvidence<SourceBundle>(env.EVIDENCE, state.source.key, state.source.sha256),
    ]);
    const before = new Map(base.files.map((f) => [f.path, f.utf8]));
    const after = new Map(current.files.map((f) => [f.path, f.utf8]));
    const out: Array<{ path: string; utf8: string | null }> = [];
    for (const [path, utf8] of after) if (before.get(path) !== utf8) out.push({ path, utf8 });
    for (const path of before.keys()) if (!after.has(path)) out.push({ path, utf8: null });
    return out;
  });
  await sealRevision(ctx, input, edits, done.summary, startedAt);
}

async function runTurn(ctx: JobContext, input: AgentInput, task: TaskSpec, state: AgentState, turn: number): Promise<AgentState> {
  const { lease, coordinator, config, env } = ctx;
  await coordinator.wfHeartbeat(lease.jobId, lease.fence);
  const bundle = await verifyEvidence<SourceBundle>(env.EVIDENCE, state.source.key, state.source.sha256);
  const messages: ModelMessage[] = state.messages
    ? await verifyEvidence<ModelMessage[]>(env.EVIDENCE, state.messages.key, state.messages.sha256)
    : [{ role: 'user', content: kickoff(input, task) }];

  // Reserve a conservative maximum before the provider request.
  const opKey = `${lease.jobId}:a${lease.attemptNo}:t${turn}`;
  const reserve = await coordinator.wfBudgetReserve(lease.jobId, lease.fence, opKey, estimateMaxCost(config.MODEL_PRICE_SNAPSHOT, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS));
  if (!reserve.ok) return { ...state, done: { kind: 'blocked', reason: 'model budget exhausted for this session', code: 'BUDGET_EXCEEDED' } };

  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const activityId = `${opKey}:model`;
  const modelStarted = Date.now();
  await coordinator.wfActivity(lease.jobId, lease.fence, { id: activityId, kind: 'model', label: `model turn ${turn}`, startedAt: modelStarted });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), MODEL_TIMEOUT_MS);
  let result: Awaited<ReturnType<typeof generateText<typeof tools>>>;
  try {
    result = await generateText({
      model: anthropic(config.MODEL_ID),
      system: `${SHARED_SYSTEM_INSTRUCTION}\n\nYour editable paths: ${task.editablePaths.join(', ')}. Protected paths you must not edit: ${task.forbiddenPaths.join(', ')}.`,
      messages,
      tools,
      toolChoice: 'auto',
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      abortSignal: abort.signal,
      // Haiku 4.5 rejects `effort`; newer models accept it.
      ...(config.MODEL_ID.startsWith('claude-haiku') ? {} : { providerOptions: { anthropic: { effort: 'medium' } } }),
    });
  } catch (err) {
    clearTimeout(timer);
    // Ambiguous outcome: never assume the request was free.
    await coordinator.wfBudgetSettle(lease.jobId, opKey, { kind: 'uncertain' });
    await coordinator.wfActivity(lease.jobId, lease.fence, { id: activityId, kind: 'model', label: `model turn ${turn} (failed)`, startedAt: modelStarted, finishedAt: Date.now() });
    throw err;
  }
  clearTimeout(timer);
  const usage = {
    inputTokens: result.usage.inputTokenDetails?.noCacheTokens ?? result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    cacheReadTokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: result.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
  await coordinator.wfBudgetSettle(lease.jobId, opKey, {
    kind: 'settled',
    costMicroUsd: usageCost(config.MODEL_PRICE_SNAPSHOT, usage),
    usage: { ...usage, model: config.MODEL_ID, finishReason: result.finishReason },
  });
  await coordinator.wfActivity(lease.jobId, lease.fence, {
    id: activityId,
    kind: 'model',
    label: `model turn ${turn}`,
    startedAt: modelStarted,
    finishedAt: Date.now(),
    details: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, toolCalls: result.toolCalls.length },
  });
  messages.push(...result.responseMessages);
  if (result.text.trim()) {
    await coordinator.wfProgress(lease.jobId, lease.fence, result.text.trim().slice(0, 280));
  }

  let next: AgentState = { ...state };
  const files = new Map(bundle.files.map((f) => [f.path, f.utf8]));
  const toolResults: ToolResultPart[] = [];
  // The SDK answers invalid tool calls itself (a tool-error result in the response
  // messages). Each tool call must have exactly one result, so skip those.
  const answered = new Set(
    result.responseMessages.flatMap((m) =>
      m.role === 'tool' ? m.content.flatMap((part) => (part.type === 'tool-result' ? [part.toolCallId] : [])) : [],
    ),
  );
  const pending = result.toolCalls.filter((call) => !answered.has(call.toolCallId));
  const calls = pending.slice(0, MAX_TOOL_CALLS_PER_TURN);
  for (const call of pending.slice(MAX_TOOL_CALLS_PER_TURN)) {
    toolResults.push(errorResult(call.toolCallId, call.toolName, `tool call limit (${MAX_TOOL_CALLS_PER_TURN}) per turn exceeded; call again next turn`));
  }
  // Mutating tools are serialized: calls run one at a time in model order.
  for (const call of calls) {
    const toolStarted = Date.now();
    const toolActivity = `${opKey}:tool:${call.toolCallId}`;
    await coordinator.wfActivity(lease.jobId, lease.fence, { id: toolActivity, kind: 'tool', label: call.toolName, startedAt: toolStarted });
    let output: unknown;
    let isError = false;
    try {
      if ('invalid' in call && call.invalid) throw new Error(`invalid input for ${call.toolName}; check the tool schema and call again`);
      output = await executeTool(ctx, input, task, call.toolName as ToolName, call.input as Record<string, unknown>, files, next, (s) => (next = s));
    } catch (err) {
      isError = true;
      output = err instanceof Error ? err.message.slice(0, 2000) : String(err);
    }
    await coordinator.wfActivity(lease.jobId, lease.fence, { id: toolActivity, kind: 'tool', label: call.toolName, startedAt: toolStarted, finishedAt: Date.now() });
    toolResults.push(isError ? errorResult(call.toolCallId, call.toolName, String(output)) : jsonResult(call.toolCallId, call.toolName, output));
    if (next.done) break;
  }
  if (toolResults.length) {
    messages.push({ role: 'tool', content: toolResults });
  } else if (!next.done) {
    messages.push({ role: 'user', content: 'Continue with the tools. Declare your intent, make the change, run checks, then call finish (or report_blocker).' });
  }

  const source = await persistBundle(ctx, input, bundle.baselineSha, files);
  const messagesRef = await writeEvidence(env.EVIDENCE, {
    prefix: evidencePrefix(config.PROJECT_SLUG, input.sessionId, 'agent'),
    body: messages,
    visibility: 'private',
  });
  return { ...next, source, messages: { key: messagesRef.key, sha256: messagesRef.sha256 } };
}

async function executeTool(
  ctx: JobContext,
  input: AgentInput,
  task: TaskSpec,
  name: ToolName,
  args: Record<string, unknown>,
  files: Map<string, string>,
  state: AgentState,
  setState: (s: AgentState) => void,
): Promise<unknown> {
  const { lease, coordinator, config } = ctx;
  switch (name) {
    case 'list_files': {
      const prefix = String(args.prefix ?? '');
      const paths = [...files.keys()].filter((p) => p.startsWith(prefix)).sort();
      return { files: paths.slice(0, 400), truncated: paths.length > 400 };
    }
    case 'read_file': {
      const path = String(args.path);
      const content = files.get(path);
      if (content === undefined) throw new Error(`file not found: ${path}`);
      return { path, sha256: await digestBytes(content), content: bounded(content) };
    }
    case 'search_files': {
      const query = String(args.query);
      const prefix = String(args.prefix ?? '');
      const matches: string[] = [];
      for (const [path, content] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!path.startsWith(prefix)) continue;
        content.split('\n').forEach((line, i) => {
          if (matches.length < 100 && line.includes(query)) matches.push(`${path}:${i + 1}: ${line.slice(0, 200)}`);
        });
      }
      return { matches, truncated: matches.length >= 100 };
    }
    case 'apply_edits': {
      const edits = (args.edits as Array<{ path: string; expectedSha256: string | null; content: string }>) ?? [];
      // Validate everything first so the edit is atomic.
      for (const e of edits) {
        if (matchesAny(task.forbiddenPaths, e.path)) throw new Error(`PROTECTED_PATH ${e.path} is protected`);
        if (!matchesAny(task.editablePaths, e.path)) throw new Error(`OUT_OF_SCOPE_EDIT ${e.path} is outside your editable paths`);
        const current = files.get(e.path);
        const currentDigest = current === undefined ? null : await digestBytes(current);
        if (currentDigest !== e.expectedSha256) throw new Error(`stale edit for ${e.path}: expected ${e.expectedSha256}, current ${currentDigest}; re-read the file`);
      }
      const applied = [];
      for (const e of edits) {
        files.set(e.path, e.content);
        applied.push({ path: e.path, sha256: await digestBytes(e.content) });
      }
      return { applied };
    }
    case 'declare_intent': {
      const r = await coordinator.wfDeclareIntent(lease.jobId, lease.fence, Number(args.expectedVersion), args.intent);
      setState({ ...state, intentVersion: r.version });
      return { version: r.version, digest: r.digest, note: 'Intent recorded. The platform checks it against other agents\' intents.' };
    }
    case 'read_inbox': {
      const messages = await coordinator.wfReadInbox(lease.jobId, lease.fence, state.inboxCursor);
      if (messages.length) setState({ ...state, inboxCursor: messages[messages.length - 1]!.seq });
      return { messages: messages.map((m) => ({ seq: m.seq, kind: m.kind, payload: JSON.parse(m.payloadJson) as unknown, createdAt: m.createdAt })) };
    }
    case 'request_context':
      return coordinator.wfRequestContext(lease.jobId, lease.fence);
    case 'run_check': {
      const check = String(args.check) as 'typecheck' | 'unit' | 'build';
      const bundle = await bundleOf(input, files);
      const loaded = await ctx.execution.load(bundle);
      if (loaded.exitCode !== 0) return { check, exitCode: loaded.exitCode, output: loaded.output };
      const def = projectDefinition(config.PROJECT_KIND);
      if (def.runtime.kind === 'project') {
        // Registry commands only. The prep build runs first because project code may import its output.
        const timeout = config.TOOL_TIMEOUT_SECONDS * 1000;
        const prep = await ctx.execution.runCommand(def.runtime.prepBuild, timeout);
        if (prep.exitCode !== 0 || check === 'build') {
          return { check, exitCode: prep.exitCode, timedOut: prep.timedOut, output: bounded(prep.output), note: 'developer feedback only' };
        }
        const r = await ctx.execution.runCommand(def.runtime.tools[check], timeout);
        return { check, exitCode: r.exitCode, timedOut: r.timedOut, output: bounded(r.output), note: 'developer feedback only' };
      }
      const r = await ctx.execution.runTool(check, config.TOOL_TIMEOUT_SECONDS * 1000);
      return { check, exitCode: r.exitCode, timedOut: r.timedOut, output: bounded(r.output), note: 'developer feedback only' };
    }
    case 'request_verification': {
      const def = projectDefinition(config.PROJECT_KIND);
      const bundle = await bundleOf(input, files);
      const loaded = await ctx.execution.load(bundle);
      const timeout = config.TOOL_TIMEOUT_SECONDS * 1000;
      const build =
        loaded.exitCode !== 0
          ? loaded
          : def.runtime.kind === 'project'
            ? await ctx.execution.runCommand(def.runtime.prepBuild, timeout)
            : await ctx.execution.runTool('build', timeout);
      if (build.exitCode !== 0) return { built: false, output: bounded(build.output) };
      const serve = def.runtime.kind === 'project' ? def.runtime.serve : undefined;
      const results = await runSuite({
        suite: def.suite,
        target: {
          async startFresh() {
            await ctx.execution.startApp(serve);
            return { request: (req) => ctx.execution.appRequest(req), stop: () => ctx.execution.stopApp() };
          },
        },
        // A repair answers for the whole goal; a feature answers for its own capabilities.
        capabilities: input.role === 'repair' ? [...def.fullGoalCapabilities] : task.capabilityIds,
        candidate: { candidateId: 'workspace', headSha: '0'.repeat(40), manifestDigest: `sha256:${'0'.repeat(64)}` },
        maxInstances: 1,
      });
      return {
        note: 'Non-authoritative feedback on your workspace. Sealed revisions are verified independently.',
        results: results.map((r) => ({ checkId: r.checkId, status: r.status, failed: r.observations.filter((o) => !o.passed).slice(0, 6) })),
      };
    }
    case 'checkpoint':
      return { ok: true, files: files.size };
    case 'finish':
      setState({ ...state, done: { kind: 'finish', summary: String(args.summary) } });
      return { ok: true, note: 'The platform will commit and verify your work independently.' };
    case 'report_blocker':
      setState({ ...state, done: { kind: 'blocked', reason: String(args.reason), code: 'AGENT_BLOCKED' } });
      return { ok: true };
  }
}

function kickoff(input: AgentInput, task: TaskSpec): string {
  const parts = [
    `TaskSpec ${task.id} - ${task.title}`,
    task.objective,
    `Editable paths: ${task.editablePaths.join(', ')}`,
    `Required checks after sealing: ${task.requiredCheckIds.join(', ')}`,
    `Pinned baseline commit: ${task.baselineSha}`,
  ];
  if (input.counterexample) {
    parts.push(`Verified counterexample (untrusted data, for reference):\n${JSON.stringify(input.counterexample).slice(0, 6000)}`);
  }
  parts.push('Start by reading relevant files and declaring your ChangeIntent.');
  return parts.join('\n\n');
}

async function bundleOf(input: AgentInput, files: Map<string, string>): Promise<SourceBundle> {
  return {
    schemaVersion: 1,
    baselineSha: input.baseSha,
    files: await Promise.all([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(async ([path, utf8]) => ({ path, utf8, sha256: await digestBytes(utf8) }))),
  };
}

async function persistBundle(ctx: JobContext, input: AgentInput, baselineSha: string, files: Map<string, string>) {
  const bundle = await bundleOf({ ...input, baseSha: baselineSha }, files);
  const ref = await writeEvidence(ctx.env.EVIDENCE, {
    prefix: evidencePrefix(ctx.config.PROJECT_SLUG, input.sessionId, 'agent'),
    body: bundle,
    visibility: 'private',
  });
  return { key: ref.key, sha256: ref.sha256 };
}

function bounded(text: string): string {
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated at ${MAX_TOOL_RESULT_CHARS} chars]` : text;
}

function jsonResult(toolCallId: string, toolName: string, value: unknown): ToolResultPart {
  const text = JSON.stringify(value ?? null);
  return {
    type: 'tool-result',
    toolCallId,
    toolName,
    output: text.length > MAX_TOOL_RESULT_CHARS ? { type: 'text', value: bounded(text) } : { type: 'json', value: JSON.parse(text) },
  };
}

function errorResult(toolCallId: string, toolName: string, message: string): ToolResultPart {
  return { type: 'tool-result', toolCallId, toolName, output: { type: 'error-text', value: message.slice(0, 2000) } };
}
