import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure-logic unit tests only. The in-Zotero specs under `test/*.spec.ts`
    // are run by the zotero-plugin-scaffold test runner, not vitest.
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
