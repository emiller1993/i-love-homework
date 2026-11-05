import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "definition", testMatch: "definition.spec.ts" },
    {
      name: "conversation",
      testMatch: "conversation.spec.ts",
      grepInvert: /normal Temporal|normal replay/,
    },
    // Process-restart checks must not share native child-server lifecycle with simulations.
    {
      name: "normal",
      testMatch: "conversation.spec.ts",
      grep: /normal Temporal/,
    },
    {
      name: "http",
      testMatch: "http-activities.spec.ts",
    },
    {
      name: "normal-replay",
      testMatch: "conversation.spec.ts",
      grep: /normal replay/,
    },
  ],
});
