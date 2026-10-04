import { z } from 'zod';
import { CHECK_SUITES } from './catalog.ts';
import { BaselineFacts, GitOid, PathPattern, RepoPath, TaskSpec } from './schemas.ts';

// Curated project registry entry: projects/<slug>/project.json (docs/project-mode.md).
// The registry lives in the Converge repository, so agents cannot change it.

const Argv = z.array(z.string().min(1).max(500)).min(1).max(32);

/** Serve command placeholders that the runner fills in. */
export const SERVE_PLACEHOLDERS = ['{port}', '{stateDir}'] as const;

export const ProjectTaskRole = z.enum(['storage', 'api-ui', 'delivery']);
export type ProjectTaskRole = z.infer<typeof ProjectTaskRole>;

/**
 * A preset task: TaskSpec without baselineSha (the seed sets it) and without
 * forbiddenPaths (always the project's protectedPaths), with project roles.
 */
export const ProjectTask = TaskSpec.omit({ baselineSha: true, role: true, forbiddenPaths: true }).extend({ role: ProjectTaskRole });
export type ProjectTask = z.infer<typeof ProjectTask>;

export const ProjectManifest = z
  .strictObject({
    slug: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    source: z.strictObject({ url: z.url({ protocol: /^https$/ }), commit: GitOid }),
    /** Repository path to a file under projects/<slug>/. Each file replaces the repository file in the setup commit. */
    setupFiles: z.record(RepoPath, RepoPath),
    runtime: z.strictObject({
      install: Argv,
      prepBuild: Argv,
      tools: z.strictObject({ typecheck: Argv, unit: Argv, build: Argv }),
      /** Runs the project test suite and prints only its Vitest JSON report (input to paste.regression). */
      regression: Argv,
      serve: z.strictObject({ argv: Argv, readyPath: z.string().regex(/^\/[^\s]*$/) }),
    }),
    protectedPaths: z.array(PathPattern).min(1),
    goal: z.string().min(1).max(1000),
    tasks: z.array(ProjectTask).min(1).max(8),
    baselineFacts: BaselineFacts,
    checkSuite: z.enum(CHECK_SUITES),
    deploy: z.strictObject({ url: z.url({ protocol: /^https$/ }) }),
  })
  .superRefine((manifest, ctx) => {
    const serve = manifest.runtime.serve.argv.join(' ');
    for (const placeholder of SERVE_PLACEHOLDERS) {
      if (!serve.includes(placeholder)) ctx.addIssue({ code: 'custom', path: ['runtime', 'serve', 'argv'], message: `serve argv lacks ${placeholder}` });
    }
    const ids = manifest.tasks.map((t) => t.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['tasks'], message: 'task ids are not unique' });
  });
export type ProjectManifest = z.infer<typeof ProjectManifest>;

/** A preset task with its forbidden paths: the project's protected paths. */
export function projectTaskWithForbiddenPaths(manifest: ProjectManifest, task: ProjectTask): ProjectTask & { forbiddenPaths: string[] } {
  return { ...task, forbiddenPaths: [...manifest.protectedPaths] };
}

/** Replaces the serve placeholders. */
export function serveArgv(manifest: ProjectManifest, values: { port: number; stateDir: string }): string[] {
  return manifest.runtime.serve.argv.map((arg) =>
    arg.replaceAll('{port}', String(values.port)).replaceAll('{stateDir}', values.stateDir),
  );
}
