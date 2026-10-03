import type { Capability, Observation } from '@converge/domain';

export interface AppRequest {
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface AppResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** Bounded body text. Implementations truncate with a labelled suffix. */
  bodyText: string;
}

export interface AppInstance {
  request(req: AppRequest): Promise<AppResponse>;
  stop(): Promise<void>;
}

/** Starts a fresh, isolated application process on each call. The caller bounds instances. */
export interface AppTarget {
  startFresh(): Promise<AppInstance>;
}

export interface CandidateRef {
  candidateId: string;
  headSha: string;
  manifestDigest: string;
}

export interface RunSuiteOptions {
  target: AppTarget;
  capabilities: readonly Capability[];
  candidate: CandidateRef;
  now?: () => number;
  /** Maximum application instances alive at once. Default 2. */
  maxInstances?: number;
  /** Per-check deadline in milliseconds. Default 60000. */
  checkTimeoutMs?: number;
}

export type { Observation };
