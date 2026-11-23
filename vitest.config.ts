import { defineConfig } from "vitest/config";

// Two projects so CI can run them as separate required checks: `unit` (make test) and
// `contract` (make contract, the offline contract gate against testdata/contract).
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
    ],
  },
});
