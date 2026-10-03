import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Capability } from '@converge/domain';
import { loadFixturePatch, loadStorefrontBaseline, STOREFRONT_DIR } from '../../src/fixture-patches.ts';
import type { FixtureRole } from '../../src/patch-manifest.ts';

const run = promisify(execFile);

export const ROLE_CAPABILITY: Partial<Record<FixtureRole, Capability>> = {
  pricing: 'membership-pricing',
  caching: 'quote-cache',
  checkout: 'checkout-summary',
};

export async function createTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'converge-verification-'));
}

export async function removeTempRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/** Baseline content with the given patches overlaid in order (later patches win). */
export async function composeFiles(roles: readonly FixtureRole[], extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const files = await loadStorefrontBaseline();
  for (const role of roles) Object.assign(files, (await loadFixturePatch(role)).files);
  return Object.assign(files, extra);
}

export function capabilitiesFor(roles: readonly FixtureRole[]): Capability[] {
  return roles.flatMap((role) => {
    const capability = ROLE_CAPABILITY[role];
    return capability ? [capability] : [];
  });
}

/** Writes files into root/name, links the fixture node_modules, and runs build.mjs. */
export async function buildWorkspace(root: string, name: string, files: Record<string, string>): Promise<string> {
  const dir = join(root, name);
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await symlink(join(STOREFRONT_DIR, 'node_modules'), join(dir, 'node_modules'), 'dir');
  await run(process.execPath, ['build.mjs'], { cwd: dir, timeout: 60_000 });
  return dir;
}
