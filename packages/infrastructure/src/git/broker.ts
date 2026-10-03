import { tmpdir } from 'node:os';
import path from 'node:path';
import { DomainError, ErrorCode } from '@converge/domain';
import { z } from 'zod';
import { assemble } from './assemble.ts';
import { commitEdits } from './commit-edits.ts';
import { materialize } from './materialize.ts';
import { brokerOps, isBrokerOpName, type BrokerOpInput, type BrokerOpName, type BrokerOpOutput } from './ops.ts';
import { promote } from './promote.ts';
import { Redactor } from './redact.ts';
import { readHead, seedBaseline } from './seed.ts';
import { withWorkspace, type OpWorkspace, type WorkspaceOptions } from './workspace.ts';

export interface GitBrokerOptions {
  /** Parent directory for per-operation temp dirs. Defaults to the OS temp dir. */
  readonly workRoot?: string;
  /** Per-git-command timeout. */
  readonly commandTimeoutMs?: number;
  /**
   * TEST ONLY. Absolute directory; enables `file://` remotes beneath it and
   * `protocol.file.allow=always`. Never set in production.
   */
  readonly testFileRemoteRoot?: string;
  /** Receives one redacted line per operation. */
  readonly log?: (line: string) => void;
}

export interface BrokerErrorBody {
  readonly code: string;
  readonly message: string;
}

export type DispatchResult = { ok: true; result: unknown } | { ok: false; error: BrokerErrorBody };

type Handler<N extends BrokerOpName> = (ws: OpWorkspace, input: z.output<(typeof brokerOps)[N]['input']>) => Promise<BrokerOpOutput<N>>;

const handlers: { [N in BrokerOpName]: Handler<N> } = {
  seedBaseline,
  readHead,
  materialize,
  commitEdits,
  assemble,
  promote,
};

export class GitBroker {
  readonly #ws: WorkspaceOptions;
  readonly #log: (line: string) => void;

  constructor(opts: GitBrokerOptions = {}) {
    if (opts.testFileRemoteRoot !== undefined && !path.isAbsolute(opts.testFileRemoteRoot)) {
      throw new Error('testFileRemoteRoot must be absolute');
    }
    this.#ws = {
      workRoot: opts.workRoot ?? tmpdir(),
      timeoutMs: opts.commandTimeoutMs,
      fileRemoteRoot: opts.testFileRemoteRoot,
    };
    this.#log = opts.log ?? (() => {});
  }

  /** Typed entry point. Throws DomainError on failure; messages are already redacted. */
  async run<N extends BrokerOpName>(name: N, input: BrokerOpInput<N>): Promise<BrokerOpOutput<N>> {
    const res = await this.dispatch(name, input);
    if (!res.ok) throw new DomainError(res.error.code as keyof typeof ErrorCode, res.error.message);
    return res.result as BrokerOpOutput<N>;
  }

  seedBaseline(input: BrokerOpInput<'seedBaseline'>) { return this.run('seedBaseline', input); }
  readHead(input: BrokerOpInput<'readHead'>) { return this.run('readHead', input); }
  materialize(input: BrokerOpInput<'materialize'>) { return this.run('materialize', input); }
  commitEdits(input: BrokerOpInput<'commitEdits'>) { return this.run('commitEdits', input); }
  assemble(input: BrokerOpInput<'assemble'>) { return this.run('assemble', input); }
  promote(input: BrokerOpInput<'promote'>) { return this.run('promote', input); }

  /**
   * Untyped entry point used by the HTTP server: validates input, runs the
   * op in a fresh workspace, and returns a redacted envelope. Never throws.
   */
  async dispatch(name: string, rawInput: unknown): Promise<DispatchResult> {
    const started = Date.now();
    const redactor = new Redactor(collectTokens(rawInput));
    let outcome: DispatchResult;
    if (!isBrokerOpName(name)) {
      outcome = { ok: false, error: { code: 'NOT_FOUND', message: 'unknown operation' } };
    } else {
      outcome = await this.#execute(name, rawInput, redactor);
    }
    const status = outcome.ok ? 'ok' : `error:${outcome.error.code}`;
    const opName = isBrokerOpName(name) ? name : 'unknown';
    this.#log(redactor.redact(`git-broker op=${opName} outcome=${status} durationMs=${Date.now() - started}`));
    return outcome;
  }

  async #execute<N extends BrokerOpName>(name: N, rawInput: unknown, redactor: Redactor): Promise<DispatchResult> {
    try {
      const input = brokerOps[name].input.parse(rawInput) as z.output<(typeof brokerOps)[N]['input']>;
      const handler = handlers[name] as Handler<N>;
      const result = await withWorkspace(this.#ws, (ws) => handler(ws, input));
      return { ok: true, result: brokerOps[name].output.parse(result) };
    } catch (err) {
      return { ok: false, error: toErrorBody(err, redactor) };
    }
  }
}

/** HTTP status for a broker error code (domain mapping, 500 for unknown codes). */
export function errorStatus(code: string): number {
  return Object.hasOwn(ErrorCode, code) ? ErrorCode[code as keyof typeof ErrorCode] : 500;
}

function toErrorBody(err: unknown, redactor: Redactor): BrokerErrorBody {
  if (err instanceof DomainError) return { code: err.code, message: redactor.redact(err.message) };
  if (err instanceof z.ZodError) {
    const issues = err.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { code: 'INVALID_INPUT', message: redactor.redact(`invalid input: ${issues.join('; ')}`) };
  }
  return { code: 'INTERNAL', message: 'internal broker error' };
}

/** Finds every `token`/`sourceToken` string in an untrusted body so it can be redacted. */
function collectTokens(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || value === null || typeof value !== 'object') return out;
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string' && /token$/i.test(key)) out.push(v);
    else collectTokens(v, out, depth + 1);
  }
  return out;
}
