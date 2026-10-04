// Synthetic storefront baseline, bundled at build time so seeding is reproducible
// and never depends on the runtime filesystem.
const raw = import.meta.glob(
  ['../../../fixtures/storefront/**/*', '!../../../fixtures/storefront/node_modules/**', '!../../../fixtures/storefront/dist/**'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const PREFIX = '../../../fixtures/storefront/';

export const STOREFRONT_FILES: ReadonlyArray<{ path: string; utf8: string }> = Object.entries(raw)
  .map(([k, utf8]) => ({ path: k.slice(PREFIX.length), utf8 }))
  .filter((f) => !f.path.endsWith('.tsbuildinfo'))
  .sort((a, b) => (a.path < b.path ? -1 : 1));

/** Fixed seed timestamp so the baseline commit is reproducible across retries. */
export const SEED_TIMESTAMP = 1_790_000_000;

// Deterministic fixture agents: checked-in full-file replacements + intents.
// Labelled "Fixture agents - no model calls" everywhere they surface.
const patchRaw = import.meta.glob(['../../../fixtures/deterministic/*/**/*', '../../../fixtures/projects/*/*/**/*'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface FixturePatch {
  role: string;
  taskId: string;
  files: Record<string, string>;
  intent: unknown;
  summary: string;
}

export function loadFixturePatch(kind: string, role: string): FixturePatch {
  // Storefront fixtures predate project mode and live in fixtures/deterministic.
  const base = kind === 'storefront' ? `../../../fixtures/deterministic/${role}/` : `../../../fixtures/projects/${kind}/${role}/`;
  const manifestText = patchRaw[`${base}manifest.json`];
  if (!manifestText) throw new Error(`INVALID_INPUT no fixture patch for role ${role}`);
  const manifest = JSON.parse(manifestText) as { role: string; taskId: string; files: Record<string, string>; intent: unknown; summary: string };
  const files: Record<string, string> = {};
  for (const [repoPath, rel] of Object.entries(manifest.files)) {
    const content = patchRaw[`${base}${rel}`];
    if (content === undefined) throw new Error(`INVALID_INPUT fixture ${role} is missing ${rel}`);
    files[repoPath] = content;
  }
  return { role: manifest.role, taskId: manifest.taskId, files, intent: manifest.intent, summary: manifest.summary };
}
