/// <reference lib="webworker" />

import initSqlJs from "@jlongster/sql.js";
import sqlWasmUrl from "@jlongster/sql.js/dist/sql-wasm.wasm?url";
import { SQLiteFS } from "absurd-sql";
import IndexedDBBackend from "absurd-sql/dist/indexeddb-backend.js";

import { JOBMATE_SQLITE_DDL } from "./jobmate-ddl";
import { migrateBrowserApplicationSchema } from "./migrate-browser-schema";

const DB_PATH = "/sql/jobmate.sqlite";

type InitSqlJs = Awaited<ReturnType<typeof initSqlJs>>;
type DatabaseInstance = InstanceType<InitSqlJs["Database"]>;

let db: DatabaseInstance | null = null;
let initPromise: Promise<void> | null = null;

async function ensureDb() {
  if (db) {
    return;
  }

  if (!initPromise) {
    initPromise = (async () => {
      const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
      const backend = new IndexedDBBackend();
      const sqlFS = new SQLiteFS(SQL.FS, backend);
      SQL.register_for_idb(sqlFS);

      try {
        SQL.FS.mkdir("/sql");
      } catch {
        void 0;
      }

      SQL.FS.mount(sqlFS, {}, "/sql");

      if (typeof SharedArrayBuffer === "undefined") {
        const stream = SQL.FS.open(DB_PATH, "a+");
        await stream.node.contents.readIfFallback();
        SQL.FS.close(stream);
      }

      const database = new SQL.Database(DB_PATH, { filename: true });
      database.exec("PRAGMA journal_mode=MEMORY;");
      database.exec("PRAGMA foreign_keys=ON;");
      database.exec(JOBMATE_SQLITE_DDL);
      migrateBrowserApplicationSchema(database);
      db = database;
    })();
  }

  await initPromise;
}

type InMsg = {
  id: number;
  type: "init" | "run" | "all" | "exec";
  sql?: string;
  params?: unknown[];
};

function post(id: number, result: unknown) {
  self.postMessage({ id, result });
}

function postErr(id: number, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  self.postMessage({ id, error: message });
}

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const { id, type, sql, params } = ev.data;

  try {
    await ensureDb();

    if (!db) {
      throw new Error("Database not initialized");
    }

    if (type === "init") {
      post(id, null);
      return;
    }

    if (type === "run") {
      if (!sql) {
        throw new Error("Missing sql");
      }

      if (params?.length) {
        db.run(sql, params as never[]);
      } else {
        db.run(sql);
      }

      post(id, null);
      return;
    }

    if (type === "all") {
      if (!sql) {
        throw new Error("Missing sql");
      }

      const stmt = db.prepare(sql);

      try {
        if (params?.length) {
          stmt.bind(params as never[]);
        }

        const rows: Record<string, unknown>[] = [];

        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }

        post(id, rows);
      } finally {
        stmt.free();
      }

      return;
    }

    if (type === "exec") {
      if (!sql) {
        throw new Error("Missing sql");
      }

      post(id, db.exec(sql));
      return;
    }

    throw new Error(`Unknown type: ${type}`);
  } catch (e) {
    postErr(id, e);
  }
};
