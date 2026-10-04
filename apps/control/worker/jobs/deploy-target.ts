import type { AppTarget } from '@converge/verification';

const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Harness target for a deployed Worker: each request goes to the public
 * deployment URL. Production cannot give a fresh process per sequence, so the
 * checks that run here must isolate themselves (for example, new pastes per check).
 */
export function deployedTarget(baseUrl: string): AppTarget {
  const origin = new URL(baseUrl).origin;
  return {
    async startFresh() {
      return {
        async request(req) {
          const r = req as typeof req & { bodyBase64?: string };
          let body: BodyInit | undefined;
          if (r.bodyBase64 !== undefined) body = Uint8Array.from(atob(r.bodyBase64), (ch) => ch.charCodeAt(0));
          else if (r.body !== undefined) body = r.body;
          const res = await fetch(`${origin}${req.path}`, {
            method: req.method,
            headers: { ...(req.headers ?? {}), 'User-Agent': 'converge-deploy-verify' },
            ...(body !== undefined ? { body } : {}),
            redirect: 'manual',
          });
          const buf = (req.method as string) === 'HEAD' ? new Uint8Array() : new Uint8Array(await res.arrayBuffer());
          const truncated = buf.byteLength > MAX_RESPONSE_BYTES;
          const text = new TextDecoder().decode(buf.subarray(0, MAX_RESPONSE_BYTES));
          return { status: res.status, headers: Object.fromEntries(res.headers), bodyText: truncated ? `${text}\n[output truncated]` : text };
        },
        async stop() {},
      };
    },
  };
}

/** Read the version header the setup commit adds; Workers Builds tags each deploy with its commit. */
export async function deployedVersion(baseUrl: string): Promise<string | null> {
  const res = await fetch(new URL('/', baseUrl), { method: 'HEAD', headers: { 'User-Agent': 'converge-deploy-verify' } });
  return res.headers.get('x-converge-version');
}
