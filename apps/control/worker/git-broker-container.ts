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

export class GitBrokerContainer extends DurableObject<Env> {
  private secret: string | null = null;

  private get container(): Container {
    const c = this.ctx.container;
    if (!c) throw new DomainError('DEPENDENCY_UNAVAILABLE', 'no container is configured for GitBrokerContainer');
    return c;
  }

  private async ensureReady(): Promise<string> {
    const c = this.container;
    if (!c.running || !this.secret) {
      if (c.running) await c.destroy('restart to rotate broker secret');
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      this.secret = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      c.start({
        image: c.images!.broker!,
        enableInternet: true,
        instance: 'lite',
        env: { BROKER_SHARED_SECRET: this.secret, PORT: String(BROKER_PORT) },
        labels: { role: 'git-broker' },
      });
      await c.setInactivityTimeout(5 * 60_000);
    }
    for (let i = 0; i < 60; i++) {
      try {
        const res = await c.getTcpPort(BROKER_PORT).fetch('http://broker/healthz');
        await res.body?.cancel();
        if (res.ok) return this.secret;
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
    const secret = await this.ensureReady();
    const res = await this.container.getTcpPort(BROKER_PORT).fetch(`http://broker/op/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-converge-broker-auth': secret },
      body: JSON.stringify(input),
    });
    const body = BrokerResponse.parse(await res.json());
    if (!body.ok) throw new DomainError(asCode(body.error.code), `broker ${name}: ${body.error.message}`);
    return brokerOps[name].output.parse(body.result) as BrokerOpOutput<N>;
  }

  async destroyContainer(): Promise<void> {
    this.secret = null;
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
