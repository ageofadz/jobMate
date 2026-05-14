import { createContext, useContext, useEffect, useMemo, useState } from "react";

import type { JobmateSqlite } from "./sqlite-client";

type JobmateSqliteContextValue = {
  sqlite: JobmateSqlite | null;
  ready: boolean;
  error: Error | null;
};

const JobmateSqliteContext = createContext<JobmateSqliteContextValue | null>(null);

export function JobmateSqliteProvider({ children }: { children: React.ReactNode }) {
  const [sqlite, setSqlite] = useState<JobmateSqlite | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    let s: JobmateSqlite | null = null;

    void import("./sqlite-client")
      .then(({ createJobmateSqlite }) => {
        if (cancelled) {
          return;
        }
        s = createJobmateSqlite();
        setSqlite(s);
        return s
          .init()
          .then(() => {
            if (!cancelled) {
              setReady(true);
            }
          })
          .catch((e: unknown) => {
            if (!cancelled) {
              setError(e instanceof Error ? e : new Error(String(e)));
            }
          });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      });

    return () => {
      cancelled = true;
      s?.terminate();
      setSqlite(null);
      setReady(false);
    };
  }, []);

  const value = useMemo<JobmateSqliteContextValue>(
    () => ({ sqlite: ready && sqlite ? sqlite : null, ready, error }),
    [sqlite, ready, error]
  );

  return <JobmateSqliteContext.Provider value={value}>{children}</JobmateSqliteContext.Provider>;
}

export function useJobmateSqlite() {
  const ctx = useContext(JobmateSqliteContext);

  if (!ctx) {
    throw new Error("useJobmateSqlite must be used within JobmateSqliteProvider");
  }

  return ctx;
}
