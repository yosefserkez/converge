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
  CHECKS_BY_SUITE,
  ProjectManifest,
  projectTaskWithForbiddenPaths,
} from '@converge/domain';
import { harnessDigest } from '@converge/verification';
import type { ServeSpec } from './runtime-types.ts';
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

// Registry projects under projects/<slug>/, bundled at build time.
const manifests = import.meta.glob('../../../projects/*/project.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const setupRaw = import.meta.glob('../../../projects/*/setup/**/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Fixed setup-commit timestamp, so a retried seed reproduces the same commit. */
const SETUP_TIMESTAMP = 1_790_100_000;

function fromManifest(path: string, text: string): ProjectDefinition {
  const m = ProjectManifest.parse(JSON.parse(text));
  const dir = path.slice(0, -'project.json'.length);
  const setupFiles = Object.entries(m.setupFiles).map(([repoPath, rel]) => {
    const utf8 = setupRaw[`${dir}${rel}`];
    if (utf8 === undefined) throw new Error(`INVALID_STATE project ${m.slug} is missing setup file ${rel}`);
    return { path: repoPath, utf8 };
  });
  const suite = m.checkSuite;
  return {
    kind: m.slug as ProjectDefinition['kind'],
    goal: m.goal,
    tasks: m.tasks.map((t) => projectTaskWithForbiddenPaths(m, t)),
    baselineFacts: m.baselineFacts,
    protectedPaths: m.protectedPaths,
    suite,
    checks: CHECKS_BY_SUITE[suite],
    fullGoalCapabilities: [...new Set(m.tasks.flatMap((t) => t.capabilityIds))],
    seed: { kind: 'import', url: m.source.url, commit: m.source.commit, setupFiles, timestamp: SETUP_TIMESTAMP },
    runtime: { kind: 'project', install: m.runtime.install, prepBuild: m.runtime.prepBuild, tools: m.runtime.tools, regression: m.runtime.regression, serve: m.runtime.serve },
    lockfile: 'pnpm-lock.yaml',
    deploy: m.deploy,
  };
}

const REGISTRY: Partial<Record<ProjectDefinition['kind'], ProjectDefinition>> = { storefront: STOREFRONT };
for (const [path, text] of Object.entries(manifests)) {
  const def = fromManifest(path, text);
  REGISTRY[def.kind] = def;
}

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
  return harnessDigest(suite);
}

/** Materialize bounds: imported projects carry larger generated files (for example worker-configuration.d.ts). */
export function materializeLimits(kind: ProjectDefinition['kind']): { maxFileBytes?: number; maxTotalBytes?: number } {
  return projectDefinition(kind).runtime.kind === 'project' ? { maxFileBytes: 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 } : {};
}
