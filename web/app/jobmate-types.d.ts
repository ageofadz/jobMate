declare module "absurd-sql" {
  export class SQLiteFS {
    constructor(FS: unknown, backend: unknown);
  }
}

declare module "absurd-sql/dist/indexeddb-backend.js" {
  export default class IndexedDBBackend {
    constructor(onFallbackFailure?: () => void);
  }
}

declare module "absurd-sql/dist/indexeddb-main-thread.js" {
  export function initBackend(worker: Worker): void;
}

declare module "@jlongster/sql.js" {
  export type SqlValue = number | string | Uint8Array | null;

  export class Statement {
    bind(values?: SqlValue[] | Record<string, SqlValue>): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlValue>;
    get(params?: SqlValue[]): SqlValue[];
    run(values?: SqlValue[] | Record<string, SqlValue>): void;
    free(): boolean;
    freemem(): void;
  }

  export class Database {
    constructor(data?: ArrayLike<number> | Buffer | null | string, options?: { filename?: boolean });
    close(): void;
    run(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Database;
    exec(sql: string): unknown[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
  }

  interface SqlJsStatic {
    Database: typeof Database;
    FS: {
      mkdir(path: string): void;
      mount(fs: unknown, opts: Record<string, unknown>, mountpoint: string): void;
      open(path: string, flags: string): { node: { contents: { readIfFallback(): Promise<void> } } };
      close(stream: unknown): void;
      analyzePath(path: string): { exists: boolean };
    };
    register_for_idb(fs: unknown): void;
  }

  function initSqlJs(
    config?: { locateFile?: (file: string) => string }
  ): Promise<SqlJsStatic>;

  export default initSqlJs;
}
