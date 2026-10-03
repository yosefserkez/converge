// Wire contract for the trusted Git broker. Shared by the broker HTTP server
// and the Worker-side client, so both validate the same shapes.
import { z } from 'zod';
import { GitOid, PathPattern, RepoPath, SourceBundle } from '@converge/domain';
import { isValidBranch } from './paths.ts';

/** Remote URL. The allowlist is enforced by the broker, since it depends on test vs production mode. */
export const RemoteUrl = z.string().min(1).max(512);

/** Repo-scoped bearer token. Visible ASCII only, so it cannot inject header lines. */
export const RepoToken = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/, 'invalid token');

export const BranchName = z.string().refine(isValidBranch, 'invalid branch name');

/** Caller-supplied commit time in epoch seconds; fixed dates make retries reproduce the same SHA. */
export const EpochSeconds = z.number().int().min(0).max(253_402_300_799);

export const CommitMessage = z.string().min(1).max(4000).refine((m) => !m.includes('\0'), 'NUL in message');

export const MergeLabel = z.string().regex(/^[A-Za-z0-9 ._:+#()-]{1,80}$/, 'invalid label');

const Utf8Content = z.string().max(1024 * 1024);

const RemoteAuth = z.object({ remote: RemoteUrl, token: RepoToken });

// ---------- seedBaseline ----------

export const SeedBaselineInput = z.object({
  remote: RemoteUrl,
  token: RepoToken,
  branch: BranchName.default('main'),
  files: z.array(z.object({ path: RepoPath, utf8: Utf8Content })).min(1).max(2000),
  message: CommitMessage,
  timestamp: EpochSeconds,
});
export type SeedBaselineInput = z.input<typeof SeedBaselineInput>;

export const SeedBaselineOutput = z.object({
  headSha: GitOid,
  treeSha: GitOid,
  /** False when the branch already held the same tree (idempotent reconcile). */
  created: z.boolean(),
});
export type SeedBaselineOutput = z.infer<typeof SeedBaselineOutput>;

// ---------- readHead ----------

export const ReadHeadInput = z.object({ remote: RemoteUrl, token: RepoToken, branch: BranchName });
export type ReadHeadInput = z.input<typeof ReadHeadInput>;

export const ReadHeadOutput = z.object({ sha: GitOid.nullable() });
export type ReadHeadOutput = z.infer<typeof ReadHeadOutput>;

// ---------- materialize ----------

export const MaterializeInput = z.object({
  remote: RemoteUrl,
  token: RepoToken,
  sha: GitOid,
  maxFileBytes: z.number().int().positive().max(1024 * 1024).default(256 * 1024),
  maxTotalBytes: z.number().int().positive().max(16 * 1024 * 1024).default(5 * 1024 * 1024),
});
export type MaterializeInput = z.input<typeof MaterializeInput>;

export const MaterializeOutput = SourceBundle;
export type MaterializeOutput = z.infer<typeof MaterializeOutput>;

// ---------- commitEdits ----------

export const FileEdit = z.object({
  /** Validated by the broker so scope violations get their specific error codes. */
  path: z.string().min(1).max(4096),
  /** null deletes the file. */
  utf8: Utf8Content.nullable(),
});
export type FileEdit = z.infer<typeof FileEdit>;

export const CommitEditsInput = z.object({
  remote: RemoteUrl,
  token: RepoToken,
  baseSha: GitOid,
  branch: BranchName,
  files: z.array(FileEdit).min(1).max(256),
  editablePaths: z.array(PathPattern).min(1).max(64),
  protectedPaths: z.array(PathPattern).max(128),
  message: CommitMessage,
  timestamp: EpochSeconds,
  sourceRemote: RemoteUrl.optional(),
  sourceToken: RepoToken.optional(),
});
export type CommitEditsInput = z.input<typeof CommitEditsInput>;

export const CommitEditsOutput = z.object({
  headSha: GitOid,
  treeSha: GitOid,
  changedPaths: z.array(z.string()),
  diff: z.string(),
  diffTruncated: z.boolean(),
  /** False when the branch already pointed to the identical commit. */
  pushed: z.boolean(),
});
export type CommitEditsOutput = z.infer<typeof CommitEditsOutput>;

// ---------- assemble ----------

export const AssembleInput = z.object({
  target: RemoteAuth.extend({ branch: BranchName }),
  start: RemoteAuth.extend({ sha: GitOid }),
  merges: z.array(RemoteAuth.extend({ sha: GitOid, label: MergeLabel })).max(32),
  message: CommitMessage,
  timestamp: EpochSeconds,
});
export type AssembleInput = z.input<typeof AssembleInput>;

export const MergeStep = z.object({ label: MergeLabel, sha: GitOid, commitSha: GitOid, parents: z.array(GitOid) });

export const AssembleOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('merged'),
    headSha: GitOid,
    treeSha: GitOid,
    parents: z.array(GitOid),
    startSha: GitOid,
    steps: z.array(MergeStep),
    alreadyIncluded: z.array(MergeLabel),
    pushed: z.boolean(),
  }),
  z.object({
    status: z.literal('text_conflict'),
    atMerge: MergeLabel,
    conflictedPaths: z.array(z.string()),
    alreadyIncluded: z.array(MergeLabel),
  }),
]);
export type AssembleOutput = z.infer<typeof AssembleOutput>;

// ---------- promote ----------

export const PromoteInput = z.object({
  canonical: RemoteAuth,
  source: RemoteAuth,
  candidateSha: GitOid,
  expectedMainSha: GitOid,
});
export type PromoteInput = z.input<typeof PromoteInput>;

export const PromoteOutput = z.object({
  state: z.enum(['succeeded', 'stale', 'failed']),
  observedRemoteSha: GitOid.nullable(),
  /** True when canonical main already equalled the candidate, so nothing was pushed. */
  reconciled: z.boolean(),
  pushed: z.boolean(),
});
export type PromoteOutput = z.infer<typeof PromoteOutput>;

// ---------- registry ----------

export const brokerOps = {
  seedBaseline: { input: SeedBaselineInput, output: SeedBaselineOutput },
  readHead: { input: ReadHeadInput, output: ReadHeadOutput },
  materialize: { input: MaterializeInput, output: MaterializeOutput },
  commitEdits: { input: CommitEditsInput, output: CommitEditsOutput },
  assemble: { input: AssembleInput, output: AssembleOutput },
  promote: { input: PromoteInput, output: PromoteOutput },
} as const;

export type BrokerOpName = keyof typeof brokerOps;
export const BROKER_OP_NAMES = Object.keys(brokerOps) as BrokerOpName[];

export function isBrokerOpName(name: string): name is BrokerOpName {
  return Object.hasOwn(brokerOps, name);
}

export type BrokerOpInput<N extends BrokerOpName> = z.input<(typeof brokerOps)[N]['input']>;
export type BrokerOpOutput<N extends BrokerOpName> = z.infer<(typeof brokerOps)[N]['output']>;

export const BrokerErrorBody = z.object({ code: z.string(), message: z.string() });

export const BrokerResponse = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: BrokerErrorBody }),
]);
export type BrokerResponse = z.infer<typeof BrokerResponse>;
