import { DurableObject } from 'cloudflare:workers';
import { DomainError, type ErrorCode } from '@converge/domain';
import { BrokerResponse, brokerOps, type BrokerOpInput, type BrokerOpName, type BrokerOpOutput } from '@converge/infrastructure/git/ops';

/**
 * Trusted Git zone. Runs only the broker image (git + one bundled server); it
 * never executes candidate code. Needs outbound HTTPS to reach Artifacts Git
 * remotes. Credentials arrive per operation in the request body and are held
 * only in broker process memory.
 */
const BROKER_PORT = 9000;
const OP_TIMEOUT_MS = 180_000;

export class GitBrokerContainer extends DurableObject<Env> {
  private ready: Promise<string> | null = null;

  private get container(): Container {
    const c = this.ctx.container;
    if (!c) throw new DomainError('DEPENDENCY_UNAVAILABLE', 'no container is configured for GitBrokerContainer');
    return c;
  }

  /** One startup at a time; concurrent operations share it. */
  private ensureReady(): Promise<string> {
    this.ready ??= this.startOrReuse().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  private async startOrReuse(): Promise<string> {
    const c = this.container;
    // The secret lives in DO storage so a DO restart does not kill a running broker mid-operation.
    let secret = await this.ctx.storage.get<string>('brokerSecret');
    const image = c.images!.broker!;
    // A deploy with a new broker image must replace a container that is still running the old one.
    const stale = (await this.ctx.storage.get<string>('brokerImage')) !== image;
    if (!c.running || !secret || stale) {
      if (c.running) await c.destroy(stale ? 'restart on a new broker image' : 'restart to set a new broker secret');
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      secret = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      await this.ctx.storage.put({ brokerSecret: secret, brokerImage: image });
      c.start({
        image,
        enableInternet: true,
        instance: 'standard-1',
        env: { BROKER_SHARED_SECRET: secret, PORT: String(BROKER_PORT) },
        labels: { role: 'git-broker' },
      });
    }
    await c.setInactivityTimeout(10 * 60_000);
    for (let i = 0; i < 120; i++) {
      try {
        const res = await c.getTcpPort(BROKER_PORT).fetch('http://broker/healthz');
        await res.body?.cancel();
        if (res.ok) return secret;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new DomainError('DEPENDENCY_UNAVAILABLE', 'git broker did not become ready');
  }

  seedBaseline(input: BrokerOpInput<'seedBaseline'>) {
    return this.op('seedBaseline', input);
  }

  readHead(input: BrokerOpInput<'readHead'>) {
    return this.op('readHead', input);
  }

  materialize(input: BrokerOpInput<'materialize'>) {
    return this.op('materialize', input);
  }

  commitEdits(input: BrokerOpInput<'commitEdits'>) {
    return this.op('commitEdits', input);
  }

  assemble(input: BrokerOpInput<'assemble'>) {
    return this.op('assemble', input);
  }

  promote(input: BrokerOpInput<'promote'>) {
    return this.op('promote', input);
  }

  private async op<N extends BrokerOpName>(name: N, input: BrokerOpInput<N>): Promise<BrokerOpOutput<N>> {
    const started = Date.now();
    const secret = await this.ensureReady();
    // Bound every operation: a lost or hung request fails fast and the workflow step retries.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), OP_TIMEOUT_MS);
    let body: BrokerResponse;
    try {
      const res = await this.container.getTcpPort(BROKER_PORT).fetch(`http://broker/op/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-converge-broker-auth': secret },
        body: JSON.stringify(input),
        signal: abort.signal,
      });
      body = BrokerResponse.parse(await res.json());
    } catch (err) {
      this.ready = null;
      console.log(JSON.stringify({ broker: name, ms: Date.now() - started, ok: false, code: 'NO_ANSWER' }));
      throw new DomainError('DEPENDENCY_UNAVAILABLE', `broker ${name} did not answer: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
    // One log line per operation (no inputs, no credentials) so slow or failed calls show in `wrangler tail`.
    console.log(JSON.stringify({ broker: name, ms: Date.now() - started, ok: body.ok, code: body.ok ? null : body.error.code }));
    if (!body.ok) throw new DomainError(asCode(body.error.code), `broker ${name}: ${body.error.message}`);
    return brokerOps[name].output.parse(body.result) as BrokerOpOutput<N>;
  }

  async destroyContainer(): Promise<void> {
    this.ready = null;
    await this.ctx.storage.delete('brokerSecret');
    if (this.ctx.container?.running) await this.ctx.container.destroy('cleanup');
  }
}

function asCode(code: string): ErrorCode {
  const known: ErrorCode[] = [
    'INVALID_INPUT', 'INVALID_STATE', 'PROTECTED_PATH', 'OUT_OF_SCOPE_EDIT', 'FORBIDDEN', 'NOT_FOUND', 'DEPENDENCY_UNAVAILABLE',
    'REPO_NOT_READY', 'LIMIT_EXCEEDED',
  ];
  return (known as string[]).includes(code) ? (code as ErrorCode) : 'INTERNAL';
}
