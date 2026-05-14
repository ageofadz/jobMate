import { initBackend } from "absurd-sql/dist/indexeddb-main-thread.js";

type WorkerResponse =
  | { id: number; result: unknown }
  | { id: number; error: string };

export type JobmateSqlite = {
  init: () => Promise<void>;
  run: (sql: string, params?: unknown[]) => Promise<void>;
  all: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  exec: (sql: string) => Promise<unknown>;
  terminate: () => void;
};

export function createJobmateSqlite(): JobmateSqlite {
  const worker = new Worker(new URL("./sqlite.worker.ts", import.meta.url), { type: "module" });
  initBackend(worker);

  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const data = ev.data;
    const entry = pending.get(data.id);

    if (!entry) {
      return;
    }

    pending.delete(data.id);

    if ("error" in data) {
      entry.reject(new Error(data.error));
    } else {
      entry.resolve(data.result);
    }
  };

  function call(type: "init" | "run" | "all" | "exec", payload: { sql?: string; params?: unknown[] } = {}) {
    const id = ++seq;

    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, ...payload });
    });
  }

  return {
    init() {
      return call("init").then(() => void 0);
    },
    run(sql, params) {
      return call("run", { sql, params }).then(() => void 0);
    },
    all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return call("all", { sql, params }) as Promise<T[]>;
    },
    exec(sql) {
      return call("exec", { sql });
    },
    terminate() {
      worker.terminate();
      pending.clear();
    }
  };
}
