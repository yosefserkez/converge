// Node-only loaders for the checked-in fixtures. Not imported by index.ts.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectManifest } from '@converge/domain';
import {
  assembleFixturePatch,
  assembleProjectFixturePatch,
  type FixturePatch,
  type FixtureRole,
  parseFixtureManifest,
  parseProjectFixtureManifest,
  type ProjectFixturePatch,
  type ProjectFixtureRole,
} from './patch-manifest.ts';

export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
export const STOREFRONT_DIR = join(FIXTURES_DIR, 'storefront');
export const DETERMINISTIC_DIR = join(FIXTURES_DIR, 'deterministic');

/** Loads one deterministic fixture patch ("Fixture agents - no model calls"). */
export async function loadFixturePatch(role: FixtureRole, root: string = DETERMINISTIC_DIR): Promise<FixturePatch> {
  const dir = join(root, role);
  const manifest = parseFixtureManifest(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')), role);
  return assembleFixturePatch(manifest, (relativePath) => readFile(join(dir, relativePath), 'utf8'));
}

export const PROJECTS_DIR = fileURLToPath(new URL('../../../projects/', import.meta.url));

/** Reads and validates projects/<slug>/project.json. */
export async function loadProjectManifest(slug: string, root: string = PROJECTS_DIR): Promise<ProjectManifest> {
  return ProjectManifest.parse(JSON.parse(await readFile(join(root, slug, 'project.json'), 'utf8')));
}

/** Reads the setup files of a project as repository path to UTF-8 content. */
export async function loadProjectSetupFiles(manifest: ProjectManifest, root: string = PROJECTS_DIR): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const [repoPath, source] of Object.entries(manifest.setupFiles)) {
    files[repoPath] = await readFile(join(root, manifest.slug, source), 'utf8');
  }
  return files;
}

/** Loads one project fixture patch ("Fixture agents - no model calls"). */
export async function loadProjectFixturePatch(
  manifest: ProjectManifest,
  role: ProjectFixtureRole,
  root: string = join(FIXTURES_DIR, 'projects'),
): Promise<ProjectFixturePatch> {
  const dir = join(root, manifest.slug, role);
  const parsed = parseProjectFixtureManifest(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')), manifest.protectedPaths, role);
  return assembleProjectFixturePatch(parsed, (relativePath) => readFile(join(dir, relativePath), 'utf8'));
}

const BASELINE_EXCLUDES = new Set(['node_modules', 'dist', '.DS_Store', '.git']);

/** Reads the storefront baseline as repository path to UTF-8 content (no node_modules or dist). */
export async function loadStorefrontBaseline(dir: string = STOREFRONT_DIR): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (BASELINE_EXCLUDES.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files[relative(dir, full).split(sep).join('/')] = await readFile(full, 'utf8');
    }
  }
  await walk(dir);
  return files;
}
