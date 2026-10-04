import {
  ALL_CAPABILITIES,
  BASELINE_FACTS,
  CHECKS,
  PROTECTED_PATHS,
  STOREFRONT_GOAL,
  STOREFRONT_TASKS,
  type BaselineFacts,
  type Capability,
  type CheckDefinition,
  type TaskSpec,
} from '@converge/domain';
import { harnessDigest } from '@converge/verification';
import type { ServeSpec } from './execution-container.ts';
import { SEED_TIMESTAMP, STOREFRONT_FILES } from './fixtures.ts';

/**
 * Everything the platform needs to know about one registry project. The
 * registry lives in this repository, so agents cannot change it.
 */
export interface ProjectDefinition {
  kind: 'storefront' | 'pastebin';
  goal: string;
  tasks: ReadonlyArray<Omit<TaskSpec, 'baselineSha'>>;
  baselineFacts: BaselineFacts;
  protectedPaths: readonly string[];
  suite: 'storefront' | 'pastebin';
  checks: readonly CheckDefinition[];
  fullGoalCapabilities: readonly Capability[];
  seed:
    | { kind: 'files'; files: ReadonlyArray<{ path: string; utf8: string }>; timestamp: number }
    | { kind: 'import'; url: string; commit: string; setupFiles: ReadonlyArray<{ path: string; utf8: string }>; timestamp: number };
  runtime:
    | { kind: 'storefront' }
    | { kind: 'project'; install: string[]; prepBuild: string[]; tools: { typecheck: string[]; unit: string[]; build: string[] }; regression: string[]; serve: ServeSpec };
  /** Lockfile path whose digest keys the dependency snapshot. */
  lockfile: string;
  deploy?: { url: string };
}

const STOREFRONT: ProjectDefinition = {
  kind: 'storefront',
  goal: STOREFRONT_GOAL,
  tasks: STOREFRONT_TASKS,
  baselineFacts: BASELINE_FACTS,
  protectedPaths: PROTECTED_PATHS,
  suite: 'storefront',
  checks: CHECKS,
  fullGoalCapabilities: ALL_CAPABILITIES,
  seed: { kind: 'files', files: STOREFRONT_FILES, timestamp: SEED_TIMESTAMP },
  runtime: { kind: 'storefront' },
  lockfile: 'package-lock.json',
};

const REGISTRY: Partial<Record<ProjectDefinition['kind'], ProjectDefinition>> = { storefront: STOREFRONT };

export function projectDefinition(kind: ProjectDefinition['kind']): ProjectDefinition {
  const def = REGISTRY[kind];
  if (!def) throw new Error(`INVALID_STATE project kind ${kind} is not in the registry`);
  return def;
}

/** Register a project definition (used by the registry loader for projects/<slug>/). */
export function registerProject(def: ProjectDefinition): void {
  REGISTRY[def.kind] = def;
}

/** Harness digest of a check suite; it changes whenever the suite's checks or expectations change. */
export function harnessDigestFor(suite: ProjectDefinition['suite']): Promise<string> {
  if (suite !== 'storefront') throw new Error(`INVALID_STATE no harness for suite ${suite} yet`);
  return harnessDigest();
}
