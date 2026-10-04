import { DurableObject } from 'cloudflare:workers';
import { DomainError, type SourceBundle, canonicalJson } from '@converge/domain';

/**
 * Disposable container for UNTRUSTED candidate code. It never receives provider
 * keys, Cloudflare tokens, or repository credentials, and runs without Internet
 * access. Results produced inside it are data, never authority: the trusted
 * harness talks to the app over a fixed private port from outside.
 *
 * Two runtimes:
 * - storefront: the execution image with the fixture dependencies baked in.
 * - project: the generic project image, restored from a dependency snapshot
 *   that a trusted prep run made from the project's frozen lockfile.
 */
const APP_PORT = 8080;
const MAX_TOOL_OUTPUT = 32 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

export type Runtime = { kind: 'storefront' } | { kind: 'project'; snapshotId: string };

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  truncated: boolean;
  durationMs: number;
}

export interface AppHttpRequest {
  method: 'GET' | 'POST' | 'HEAD' | 'DELETE' | 'PUT';
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /** Binary body (for example multipart), base64-encoded. */
  bodyBase64?: string;
}

export interface AppHttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  truncated: boolean;
}

/** Serve command for the candidate app. `{port}` and `{stateDir}` are filled in here. */
export interface ServeSpec {
  argv: string[];
  readyPath: string;
}

const STOREFRONT_SERVE: ServeSpec = { argv: ['node', 'dist/server.mjs'], readyPath: '/healthz' };

export class ExecutionContainer extends DurableObject<Env> {
  private app: ExecProcess | null = null;
  private serveCount = 0;

  private get container(): Container {
    const c = this.ctx.container;
    if (!c) throw new DomainError('DEPENDENCY_UNAVAILABLE', 'no container is configured for ExecutionContainer');
    return c;
  }

  async imageRef(): Promise<string> {
    return this.container.images?.workspace ?? 'unknown';
  }

  async projectImageRef(): Promise<string> {
    return this.container.images?.project ?? 'unknown';
  }

  /** Select the runtime before the first command. A running container keeps its runtime. */
  async configure(runtime: Runtime): Promise<void> {
    await this.ctx.storage.put('runtime', runtime);
  }

  private async runtime(): Promise<Runtime> {
    return (await this.ctx.storage.get<Runtime>('runtime')) ?? { kind: 'storefront' };
  }

  private async ensureStarted(): Promise<void> {
    const c = this.container;
    if (!c.running) {
      const rt = await this.runtime();
      if (rt.kind === 'project') {
        c.start({ containerSnapshot: { id: rt.snapshotId }, enableInternet: false, instance: 'standard-1', labels: { role: 'execution' } });
      } else {
        c.start({ image: c.images!.workspace!, enableInternet: false, instance: 'standard-1', labels: { role: 'execution' } });
      }
      await c.setInactivityTimeout(10 * 60_000);
    }
    // exec waits for a container that is still starting; probe with a trivial command.
    await this.exec(['node', '-e', '0'], { timeoutMs: 90_000 });
  }

  /**
   * Trusted prep: start the project image WITH Internet (no secrets), load the
   * baseline, install from the frozen lockfile, run the prep build, and snapshot
   * the filesystem. Candidate containers later restore this snapshot offline.
   */
  async prepareSnapshot(args: { bundle: SourceBundle; install: string[]; prepBuild: string[]; name: string }): Promise<{ snapshotId: string; sizeBytes: number; log: string }> {
    const c = this.container;
    if (c.running) await c.destroy('fresh prep');
    c.start({ image: c.images!.project!, enableInternet: true, instance: 'standard-1', labels: { role: 'prep' } });
    await c.setInactivityTimeout(15 * 60_000);
    await this.exec(['node', '-e', '0'], { timeoutMs: 120_000 });
    const loaded = await this.exec(['node', '/opt/converge/load-source.mjs'], { stdin: canonicalJson(args.bundle), timeoutMs: 120_000 });
    if (loaded.exitCode !== 0) throw new DomainError('INTERNAL', `prep load failed: ${loaded.output.slice(0, 500)}`);
    const install = await this.runCommandInRunning(args.install, 600_000);
    if (install.exitCode !== 0) throw new DomainError('INTERNAL', `dependency install failed: ${install.output.slice(-1500)}`);
    const build = await this.runCommandInRunning(args.prepBuild, 300_000);
    if (build.exitCode !== 0) throw new DomainError('INTERNAL', `prep build failed: ${build.output.slice(-1500)}`);
    const snap = await c.snapshotContainer({ name: args.name });
    await c.destroy('prep finished');
    return { snapshotId: snap.id, sizeBytes: snap.size, log: `${install.output.slice(-4000)}\n---\n${build.output.slice(-2000)}` };
  }

  /** Materialize a verified source bundle into /workspace (replacing previous source). */
  async load(bundle: SourceBundle): Promise<ExecResult> {
    await this.ensureStarted();
    const rt = await this.runtime();
    const loader = rt.kind === 'project' ? '/opt/converge/load-source.mjs' : '/opt/converge/load-bundle.mjs';
    return this.exec(['node', loader], { stdin: canonicalJson(bundle), timeoutMs: 120_000 });
  }

  /** Run one allowlisted storefront tool (typecheck | unit | build). */
  async runTool(tool: 'typecheck' | 'unit' | 'build', timeoutMs = 120_000): Promise<ExecResult> {
    await this.ensureStarted();
    return this.exec(['node', '/opt/converge/run-tool.mjs', tool], { timeoutMs: timeoutMs + 5_000 });
  }

  /** Run one command from the project registry. The caller passes registry argv, never agent input. */
  async runCommand(argv: string[], timeoutMs = 180_000, maxOutput = MAX_TOOL_OUTPUT): Promise<ExecResult> {
    await this.ensureStarted();
    return this.runCommandInRunning(argv, timeoutMs, maxOutput);
  }

  private async runCommandInRunning(argv: string[], timeoutMs: number, maxOutput = MAX_TOOL_OUTPUT): Promise<ExecResult> {
    if (argv.length === 0 || argv.some((a) => a.includes('\0'))) throw new DomainError('INVALID_INPUT', 'invalid command');
    const r = await this.exec(['node', '/opt/converge/run-cmd.mjs', '--timeout-ms', String(timeoutMs), '--max-output', String(maxOutput), '--', ...argv], {
      timeoutMs: timeoutMs + 10_000,
      maxOutput: maxOutput * 2 + 4096,
    });
    // run-cmd prints one JSON line with the real exit code and capped output.
    try {
      const j = JSON.parse(r.output.trim().split('\n').pop() ?? '') as { exitCode: number | null; timedOut: boolean; output: string; truncated: boolean };
      return { exitCode: j.exitCode, timedOut: j.timedOut || r.timedOut, output: j.output, truncated: j.truncated, durationMs: r.durationMs };
    } catch {
      return { ...r, exitCode: r.exitCode === 0 ? null : r.exitCode };
    }
  }

  /** Read one workspace or /tmp file (for example a test report) with a size bound. */
  async readFile(path: string, maxBytes = MAX_FILE_BYTES): Promise<{ text: string; truncated: boolean } | null> {
    if (!/^\/(workspace|tmp)\/[A-Za-z0-9._/-]+$/.test(path) || path.includes('..')) throw new DomainError('INVALID_INPUT', 'invalid path');
    await this.ensureStarted();
    const r = await this.exec(['node', '-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path)}, 'utf8'))`], {
      timeoutMs: 30_000,
      maxOutput: maxBytes,
    });
    return r.exitCode === 0 ? { text: r.output, truncated: r.truncated } : null;
  }

  /** (Re)start the candidate app in a fresh process (and fresh state dir) and wait for readiness. */
  async startApp(spec: ServeSpec = STOREFRONT_SERVE): Promise<void> {
    await this.stopApp();
    await this.ensureStarted();
    this.serveCount += 1;
    const stateDir = `/tmp/converge-state-${this.serveCount}-${Date.now()}`;
    const argv = spec.argv.map((a) => a.replaceAll('{port}', String(APP_PORT)).replaceAll('{stateDir}', stateDir));
    this.app = await this.container.exec(argv, {
      cwd: '/workspace',
      env: { PORT: String(APP_PORT), NODE_ENV: 'production', HOME: '/tmp', WRANGLER_SEND_METRICS: 'false', CI: '1' },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const proc = this.app;
    void proc.exitCode.then(() => {
      if (this.app === proc) this.app = null;
    });
    for (let i = 0; i < 240; i++) {
      try {
        const res = await this.container.getTcpPort(APP_PORT).fetch(`http://app${spec.readyPath}`);
        await res.body?.cancel();
        if (res.status < 500) return;
      } catch {
        // not listening yet
      }
      if (!this.app) throw new DomainError('INTERNAL', 'candidate app exited before becoming ready');
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new DomainError('INTERNAL', 'candidate app did not become ready');
  }

  async stopApp(): Promise<void> {
    const proc = this.app;
    this.app = null;
    if (!proc) return;
    const exited = await Promise.race([proc.exitCode.then(() => true), Promise.resolve(false)]);
    if (!exited) {
      proc.kill(9);
      await Promise.race([proc.exitCode, new Promise((r) => setTimeout(r, 2000))]);
    }
  }

  /** Harness requests use the default 64 KiB bound; previews pass a larger one for assets. */
  async appRequest(req: AppHttpRequest, maxBytes = MAX_RESPONSE_BYTES): Promise<AppHttpResponse> {
    if (!req.path.startsWith('/') || req.path.startsWith('//')) throw new DomainError('INVALID_INPUT', 'invalid app path');
    let body: BodyInit | undefined;
    if (req.bodyBase64 !== undefined) body = Uint8Array.from(atob(req.bodyBase64), (ch) => ch.charCodeAt(0));
    else if (req.body !== undefined) body = req.body;
    const res = await this.container.getTcpPort(APP_PORT).fetch(`http://app${req.path}`, {
      method: req.method,
      headers: req.headers ?? {},
      ...(body !== undefined ? { body } : {}),
      redirect: 'manual',
    });
    const { text, truncated } = req.method === 'HEAD' ? { text: '', truncated: false } : await readBounded(res.body, maxBytes);
    return { status: res.status, headers: Object.fromEntries(res.headers), bodyText: text, truncated };
  }

  /** Forward a preview request to the running app (already validated by the gateway). */
  async previewFetch(req: Request): Promise<Response> {
    if (!this.app) return new Response('preview instance is not running', { status: 410 });
    return this.container.getTcpPort(APP_PORT).fetch(req);
  }

  async destroyContainer(reason = 'done'): Promise<void> {
    this.app = null;
    if (this.ctx.container?.running) await this.ctx.container.destroy(reason);
  }

  /**
   * Bounded exec: output is capped and labelled, and a hard timeout destroys the
   * whole container so descendants of the process cannot keep running.
   */
  private async exec(cmd: string[], opts: { stdin?: string; timeoutMs: number; cwd?: string; maxOutput?: number }): Promise<ExecResult> {
    const started = Date.now();
    const proc = await this.container.exec(cmd, {
      cwd: opts.cwd ?? '/workspace',
      stdout: 'pipe',
      stderr: 'combined',
      ...(opts.stdin !== undefined ? { stdin: 'pipe' as const } : {}),
    });
    if (opts.stdin !== undefined && proc.stdin) {
      const writer = proc.stdin.getWriter();
      await writer.write(encoder.encode(opts.stdin));
      await writer.close();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), opts.timeoutMs);
    });
    const outputPromise = readBounded(proc.stdout ?? null, opts.maxOutput ?? MAX_TOOL_OUTPUT);
    const winner = await Promise.race([proc.exitCode, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (winner === 'timeout') {
      // Killing the direct child is not enough for descendants; discard the container.
      await this.destroyContainer('hard timeout');
      return { exitCode: null, timedOut: true, output: '[timed out; container destroyed]', truncated: false, durationMs: Date.now() - started };
    }
    const { text, truncated } = await outputPromise;
    return { exitCode: winner ?? null, timedOut: false, output: text, truncated, durationMs: Date.now() - started };
  }
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: '', truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size < max) {
      const take = value.subarray(0, max - size);
      chunks.push(take);
      size += take.byteLength;
    }
    if (size >= max && value.byteLength > 0) truncated = true;
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const text = new TextDecoder().decode(buf);
  return { text: truncated ? `${text}\n[output truncated at ${max} bytes]` : text, truncated };
}
