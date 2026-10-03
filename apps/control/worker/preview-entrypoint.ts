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
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export class PreviewEntrypoint extends WorkerEntrypoint<Env> {
  /**
   * Published replays are immutable, content-addressed R2 objects
   * (`public/replays/<id>/<sha256>.json`). Resolve them from R2 directly so a
   * replay stays readable after the operator switches to a fresh demo project.
   */
  async getReplay(replayId: string): Promise<{ ok: true; json: string; mode: string } | { ok: false }> {
    if (!/^rpl_[a-z0-9]{26}$/.test(replayId)) return { ok: false };
    const listed = await this.env.EVIDENCE.list({ prefix: `public/replays/${replayId}/`, limit: 2 });
    const obj = listed.objects.find((o) => /\/[0-9a-f]{64}\.json$/.test(o.key));
    if (!obj || listed.objects.length !== 1) return { ok: false };
    const digest = `sha256:${obj.key.slice(-69, -5)}`;
    const json = await readVerifiedText(this.env.EVIDENCE, obj.key, digest);
    const mode = (JSON.parse(json) as { originalMode?: string }).originalMode ?? 'unknown';
    return { ok: true, json, mode };
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
    const boot = async () => {
      const bundle = await this.materialize(resolved.repoName, resolved.headSha);
      const loaded = await exec.load(bundle);
      const built = loaded.exitCode === 0 ? await exec.runTool('build') : loaded;
      if (built.exitCode !== 0) throw new DomainError('INTERNAL', 'preview build failed');
      await exec.startApp();
      await coordinator.markPreview(resolved.resourceId, 'active');
    };
    const fail = async () => {
      await coordinator.markPreview(resolved.resourceId, 'error');
      await exec.destroyContainer('preview failed').catch(() => undefined);
      return { status: 503, headers: {}, body: 'preview could not start' };
    };
    if (resolved.state === 'starting') {
      try {
        await boot();
      } catch {
        return fail();
      }
    }
    const send = () =>
      exec.appRequest(
        {
          method: method === 'POST' ? 'POST' : 'GET',
          path: `${path}${query}`,
          headers: {
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            'x-demo-customer': customer === 'member-1' ? 'member-1' : 'regular-1',
          },
          ...(body !== null ? { body } : {}),
        },
        PREVIEW_MAX_BYTES,
      );
    let res: Awaited<ReturnType<typeof send>>;
    try {
      res = await send();
    } catch {
      // The container restarted (for example after a deploy). Rebuild it once within the same absolute expiry.
      try {
        await boot();
        res = await send();
      } catch {
        return fail();
      }
    }
    // A cut-off asset would break the page silently; say so instead.
    if (res.truncated) return { status: 502, headers: {}, body: 'preview response is larger than the preview limit' };
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
