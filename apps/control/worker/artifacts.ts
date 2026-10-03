import { DomainError, RepoName } from '@converge/domain';

export interface RepoInfo {
  name: string;
  remote: string;
}

export interface RepoToken {
  id: string;
  plaintext: string;
  expiresAt: number;
}

/** Narrow, typed adapter over the Artifacts binding. Never persists or returns bootstrap credentials. */
export class ArtifactsRepoHost {
  constructor(private readonly artifacts: Artifacts) {}

  /** Create the repo, or reconcile an existing one with the same deterministic name. */
  async ensureRepo(name: string, description: string): Promise<RepoInfo> {
    RepoName.parse(name);
    const existing = await this.tryInfo(name);
    if (existing) return existing;
    try {
      const created = await this.artifacts.create(name, { description, readOnly: false, setDefaultBranch: 'main' });
      // The create result carries a bootstrap token; revoke it immediately.
      await this.revoke(name, created.token).catch(() => undefined);
      return { name: created.name, remote: created.remote };
    } catch (err) {
      const reconciled = await this.waitReady(name, 3);
      if (reconciled) return reconciled;
      throw new DomainError('DEPENDENCY_UNAVAILABLE', `could not create repository ${name}`, { cause: errorMessage(err) });
    }
  }

  /** Fork `source` into `name`, or reconcile an existing fork; waits for readiness with bounded retries. */
  async ensureFork(source: string, name: string, description: string): Promise<RepoInfo> {
    RepoName.parse(name);
    const existing = await this.tryInfo(name);
    if (existing) return existing;
    try {
      using repo = await this.artifacts.get(source);
      const forked = await repo.fork(name, { description, readOnly: false, defaultBranchOnly: true });
      await this.revoke(name, forked.token).catch(() => undefined);
    } catch (err) {
      // A concurrent or retried fork may already be in progress.
      if (!(await this.listed(name))) {
        throw new DomainError('DEPENDENCY_UNAVAILABLE', `could not fork ${source} to ${name}`, { cause: errorMessage(err) });
      }
    }
    const ready = await this.waitReady(name, 20);
    if (!ready) throw new DomainError('REPO_NOT_READY', `fork ${name} is not ready yet`);
    return ready;
  }

  async mintToken(name: string, scope: 'read' | 'write', ttlSeconds: number): Promise<RepoToken> {
    using repo = await this.artifacts.get(name);
    const t = await repo.createToken(scope, ttlSeconds);
    return { id: t.id, plaintext: t.plaintext, expiresAt: Date.parse(t.expiresAt) };
  }

  async revoke(name: string, tokenOrId: string): Promise<boolean> {
    using repo = await this.artifacts.get(name);
    return repo.revokeToken(tokenOrId);
  }

  async remoteOf(name: string): Promise<string> {
    const info = await this.tryInfo(name);
    if (!info) throw new DomainError('REPO_NOT_READY', `repository ${name} is not available`);
    return info.remote;
  }

  async readFile(name: string, ref: string, path: string): Promise<string | null> {
    using repo = await this.artifacts.get(name);
    const blob = await repo.readFile({ ref, path });
    return blob ? blob.text() : null;
  }

  async delete(name: string): Promise<boolean> {
    return this.artifacts.delete(name);
  }

  /**
   * Run `fn` with short-lived tokens for several repos, revoking them afterwards
   * whatever the outcome. Plaintext never leaves this call frame except to the broker.
   */
  async withTokens<T>(
    requests: ReadonlyArray<{ name: string; scope: 'read' | 'write' }>,
    fn: (creds: Map<string, { remote: string; token: string }>) => Promise<T>,
    ttlSeconds = 600,
  ): Promise<T> {
    const creds = new Map<string, { remote: string; token: string }>();
    const ids = new Map<string, string>();
    try {
      for (const r of requests) {
        if (creds.has(r.name)) continue;
        const [remote, token] = await Promise.all([this.remoteOf(r.name), this.mintToken(r.name, r.scope, ttlSeconds)]);
        creds.set(r.name, { remote, token: token.plaintext });
        ids.set(r.name, token.id);
      }
      return await fn(creds);
    } finally {
      await Promise.all([...ids].map(([name, id]) => this.revoke(name, id).catch(() => undefined)));
    }
  }

  private async tryInfo(name: string): Promise<RepoInfo | null> {
    try {
      using repo = await this.artifacts.get(name);
      const info = await repo.info();
      return { name: info.name, remote: info.remote };
    } catch {
      return null;
    }
  }

  private async listed(name: string): Promise<boolean> {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.artifacts.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      if (res.repos.some((r) => r.name === name)) return true;
      if (!res.cursor) return false;
      cursor = res.cursor;
    }
    return false;
  }

  private async waitReady(name: string, attempts: number): Promise<RepoInfo | null> {
    for (let i = 0; i < attempts; i++) {
      const info = await this.tryInfo(name);
      if (info) return info;
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** i, 4000)));
    }
    return null;
  }
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/art_v1_[0-9a-f]{40}\S*/g, '[redacted]').slice(0, 300);
}
