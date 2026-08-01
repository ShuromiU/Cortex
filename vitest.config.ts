import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    // Sandboxes CORTEX_HOME for the whole run. Without it, any test that runs a
    // CLI command writes into the developer's real ~/.cortex — see the file.
    setupFiles: ['./tests/setup-cortex-home.ts'],
  },
});
