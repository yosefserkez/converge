import { DurableObject } from 'cloudflare:workers';
import { DomainError, type SourceBundle, canonicalJson } from '@converge/domain';

/**
 * Disposable container for UNTRUSTED candidate code. It never receives provider
 * keys, Cloudflare tokens, or repository credentials, and starts without
 * Internet access. Results produced inside it are data, never authority: the
 * trusted harness talks to the app over the fixed private port from outside.
 */
const APP_PORT = 8080;
const MAX_TOOL_OUTPUT = 32 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  truncated: boolean;
  durationMs: number;
}

export interface AppHttpRequest {
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface AppHttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  truncated: boolean;
}

export class ExecutionContainer extends DurableObject<Env> {
  private app: ExecProcess | null = null;

  private get container(): Container {
    const c = this.ctx.container;
    if (!c) throw new DomainError('DEPENDENCY_UNAVAILABLE', 'no container is configured for ExecutionContainer');
    return c;
  }

  async imageRef(): Promise<string> {
    return this.container.images?.workspace ?? 'unknown';
  }

  private async ensureStarted(): Promise<void> {
    const c = this.container;
    if (!c.running) {
      c.start({ image: c.images!.workspace!, enableInternet: false, instance: 'standard-1', labels: { role: 'execution' } });
      await c.setInactivityTimeout(10 * 60_000);
    }
    // exec waits for a container that is still starting; probe with a trivial command.
    await this.exec(['node', '-e', '0'], { timeoutMs: 60_000 });
  }

  /** Materialize a verified source bundle into /workspace (replacing previous contents). */
  async load(bundle: SourceBundle): Promise<ExecResult> {
    await this.ensureStarted();
    return this.exec(['node', '/opt/converge/load-bundle.mjs'], { stdin: canonicalJson(bundle), timeoutMs: 60_000 });
  }

  /** Run one allowlisted developer tool (typecheck | unit | build). */
  async runTool(tool: 'typecheck' | 'unit' | 'build', timeoutMs = 120_000): Promise<ExecResult> {
    await this.ensureStarted();
    return this.exec(['node', '/opt/converge/run-tool.mjs', tool], { timeoutMs });
  }

  /** (Re)start the candidate app in a fresh process and wait for readiness. */
  async startApp(): Promise<void> {
    await this.stopApp();
    await this.ensureStarted();
    this.app = await this.container.exec(['node', 'dist/server.mjs'], {
      cwd: '/workspace',
      env: { PORT: String(APP_PORT), NODE_ENV: 'production' },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const proc = this.app;
    void proc.exitCode.then(() => {
      if (this.app === proc) this.app = null;
    });
    for (let i = 0; i < 40; i++) {
      try {
        const res = await this.container.getTcpPort(APP_PORT).fetch('http://app/healthz');
        await res.body?.cancel();
        if (res.ok) return;
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
    const res = await this.container.getTcpPort(APP_PORT).fetch(`http://app${req.path}`, {
      method: req.method,
      headers: req.headers ?? {},
      ...(req.body !== undefined ? { body: req.body } : {}),
      redirect: 'manual',
    });
    const { text, truncated } = await readBounded(res.body, maxBytes);
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
  private async exec(cmd: string[], opts: { stdin?: string; timeoutMs: number; cwd?: string }): Promise<ExecResult> {
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
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), opts.timeoutMs);
    });
    const outputPromise = readBounded(proc.stdout ?? null, MAX_TOOL_OUTPUT);
    const winner = await Promise.race([proc.exitCode, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (winner === 'timeout') {
      timedOut = true;
      // Killing the direct child is not enough for descendants; discard the container.
      await this.destroyContainer('hard timeout');
      return { exitCode: null, timedOut, output: '[timed out; container destroyed]', truncated: false, durationMs: Date.now() - started };
    }
    const { text, truncated } = await outputPromise;
    return { exitCode: winner ?? null, timedOut, output: text, truncated, durationMs: Date.now() - started };
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
