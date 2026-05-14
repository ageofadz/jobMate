import path from "node:path";

import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const webRoot = import.meta.dirname;
const jobmateRoot = path.resolve(webRoot, "..");
const webNodeModules = path.join(webRoot, "node_modules");
const nm = (pkg: string) => path.join(webNodeModules, pkg);

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@": jobmateRoot,
      zod: nm("zod"),
      cheerio: nm("cheerio"),
      docx: nm("docx"),
      "better-sqlite3": nm("better-sqlite3"),
    },
  },
  ssr: {
    external: ["better-sqlite3"]
  },
  build: {
    rollupOptions: {
      external: ["better-sqlite3"]
    }
  },
  optimizeDeps: {
    include: [
      "@jlongster/sql.js",
      "absurd-sql",
      "absurd-sql/dist/indexeddb-main-thread.js",
      "absurd-sql/dist/indexeddb-backend.js",
    ],
  },
  server: {
    fs: {
      allow: [jobmateRoot]
    },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
