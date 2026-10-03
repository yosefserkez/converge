import { DomainError, digestBytes, type SourceBundle, type SourceFile } from '@converge/domain';
import type { z } from 'zod';
import type { MaterializeInput } from './ops.ts';
import { isSafeRepoPath } from './paths.ts';
import { fetchCommit } from './repo.ts';
import type { OpWorkspace } from './workspace.ts';

type MaterializeIn = z.output<typeof MaterializeInput>;

interface SizedEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  readonly size: number;
  readonly path: string;
}

const MAX_FILES = 5000;

export async function materialize(ws: OpWorkspace, input: MaterializeIn): Promise<SourceBundle> {
  ws.addRemote(input.remote, input.token);
  await fetchCommit(ws, input.remote, input.sha);

  const entries = await listSized(ws, input.sha);
  if (entries.length > MAX_FILES) throw new DomainError('LIMIT_EXCEEDED', `tree has more than ${MAX_FILES} files`);
  let total = 0;
  for (const e of entries) {
    if (e.mode === '120000') throw new DomainError('INVALID_INPUT', `symlink not allowed: ${e.path}`, { path: e.path });
    if (e.mode === '160000' || e.type === 'commit') {
      throw new DomainError('INVALID_INPUT', `submodule not allowed: ${e.path}`, { path: e.path });
    }
    if (e.type !== 'blob' || (e.mode !== '100644' && e.mode !== '100755')) {
      throw new DomainError('INVALID_INPUT', `unsupported tree entry: ${e.path}`, { path: e.path });
    }
    if (!isSafeRepoPath(e.path)) throw new DomainError('INVALID_INPUT', 'tree contains an unsafe path');
    if (e.size > input.maxFileBytes) {
      throw new DomainError('LIMIT_EXCEEDED', `file exceeds ${input.maxFileBytes} bytes: ${e.path}`, { path: e.path });
    }
    total += e.size;
    if (total > input.maxTotalBytes) throw new DomainError('LIMIT_EXCEEDED', `tree exceeds ${input.maxTotalBytes} bytes`);
  }

  const blobs = await readBlobs(ws, entries.map((e) => e.oid), total);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const files: SourceFile[] = [];
  for (const e of entries) {
    const bytes = blobs.get(e.oid);
    if (!bytes) throw new DomainError('INTERNAL', `blob missing for ${e.path}`);
    if (bytes.includes(0)) throw new DomainError('INVALID_INPUT', `binary file not allowed: ${e.path}`, { path: e.path });
    let utf8: string;
    try {
      utf8 = decoder.decode(bytes);
    } catch {
      throw new DomainError('INVALID_INPUT', `file is not valid UTF-8: ${e.path}`, { path: e.path });
    }
    files.push({ path: e.path, utf8, sha256: await digestBytes(bytes) });
  }
  return { schemaVersion: 1, baselineSha: input.sha, files };
}

async function listSized(ws: OpWorkspace, sha: string): Promise<SizedEntry[]> {
  const out = await ws.git(['ls-tree', '-r', '-l', '-z', '--full-tree', sha, '--']);
  const entries: SizedEntry[] = [];
  for (const record of out.stdout.toString('utf8').split('\0')) {
    if (!record) continue;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40}) +(-|\d+)\t(.+)$/s.exec(record);
    if (!m) throw new DomainError('INTERNAL', 'unexpected ls-tree output');
    entries.push({ mode: m[1]!, type: m[2]!, oid: m[3]!, size: m[4] === '-' ? 0 : Number(m[4]), path: m[5]! });
  }
  return entries;
}

/** Reads blobs with one `cat-file --batch` process. */
async function readBlobs(ws: OpWorkspace, oids: readonly string[], expectedBytes: number): Promise<Map<string, Buffer>> {
  const unique = [...new Set(oids)];
  const blobs = new Map<string, Buffer>();
  if (unique.length === 0) return blobs;
  const out = await ws.git(['cat-file', '--batch'], {
    stdin: `${unique.join('\n')}\n`,
    maxOutputBytes: expectedBytes + unique.length * 128 + 1024,
  });
  const buf = out.stdout;
  let pos = 0;
  for (const oid of unique) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) throw new DomainError('INTERNAL', 'truncated cat-file output');
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    if (header[0] !== oid || header[1] !== 'blob') throw new DomainError('INTERNAL', 'unexpected cat-file output');
    const size = Number(header[2]);
    const start = nl + 1;
    blobs.set(oid, buf.subarray(start, start + size));
    pos = start + size + 1;
  }
  return blobs;
}
