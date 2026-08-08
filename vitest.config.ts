import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // 30s, raised from 10s on evidence rather than preference.
    //
    // The 10s bound was measuring RUNNER LOAD, not code health. Proof: commit
    // b48d6ba — a package rename and a README edit, touching no runtime code —
    // passed the full matrix on one branch and failed windows-latest/node 22 on
    // the other, in two runs of THE SAME COMMIT, with 7 unrelated tests across
    // 5 files all failing as `Test timed out in 10000ms`. Nothing that pattern
    // describes is a defect in the code under test.
    //
    // The cost of the old bound was not a slow suite, it was a suite that goes
    // red at random. That trains the reflex to re-run rather than investigate,
    // which is the same "cries wolf" failure this codebase already names as
    // what destroys a diagnostic's value.
    //
    // What is given up is small and worth naming: a genuine performance
    // regression now has to be 3x worse before a timeout catches it. That was
    // never this number's job — the suite's real performance guards are the
    // explicit budget assertions (B-1 <=150ms, B-3 <=20ms p95), which measure
    // what they care about directly. A true hang is unbounded and still caught.
    //
    // The slow cases were also fixed at their source rather than hidden here:
    // the WAL and gc seeders batch their inserts instead of paying one fsync
    // per row.
    testTimeout: 30_000,
    // Sandboxes CORTEX_HOME for the whole run. Without it, any test that runs a
    // CLI command writes into the developer's real ~/.cortex — see the file.
    setupFiles: ['./tests/setup-cortex-home.ts'],
  },
});
