import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/**/*.test.ts",
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "services/**/*.test.ts"
    ],
    // Default to node; component tests opt into jsdom via a
    // `// @vitest-environment jsdom` docblock at the top of the file.
    environment: "node"
  }
});

