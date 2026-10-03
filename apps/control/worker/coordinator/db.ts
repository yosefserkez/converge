import { sha256Hex } from '@converge/domain';
import m001 from '../../../../migrations/001_initial.sql?raw';
import m002 from '../../../../migrations/002_coordination.sql?raw';

export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: m001 },
  { version: 2, sql: m002 },
];

type Bindable = string | number | null;
export type Row = Record<string, SqlStorageValue>;

/** Thin typed wrapper around Durable Object SQLite storage. Every call is synchronous. */
export class Db {
  constructor(private readonly storage: DurableObjectStorage) {}

  get sql(): SqlStorage {
    return this.storage.sql;
  }

  run(query: string, ...params: Bindable[]): number {
    return this.sql.exec(query, ...params).rowsWritten;
  }

  all<T extends Row = Row>(query: string, ...params: Bindable[]): T[] {
    return this.sql.exec<T>(query, ...params).toArray();
  }

  one<T extends Row = Row>(query: string, ...params: Bindable[]): T | undefined {
    return this.sql.exec<T>(query, ...params).toArray()[0];
  }

  value<T extends SqlStorageValue>(query: string, ...params: Bindable[]): T | undefined {
    const row = this.one(query, ...params);
    return row ? (Object.values(row)[0] as T) : undefined;
  }

  tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}

/**
 * Apply versioned migrations. Each script runs as one multi-statement exec
 * (statements are never split on semicolons, because triggers contain them)
 * inside a transaction with its checksum recorded. A changed checksum for an
 * already-applied version is a hard error: reviewed migrations are append-only.
 */
export async function migrate(db: Db): Promise<void> {
  const checksums = await Promise.all(MIGRATIONS.map(async (m) => ({ ...m, checksum: await sha256Hex(m.sql) })));
  const hasTable = db.value<number>(
    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'",
  );
  const applied = new Map<number, string>(
    hasTable
      ? db.all<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migration').map((r) => [
          r.version,
          r.checksum,
        ])
      : [],
  );
  for (const m of checksums) {
    const prior = applied.get(m.version);
    if (prior !== undefined) {
      if (prior !== m.checksum) throw new Error(`migration ${m.version} checksum changed after it was applied`);
      continue;
    }
    db.tx(() => {
      db.sql.exec(m.sql);
      db.run('INSERT INTO schema_migration (version, applied_at, checksum) VALUES (?, ?, ?)', m.version, Date.now(), m.checksum);
    });
  }
}

export const json = (value: unknown): string => JSON.stringify(value);
export const parse = <T>(text: SqlStorageValue | undefined): T => JSON.parse(String(text)) as T;
