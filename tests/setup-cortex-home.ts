import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Point every test run's Cortex home at a throwaway directory.
 *
 * Story 2.5 moved the store to `$CORTEX_HOME/projects/<id>/cortex.db`, with
 * `CORTEX_HOME` defaulting to `~/.cortex`. That default turned a whole class of
 * existing tests — any that runs a CLI command in a temp directory — into
 * writers of the developer's *real* memory store. Measured before this file
 * existed: one suite run created **163 directories** under `~/.cortex/projects`.
 *
 * Story 2.4 recorded the same failure once already (an installer test wrote to
 * the real `~/.claude/settings.json`) and the response then was per-test
 * discipline. This is the chokepoint version, because per-test discipline only
 * protects the tests someone remembered to write it into — and the tests that
 * leaked here were all written before the store could move at all.
 *
 * Registered via `setupFiles` in `vitest.config.ts`, so it runs before any test
 * module is imported. `tests/hermeticity.test.ts` asserts it is in force; if
 * this file is ever dropped from the config, that test goes red rather than the
 * suite quietly resuming writes to a real home.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-test-home-'));
process.env['CORTEX_HOME'] = home;

// Vitest runs one setup per worker process; clean that worker's home when it
// exits. `force` because a test may already have removed it.
process.on('exit', () => {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // A store still held open on Windows is not worth failing a passing run.
  }
});
