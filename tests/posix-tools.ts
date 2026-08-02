import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolve a POSIX text tool to an absolute path without relying on `PATH`.
 *
 * Several suites here spawn REAL `bash`, `jq`, `grep` and `cut`, deliberately:
 * the hook scripts are shell + jq, so `tsc` cannot see inside them, and
 * reimplementing an index lookup in JavaScript would prove the format is
 * parseable by JavaScript rather than by the hot path AD-3 describes.
 *
 * But `spawnSync('grep', …)` inherits the parent's `PATH`, and Git for Windows
 * deliberately keeps `C:\Program Files\Git\usr\bin` OFF the system PATH.
 * Measured on this machine: run from Git Bash the suites pass; run the same
 * suites from PowerShell and seven `digest-index` assertions fail with
 * `status === null` — a spawn error, not an assertion — while seven
 * `capture-hook` tests self-skip. The verification surface silently depended on
 * which shell launched vitest.
 *
 * **On win32 the Git-for-Windows directories are searched BEFORE `PATH`**, and
 * that order is the whole point rather than a preference. Measured: `PATH` on
 * this machine resolves `bash` to `C:\WINDOWS\system32\bash.exe` — the **WSL
 * launcher stub**, which is what a bare `bash` means on most Windows installs
 * with WSL enabled. It is a different operating system with a different
 * filesystem view: it cannot see `C:\Users\…\AppData\…\jq.exe` on its PATH, so
 * the jq probe failed and the suite skipped itself while a perfectly good Git
 * Bash sat one directory away. Preferring PATH would keep that bug.
 *
 * Returns `null` when nothing is found, because the two callers want different
 * things: a suite whose subject *is* the shell layer should skip loudly, while
 * one that merely needs `grep` should fail — an environment that cannot run
 * grep cannot honestly report AD-3's contract as verified.
 */
export function findPosixTool(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  // `Git/bin` BEFORE `Git/usr/bin`, and the order is load-bearing for `bash`
  // and `sh`. `Git/bin/bash.exe` is the wrapper that sets up a POSIX `PATH`
  // before handing control to the shell; `Git/usr/bin/bash.exe` is the bare
  // binary, and a script launched through it inherits only the Windows PATH —
  // so `jq`, `grep`, `date`, `tr` and `wc` are all missing. Measured against
  // the real `cortex-capture.sh`: through `usr/bin/bash.exe` the hook exits 0
  // and writes NO spool line, which is precisely the silent-degradation shape
  // AD-12 makes the hooks adopt, so nothing complains. Through `bin/bash.exe`
  // the same call writes the expected record. `grep` and `cut` exist only under
  // `usr/bin`, so both directories stay in the list.
  const gitDirs = [
    'C:/Program Files/Git/bin',
    'C:/Program Files/Git/usr/bin',
    'C:/Program Files/Git/mingw64/bin',
    'C:/Program Files (x86)/Git/bin',
    'C:/Program Files (x86)/Git/usr/bin',
    path.join(os.homedir(), 'AppData/Local/Programs/Git/bin'),
    path.join(os.homedir(), 'AppData/Local/Programs/Git/usr/bin'),
  ];
  const pathDirs = (process.env['PATH'] ?? '').split(path.delimiter);
  const dirs = process.platform === 'win32'
    ? [...gitDirs, ...pathDirs]
    : [...pathDirs, ...gitDirs];

  for (const dir of dirs) {
    if (!dir) continue;
    // cmd.exe permits quoted PATH entries and strips the quotes before use.
    const cleaned = dir.replace(/^"|"$/g, '');
    for (const ext of exts) {
      const candidate = path.join(cleaned, `${name}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

/** As `findPosixTool`, but a missing tool is a failure rather than a skip. */
export function requirePosixTool(name: string): string {
  const found = findPosixTool(name);
  if (found === null) {
    throw new Error(
      `Could not find "${name}". This suite spawns the real tool because the ` +
        'behaviour under test is what a shell does with it, not what JavaScript ' +
        'does. Install Git for Windows, or put the POSIX tools on PATH.',
    );
  }
  return found;
}
