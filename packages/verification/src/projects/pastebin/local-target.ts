// Node-only AppTarget for local pastebin verification. Not imported by any index.
// Each fresh instance runs the project's serve command (wrangler dev) in a
// prepared workspace on a free port with a new --persist-to directory, so no
// KV or R2 state carries over between instances.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalProcessInstance } from '../../local-target.ts';
import type { AppInstance, AppRequest, AppResponse, AppTarget } from '../../types.ts';

export interface LocalWranglerTargetOptions {
  /** Prepared workspace: source, setup, patches, node_modules, and built dist/frontend. */
  dir: string;
  /** Serve argv from project.json, with {port} and {stateDir} placeholders. */
  serveArgv: readonly string[];
  /** Path that answers 200 when the app is ready. */
  readyPath: string;
  /** Readiness deadline in milliseconds. Default 90000. */
  readyTimeoutMs?: number;
  /** Per-request timeout in milliseconds. Default 15000. */
  requestTimeoutMs?: number;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One wrangler dev process. stop() kills its process group and removes its state directory. */
export class WranglerInstance implements AppInstance {
  readonly #process: LocalProcessInstance;
  readonly #stateDir: string;
  readonly #onStop: () => void;

  constructor(process: LocalProcessInstance, stateDir: string, onStop: () => void) {
    this.#process = process;
    this.#stateDir = stateDir;
    this.#onStop = onStop;
  }

  get port(): number {
    return this.#process.port;
  }

  get log(): string {
    return this.#process.log;
  }

  request(req: AppRequest): Promise<AppResponse> {
    return this.#process.request(req);
  }

  async stop(): Promise<void> {
    try {
      await this.#process.stop();
    } finally {
      this.#onStop();
      await rm(this.#stateDir, { recursive: true, force: true });
    }
  }
}

export class LocalWranglerTarget implements AppTarget {
  readonly #options: LocalWranglerTargetOptions;
  readonly #live = new Set<WranglerInstance>();

  constructor(options: LocalWranglerTargetOptions) {
    this.#options = options;
  }

  /** Number of instances that are still running. */
  get liveCount(): number {
    return this.#live.size;
  }

  async startFresh(): Promise<WranglerInstance> {
    const port = await freePort();
    const stateDir = await mkdtemp(join(tmpdir(), 'converge-pastebin-state-'));
    const argv = this.#options.serveArgv.map((arg) => arg.replaceAll('{port}', String(port)).replaceAll('{stateDir}', stateDir));
    const [command, ...args] = argv;
    if (command === undefined) throw new Error('serve argv is empty');
    const child = spawn(command, args, {
      cwd: this.#options.dir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        WRANGLER_SEND_METRICS: 'false',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const instance: WranglerInstance = new WranglerInstance(
      new LocalProcessInstance(child, port, this.#options.requestTimeoutMs ?? 15_000),
      stateDir,
      () => this.#live.delete(instance),
    );
    this.#live.add(instance);
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? 90_000);
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const res = await instance.request({ method: 'GET', path: this.#options.readyPath });
        if (res.status === 200) return instance;
      } catch {
        // not listening yet
      }
      await sleep(250);
    }
    const log = instance.log.slice(-3000);
    await instance.stop();
    throw new Error(`wrangler dev did not become ready on port ${port}: ${log}`);
  }

  /** Stops every instance that is still running (for test teardown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#live].map((instance) => instance.stop().catch(() => undefined)));
  }
}
