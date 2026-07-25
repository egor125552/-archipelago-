import {defineConfig} from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["hostile-gunner-client-audit.e2e.spec.mjs"],
  timeout: 90_000,
  expect: {timeout: 12_000},
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:8787",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {browserName: "chromium", viewport: {width: 1280, height: 900}},
    },
    {
      name: "webkit-iphone",
      use: {
        browserName: "webkit",
        viewport: {width: 390, height: 844},
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
