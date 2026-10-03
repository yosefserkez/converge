// Node-only AppTarget for local tests and development. Not imported by index.ts.
// Runs `node dist/server.mjs` from a built storefront directory.
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readBoundedText } from './bounded.ts';
import type { AppInstance, AppRequest, AppResponse, AppTarget } from './types.ts';

export interface LocalProcessTargetOptions {
  /** Built storefront directory that contains dist/server.mjs. */
  dir: string;
  /** Readiness attempts against /healthz. Default 50. */
  readyAttempts?: number;
  /** Delay between readiness attempts in milliseconds. Default 100. */
  readyIntervalMs?: number;
  /** Per-request timeout in milliseconds. Default 10000. */
  requestTimeoutMs?: number;
}

const MAX_LOG_CHARS = 32 * 1024;

class EarlyExitError extends Error {}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    // The storefront binds 0.0.0.0, so probe the same address.
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class LocalProcessInstance implements AppInstance {
  #log = '';
  #exited = false;

  readonly port: number;
  readonly #child: ChildProcess;
  readonly #requestTimeoutMs: number;

  constructor(child: ChildProcess, port: number, requestTimeoutMs: number) {
    this.#child = child;
    this.port = port;
    this.#requestTimeoutMs = requestTimeoutMs;
    const append = (chunk: Buffer) => {
      if (this.#log.length < MAX_LOG_CHARS) this.#log += chunk.toString('utf8').slice(0, MAX_LOG_CHARS - this.#log.length);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('exit', () => {
      this.#exited = true;
    });
  }

  /** Supplemental bounded stdout/stderr. Never used to decide a check. */
  get log(): string {
    return this.#log;
  }

  get exited(): boolean {
    return this.#exited;
  }

  async request(req: AppRequest): Promise<AppResponse> {
    const res = await fetch(`http://127.0.0.1:${this.port}${req.path}`, {
      method: req.method,
      headers: req.headers ?? {},
      ...(req.body === undefined ? {} : { body: req.body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: res.status, headers, bodyText: await readBoundedText(res.body) };
  }

  async stop(): Promise<void> {
    if (this.#exited || this.#child.pid === undefined) return;
    const exited = once(this.#child, 'exit').catch(() => undefined);
    this.#signal('SIGTERM');
    const timedOut = await Promise.race([exited.then(() => false), sleep(2000).then(() => true)]);
    if (timedOut && !this.#exited) {
      this.#signal('SIGKILL');
      await exited;
    }
  }

  #signal(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.#child.kill(signal);
      } catch {
        // already gone
      }
    }
  }
}

export class LocalProcessTarget implements AppTarget {
  readonly #options: LocalProcessTargetOptions;

  constructor(options: LocalProcessTargetOptions) {
    this.#options = options;
  }

  /** Retries with a new port when the process exits early (e.g. a port race). */
  async startFresh(): Promise<LocalProcessInstance> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.#startOnce();
      } catch (err) {
        lastError = err;
        if (!(err instanceof EarlyExitError)) throw err;
      }
    }
    throw lastError;
  }

  async #startOnce(): Promise<LocalProcessInstance> {
    const port = await freePort();
    const child = spawn(process.execPath, ['dist/server.mjs'], {
      cwd: this.#options.dir,
      env: { PATH: process.env.PATH ?? '', PORT: String(port), NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const instance = new LocalProcessInstance(child, port, this.#options.requestTimeoutMs ?? 10_000);
    const attempts = this.#options.readyAttempts ?? 50;
    const interval = this.#options.readyIntervalMs ?? 100;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (instance.exited) break;
      try {
        const res = await instance.request({ method: 'GET', path: '/healthz' });
        if (res.status === 200) return instance;
      } catch {
        // not listening yet
      }
      await sleep(interval);
    }
    const exitedEarly = instance.exited;
    await instance.stop();
    const message = `candidate did not become ready on port ${port}: ${instance.log.slice(-2000)}`;
    throw exitedEarly ? new EarlyExitError(message) : new Error(message);
  }
}
