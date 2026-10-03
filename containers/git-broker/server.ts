// Trusted Git broker HTTP server. Named operations only:
//   POST /op/<name>  JSON body validated by the op schema
//   GET  /healthz
// Bundled into containers/git-broker.Dockerfile with esbuild.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { GitBroker, errorStatus, type DispatchResult } from '../../packages/infrastructure/src/git/index.ts';

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
const OP_ROUTE = /^\/op\/([A-Za-z]{1,40})$/;
const AUTH_HEADER = 'x-converge-broker-auth';

export interface BrokerServerOptions {
  readonly maxBodyBytes?: number;
  /** When set, every /op request must carry this value in `x-converge-broker-auth`. */
  readonly sharedSecret?: string;
}

export function createBrokerServer(broker: GitBroker, opts: BrokerServerOptions = {}): Server {
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  return createServer((req, res) => {
    handle(broker, req, res, maxBody, opts.sharedSecret).catch(() => {
      if (!res.headersSent) send(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'internal broker error' } });
      else res.destroy();
    });
  });
}

async function handle(
  broker: GitBroker,
  req: IncomingMessage,
  res: ServerResponse,
  maxBody: number,
  secret: string | undefined,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://broker.invalid');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    send(res, 200, { ok: true });
    return;
  }
  const match = OP_ROUTE.exec(url.pathname);
  if (!match || url.search !== '') {
    send(res, 404, fail('NOT_FOUND', 'not found'));
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, fail('INVALID_INPUT', 'method not allowed'));
    return;
  }
  if (secret && !secretMatches(req.headers[AUTH_HEADER], secret)) {
    req.resume();
    send(res, 401, fail('UNAUTHENTICATED', 'missing or invalid broker credential'));
    return;
  }
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    req.resume();
    send(res, 415, fail('INVALID_INPUT', 'expected application/json'));
    return;
  }

  const body = await readBody(req, maxBody);
  if (body === 'too_large') {
    send(res, 413, fail('LIMIT_EXCEEDED', `body exceeds ${maxBody} bytes`));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    send(res, 400, fail('INVALID_INPUT', 'malformed JSON'));
    return;
  }

  const result = await broker.dispatch(match[1]!, parsed);
  send(res, result.ok ? 200 : errorStatus(result.error.code), result);
}

function readBody(req: IncomingMessage, max: number): Promise<string | 'too_large'> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > max) {
      req.resume();
      resolve('too_large');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? 'too_large' : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function secretMatches(header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function fail(code: string, message: string): DispatchResult {
  return { ok: false, error: { code, message } };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

function main(): void {
  const port = Number(process.env.PORT ?? 9000);
  const broker = new GitBroker({
    workRoot: process.env.BROKER_WORK_ROOT || undefined,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  const server = createBrokerServer(broker, { sharedSecret: process.env.BROKER_SHARED_SECRET || undefined });
  server.requestTimeout = 300_000;
  server.listen(port, () => process.stdout.write(`git-broker listening port=${port}\n`));
  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
