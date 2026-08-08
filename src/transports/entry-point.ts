import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Is this module the program the user actually invoked?
 *
 * The obvious test — `process.argv[1].endsWith('cli.js')` — is wrong for the
 * one case that matters most, and wrong SILENTLY. `npm install -g` puts a
 * SYMLINK on `PATH` (`/usr/local/bin/cortex` -> `.../dist/transports/cli.js`)
 * and Node sets `argv[1]` to the path used to invoke it, so the suffix never
 * matches: the CLI parsed nothing, printed nothing, and exited 0. Measured on
 * a global install into a clean Linux container — `--version`, `--help` and
 * every command produced empty output and a success code.
 *
 * It survived this long because Windows does not use a symlink. npm writes a
 * `cortex.cmd` shim that calls `node "<...>\cli.js"`, so `argv[1]` there
 * already IS the real file. Every local run on the reference platform was
 * therefore fine while the published package would have been inert on Linux
 * and macOS — the same shape as every other defect this suite has had to
 * learn: correct on the one platform it was tested on.
 *
 * Comparing REAL paths covers all three invocations — `node dist/.../cli.js`,
 * the POSIX symlink, and the Windows shim — because `realpathSync` resolves
 * the link before the comparison. Under a test runner `argv[1]` is the runner,
 * so importing this module still installs nothing, which is what lets
 * `createProgram` be unit-tested without side effects.
 *
 * The suffix test is kept as a fallback rather than deleted: it is the
 * behaviour that shipped, it can only ever ADD a case where the entry point
 * runs when invoked directly, and it keeps an exotic launcher (a wrapper that
 * rewrites `argv[1]`, a packaged snapshot with no real path on disk) working
 * rather than silently dead. Silence is the failure mode this whole function
 * exists to remove.
 *
 * @param moduleUrl the caller's `import.meta.url`
 * @param argv1 overridable for tests; defaults to the real `process.argv[1]`
 * @param suffixes accepted trailing filenames for the fallback
 */
export function isEntryPoint(
  moduleUrl: string,
  argv1: string | undefined = process.argv[1],
  suffixes: readonly string[] = [],
): boolean {
  if (typeof argv1 !== 'string' || argv1.length === 0) return false;

  try {
    const invoked = fs.realpathSync(argv1);
    const here = fs.realpathSync(fileURLToPath(moduleUrl));
    if (invoked === here) return true;
  } catch {
    // A path that cannot be resolved is not a match; fall through to the
    // suffix test rather than throwing out of a module's top level, which
    // would take the process down before it could report anything.
  }

  return suffixes.some(suffix => argv1.endsWith(suffix));
}
