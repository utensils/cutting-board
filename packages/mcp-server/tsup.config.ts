import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  // Bundle the workspace protocol package into the output so the published
  // server is self-contained and runnable via `node dist/index.js`.
  noExternal: ["@cutting-board/protocol"],
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  sourcemap: true,
});
