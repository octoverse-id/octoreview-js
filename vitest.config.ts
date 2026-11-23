import { defineConfig } from "vitest/config";

// Projects so CI can run them as separate required checks: `unit` (make test), `contract` (make
// contract, the offline contract gate against testdata/contract) and `integration` (make
// integration, against the real server; skipped without OCTOREVIEW_DEV_ENV).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/contract/**", "test/integration/**"],
        },
      },
      {
        test: {
          name: "contract",
          environment: "node",
          include: ["test/contract/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["test/integration/**/*.test.ts"],
        },
      },
    ],
  },
});
