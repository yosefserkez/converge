import type { WorkflowStep } from 'cloudflare:workers';
import type { Lease } from '../coordinator/store.ts';
import { ArtifactsRepoHost } from '../artifacts.ts';
import { loadConfig, type AppConfig } from '../config.ts';

export interface JobParams {
  jobId: string;
  attemptNo: number;
  fence: number;
  kind: string;
  projectSlug: string;
}

export interface JobContext {
  env: Env;
  /** Parsed job input. */
  input: Record<string, unknown>;
  config: AppConfig;
  step: WorkflowStep;
  lease: Lease;
  coordinator: DurableObjectStub<import('../coordinator/index.ts').ProjectCoordinator>;
  repos: ArtifactsRepoHost;
  broker: DurableObjectStub<import('../git-broker-container.ts').GitBrokerContainer>;
  /** Execution container dedicated to this job attempt. */
  execution: DurableObjectStub<import('../execution-container.ts').ExecutionContainer>;
}

export function makeContext(env: Env, step: WorkflowStep, lease: Lease, params: JobParams): JobContext {
  return {
    env,
    input: JSON.parse(lease.inputJson) as Record<string, unknown>,
    config: loadConfig(env),
    step,
    lease,
    coordinator: env.PROJECTS.getByName(params.projectSlug),
    repos: new ArtifactsRepoHost(env.ARTIFACTS),
    broker: env.GIT_BROKER.getByName(`broker-${params.projectSlug}`),
    execution: env.EXECUTION.getByName(`${lease.jobId}-a${lease.attemptNo}`),
  };
}

export const retrying = { retries: { limit: 3, delay: '3 seconds' as const, backoff: 'exponential' as const }, timeout: '10 minutes' as const };
export const once = { retries: { limit: 0, delay: '1 second' as const }, timeout: '20 minutes' as const };

export function errorCode(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const match = /\b([A-Z][A-Z_]{3,})\b/.exec(message);
  return { code: match?.[1] ?? 'INTERNAL', message: message.replace(/art_v1_[0-9a-f]{40}\S*/g, '[redacted]').slice(0, 500) };
}

export const isStaleFence = (err: unknown) => err instanceof Error && /STALE_FENCE|no longer holds authority/.test(err.message);
