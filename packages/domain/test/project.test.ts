import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CHECKS, CHECKS_BY_SUITE, PASTEBIN_CAPABILITIES, PASTEBIN_CHECKS, ProjectManifest, projectTaskWithForbiddenPaths, serveArgv } from '../src/index.ts';

const PROJECT_JSON = new URL('../../../projects/pastebin/project.json', import.meta.url);

async function pastebinJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(PROJECT_JSON, 'utf8')) as Record<string, unknown>;
}

describe('ProjectManifest', () => {
  it('validates the pastebin registry entry', async () => {
    const manifest = ProjectManifest.parse(await pastebinJson());
    expect(manifest.slug).toBe('pastebin');
    expect(manifest.tasks.map((t) => t.role)).toEqual(['storage', 'api-ui', 'delivery']);
    expect(manifest.tasks.flatMap((t) => t.capabilityIds)).toEqual([...PASTEBIN_CAPABILITIES]);
    expect(serveArgv(manifest, { port: 8080, stateDir: '/tmp/s' })).toContain('DEPLOY_URL:http://localhost:8080');
    expect(projectTaskWithForbiddenPaths(manifest, manifest.tasks[0]!).forbiddenPaths).toEqual(manifest.protectedPaths);
  });

  it('rejects a serve command without the port placeholder', async () => {
    const json = await pastebinJson();
    const runtime = json.runtime as { serve: { argv: string[] } };
    runtime.serve.argv = runtime.serve.argv.filter((a) => !a.includes('{port}'));
    expect(ProjectManifest.safeParse(json).success).toBe(false);
  });

  it('rejects unknown fields and a non-https source', async () => {
    expect(ProjectManifest.safeParse({ ...(await pastebinJson()), extra: 1 }).success).toBe(false);
    const json = await pastebinJson();
    json.source = { url: 'http://example.com/repo', commit: 'a'.repeat(40) };
    expect(ProjectManifest.safeParse(json).success).toBe(false);
  });
});

describe('check suites', () => {
  it('keeps the storefront catalog and adds the pastebin catalog', () => {
    expect(CHECKS_BY_SUITE.storefront).toBe(CHECKS);
    expect(CHECKS_BY_SUITE.pastebin).toBe(PASTEBIN_CHECKS);
    const ids = PASTEBIN_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.fromEntries(PASTEBIN_CHECKS.map((c) => [c.id, c.requires ?? null]))).toEqual({
      'paste.roundtrip': null,
      'paste.regression': null,
      'views.limit': 'view-limits',
      'views.cache-safety': 'view-limits',
      'delivery.conditional': 'conditional-get',
      'views.display': 'view-limits-ui',
    });
    expect(PASTEBIN_CHECKS.find((c) => c.id === 'paste.regression')?.evidence).toBe('in-container');
  });
});
