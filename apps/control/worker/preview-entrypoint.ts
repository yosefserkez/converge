import { WorkerEntrypoint } from 'cloudflare:workers';
import { DomainError, PreviewCapability, type SourceBundle } from '@converge/domain';
import { loadConfig } from './config.ts';
import { verifyCapability } from './capability.ts';
import { readVerifiedText } from './evidence.ts';
import { ArtifactsRepoHost } from './artifacts.ts';

/**
 * The only control-plane surface the public gateway can reach (service binding,
 * named entrypoint). It resolves already-authorized previews and published
 * replays. It cannot create sessions, call models, approve, promote, or start
 * a preview the operator did not allocate.
 */
export class PreviewEntrypoint extends WorkerEntrypoint<Env> {
  async getReplay(replayId: string): Promise<{ ok: true; json: string; mode: string } | { ok: false }> {
    if (!/^rpl_[a-z0-9]{26}$/.test(replayId)) return { ok: false };
    const config = loadConfig(this.env);
    const row = await this.env.PROJECTS.getByName(config.PROJECT_SLUG).getPublishedReplay(replayId);
    if (!row || !row.snapshot_key.startsWith('public/replays/')) return { ok: false };
    const json = await readVerifiedText(this.env.EVIDENCE, row.snapshot_key, row.snapshot_digest);
    return { ok: true, json, mode: row.original_mode };
  }

  /**
   * Forward one validated request to the exact candidate's isolated preview.
   * Starts the candidate app only on the first request of an allocated,
   * unexpired preview; never extends its absolute lifetime.
   */
  async previewRequest(token: string, method: string, path: string, query: string, body: string | null, customer: string | null): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const config = loadConfig(this.env);
    let cap: PreviewCapability;
    try {
      cap = PreviewCapability.parse(await verifyCapability(this.env.PREVIEW_SIGNING_KEY, token));
    } catch {
      return { status: 403, headers: {}, body: 'invalid preview capability' };
    }
    if (cap.projectId !== config.PROJECT_SLUG) return { status: 403, headers: {}, body: 'invalid preview capability' };
    if (cap.expiresAt < Date.now()) return { status: 410, headers: {}, body: 'preview expired' };
    const coordinator = this.env.PROJECTS.getByName(config.PROJECT_SLUG);
    const resolved = await coordinator.resolvePreview(cap.resourceId, cap.nonce, cap.candidateId, cap.headSha);
    if (!resolved || resolved.expiresAt < Date.now() || resolved.state === 'expired' || resolved.state === 'error') {
      return { status: 410, headers: {}, body: 'preview expired or unavailable' };
    }
    const exec = this.env.EXECUTION.getByName(resolved.resourceId);
    if (resolved.state === 'starting') {
      try {
        const bundle = await this.materialize(resolved.repoName, resolved.headSha);
        const loaded = await exec.load(bundle);
        const built = loaded.exitCode === 0 ? await exec.runTool('build') : loaded;
        if (built.exitCode !== 0) throw new DomainError('INTERNAL', 'preview build failed');
        await exec.startApp();
        await coordinator.markPreview(resolved.resourceId, 'active');
      } catch {
        await coordinator.markPreview(resolved.resourceId, 'error');
        await exec.destroyContainer('preview failed').catch(() => undefined);
        return { status: 503, headers: {}, body: 'preview could not start' };
      }
    }
    const res = await exec.appRequest({
      method: method === 'POST' ? 'POST' : 'GET',
      path: `${path}${query}`,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        'x-demo-customer': customer === 'member-1' ? 'member-1' : 'regular-1',
      },
      ...(body !== null ? { body } : {}),
    });
    return { status: res.status, headers: res.headers, body: res.bodyText };
  }

  private async materialize(repoName: string, sha: string): Promise<SourceBundle> {
    const repos = new ArtifactsRepoHost(this.env.ARTIFACTS);
    const broker = this.env.GIT_BROKER.getByName(`broker-${loadConfig(this.env).PROJECT_SLUG}`);
    return repos.withTokens([{ name: repoName, scope: 'read' }], (creds) => {
      const c = creds.get(repoName)!;
      return broker.materialize({ remote: c.remote, token: c.token, sha });
    });
  }
}
