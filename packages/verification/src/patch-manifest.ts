// Deterministic fixture patch format. Workers-safe: the caller supplies a
// reader, so a Worker can serve patch files from bundled text or storage.
import { ChangeIntent, PROTECTED_PATHS, RepoPath } from '@converge/domain';
import { z } from 'zod';

export const FIXTURE_ROLES = ['pricing', 'caching', 'checkout', 'repair'] as const;
export type FixtureRole = (typeof FIXTURE_ROLES)[number];

export function isProtectedPath(path: string, patterns: readonly string[] = PROTECTED_PATHS): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern,
  );
}

const FixtureManifestSchema = z.strictObject({
  role: z.enum(FIXTURE_ROLES),
  taskId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/),
  summary: z.string().min(1).max(1000),
  files: z.record(RepoPath, z.string()),
  intent: ChangeIntent,
});
export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;

export interface FixturePatch {
  role: FixtureRole;
  taskId: string;
  /** Repository path to full replacement UTF-8 content. */
  files: Record<string, string>;
  intent: ChangeIntent;
  summary: string;
}

/** Validates a manifest: schema, file mapping, no protected paths, paths declared in the intent. */
export function parseFixtureManifest(json: unknown, expectedRole?: FixtureRole): FixtureManifest {
  const manifest = FixtureManifestSchema.parse(json);
  if (expectedRole && manifest.role !== expectedRole) throw new Error(`manifest role ${manifest.role} is not ${expectedRole}`);
  const paths = Object.keys(manifest.files);
  if (paths.length === 0) throw new Error('fixture patch changes no files');
  for (const [repoPath, source] of Object.entries(manifest.files)) {
    if (source !== `files/${repoPath}`) throw new Error(`patch file for ${repoPath} must be files/${repoPath}`);
    if (isProtectedPath(repoPath)) throw new Error(`fixture patch edits protected path ${repoPath}`);
    if (!manifest.intent.affectedPaths.includes(repoPath)) throw new Error(`intent.affectedPaths omits ${repoPath}`);
  }
  return manifest;
}

/** Reads every patch file through `readText(relativePathInPatchDir)`. */
export async function assembleFixturePatch(
  manifest: FixtureManifest,
  readText: (relativePath: string) => Promise<string>,
): Promise<FixturePatch> {
  const files: Record<string, string> = {};
  for (const [repoPath, source] of Object.entries(manifest.files)) files[repoPath] = await readText(source);
  return { role: manifest.role, taskId: manifest.taskId, files, intent: manifest.intent, summary: manifest.summary };
}
