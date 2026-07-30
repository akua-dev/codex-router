import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 10_000
  }
})
