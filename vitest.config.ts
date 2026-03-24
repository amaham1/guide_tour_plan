import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcPath = fileURLToPath(new URL("./src/", import.meta.url));
const workerPath = fileURLToPath(new URL("./worker/", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: [
      {
        find: /^@\/worker\/(.*)$/,
        replacement: `${workerPath}$1`,
      },
      {
        find: /^@\/(.*)$/,
        replacement: `${srcPath}$1`,
      },
    ],
  },
});
