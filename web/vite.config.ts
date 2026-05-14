import path from "node:path";

import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const jobmateRoot = path.resolve(import.meta.dirname, "..");

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@": jobmateRoot
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
