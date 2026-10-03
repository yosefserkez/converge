// Minimal Worker globals for browser type checks.
// The SPAs import worker DTO types with `import type` only. The type checker
// follows those imports into worker files, so it needs these names.
// The worker programs use the full worker-configuration.d.ts and never include this file.

type SqlStorageValue = ArrayBuffer | string | number | null;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface Env {}

interface SqlStorageCursor<T> {
  toArray(): T[];
  one(): T;
  readonly rowsWritten: number;
}

interface SqlStorage {
  exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
}

interface DurableObjectStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}
