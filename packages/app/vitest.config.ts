import { defineConfig } from "vitest/config";

// Note: we don't use @vitejs/plugin-react here (it would pull a second Vite
// version into the type graph). esbuild handles the automatic JSX runtime,
// which is all the tests need.
export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    css: false,
  },
});
