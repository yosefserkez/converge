import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '@converge/domain';
import { buildGitEnv, runGit, type GitConfigEntry, type RunOptions, type RunResult } from './exec.ts';
import { Redactor } from './redact.ts';
import { assertAllowedRemote, type RemotePolicy } from './remote.ts';

export const BROKER_IDENTITY = { name: 'Converge Broker', email: 'broker@converge.invalid' } as const;

export interface WorkspaceOptions extends RemotePolicy {
  readonly workRoot: string;
  readonly timeoutMs?: number;
}

type GitCallOptions = Omit<RunOptions, 'env' | 'cwd' | 'redactor'> & {
  readonly extraEnv?: Readonly<Record<string, string>>;
};

/**
 * One fresh, private bare repository per operation. Every git call gets the
 * hardened config plus the auth header for each registered remote. The
 * directory is removed in `dispose()`.
 */
export class OpWorkspace {
  readonly redactor = new Redactor();
  readonly #remotes = new Map<string, string>();
  #fetchSeq = 0;

  private constructor(
    readonly dir: string,
    readonly gitDir: string,
    readonly home: string,
    private readonly opts: WorkspaceOptions,
  ) {}

  static async create(opts: WorkspaceOptions): Promise<OpWorkspace> {
    const dir = await mkdtemp(path.join(opts.workRoot, 'converge-git-'));
    const ws = new OpWorkspace(dir, path.join(dir, 'repo.git'), path.join(dir, 'home'), opts);
    try {
      await mkdir(ws.home, { mode: 0o700 });
      await ws.git(['init', '--bare', '--quiet', '--template=', ws.gitDir]);
    } catch (err) {
      await ws.dispose();
      throw err;
    }
    return ws;
  }

  /** Validates the remote against the allowlist and registers its token for auth and redaction. */
  addRemote(remote: string, token: string): void {
    assertAllowedRemote(remote, this.opts);
    this.redactor.add(token);
    const existing = this.#remotes.get(remote);
    if (existing !== undefined && existing !== token) {
      throw new DomainError('INVALID_INPUT', 'conflicting tokens supplied for the same remote');
    }
    this.#remotes.set(remote, token);
  }

  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  git(args: readonly string[], opts: GitCallOptions = {}): Promise<RunResult> {
    const { extraEnv, ...run } = opts;
    const env = buildGitEnv({ gitDir: this.gitDir, home: this.home, config: this.#config(), extra: extraEnv });
    return runGit(args, { timeoutMs: this.opts.timeoutMs, ...run, env, cwd: this.dir, redactor: this.redactor });
  }

  async gitText(args: readonly string[], opts: GitCallOptions = {}): Promise<string> {
    return (await this.git(args, opts)).stdout.toString('utf8');
  }

  nextFetchRef(): string {
    this.#fetchSeq += 1;
    return `refs/converge/fetch/${this.#fetchSeq}`;
  }

  #config(): GitConfigEntry[] {
    const entries: GitConfigEntry[] = [
      { key: 'core.hooksPath', value: '/dev/null' },
      { key: 'core.symlinks', value: 'false' },
      { key: 'core.fsmonitor', value: 'false' },
      { key: 'core.askPass', value: '' },
      { key: 'credential.helper', value: '' },
      { key: 'protocol.allow', value: 'never' },
      { key: 'protocol.https.allow', value: 'always' },
      { key: 'submodule.recurse', value: 'false' },
      { key: 'fetch.recurseSubmodules', value: 'false' },
      { key: 'fetch.fsckObjects', value: 'true' },
      { key: 'transfer.fsckObjects', value: 'true' },
      { key: 'receive.fsckObjects', value: 'true' },
      { key: 'http.followRedirects', value: 'false' },
      { key: 'gc.auto', value: '0' },
      { key: 'maintenance.auto', value: 'false' },
      { key: 'init.defaultBranch', value: 'main' },
      { key: 'merge.renormalize', value: 'false' },
      { key: 'merge.conflictStyle', value: 'merge' },
      { key: 'commit.gpgSign', value: 'false' },
      { key: 'push.gpgSign', value: 'false' },
    ];
    if (this.opts.fileRemoteRoot) entries.push({ key: 'protocol.file.allow', value: 'always' });
    for (const [remote, token] of this.#remotes) {
      entries.push({ key: `http.${remote}.extraHeader`, value: `Authorization: Bearer ${token}` });
    }
    return entries;
  }
}

export async function withWorkspace<T>(opts: WorkspaceOptions, fn: (ws: OpWorkspace) => Promise<T>): Promise<T> {
  const ws = await OpWorkspace.create(opts);
  try {
    return await fn(ws);
  } finally {
    await ws.dispose();
  }
}
