// Minimal ambient declarations for the Cloudflare bindings this app uses.
// Kept local so the project does not need @cloudflare/workers-types, whose
// globals can collide with the DOM lib used by React components.

interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

interface R2Object {
  key: string;
  size: number;
  httpEtag?: string;
  httpMetadata?: { contentType?: string; cacheControl?: string };
  writeHttpMetadata?(headers: Headers): void;
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2Bucket {
  get(
    key: string,
    options?: { range?: { offset: number; length?: number } | { suffix: number } },
  ): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ArrayBuffer | ReadableStream | string | Blob,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
  ): Promise<R2Object>;
  delete(key: string | string[]): Promise<void>;
  head(key: string): Promise<R2Object | null>;
  list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ objects: R2Object[]; truncated: boolean; cursor?: string }>;
}
