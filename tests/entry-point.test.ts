import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isEntryPoint } from '../src/transports/entry-point.js';

// The published package installed cleanly on Linux and then did nothing: every
// command printed empty output and exited 0, because `npm install -g` puts a
// SYMLINK named `cortex` on PATH and the old guard asked whether `argv[1]`
// ended with `cli.js`. Windows hid it — npm writes a `.cmd` shim there that
// passes the real file path through — so the reference platform was green
// while the package would have been inert on every other one.

describe('isEntryPoint', () => {
  let root: string;
  let realFile: string;

  beforeEach(() => {
    // `realpathSync` the root: on macOS `os.tmpdir()` sits under `/var`, a
    // symlink to `/private/var`, so an un-resolved fixture path would never
    // equal the resolved one and every case here would pass vacuously.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-entry-')));
    realFile = path.join(root, 'cli.js');
    fs.writeFileSync(realFile, '// entry point\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const url = (): string => pathToFileURL(realFile).href;

  it('matches when invoked by its own path', () => {
    expect(isEntryPoint(url(), realFile)).toBe(true);
  });

  it('matches through a path that needs normalising', () => {
    const noisy = path.join(root, '.', 'sub', '..', 'cli.js');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    expect(isEntryPoint(url(), noisy)).toBe(true);
  });

  it('does NOT match an unrelated file', () => {
    const other = path.join(root, 'other.js');
    fs.writeFileSync(other, '');
    expect(isEntryPoint(url(), other)).toBe(false);
  });

  it('does not match when there is no argv[1] at all', () => {
    expect(isEntryPoint(url(), undefined)).toBe(false);
    expect(isEntryPoint(url(), '')).toBe(false);
  });

  it('survives an argv[1] that does not exist, rather than throwing', () => {
    // A throw here happens at module top level, before anything can report it.
    expect(() => isEntryPoint(url(), path.join(root, 'gone.js'))).not.toThrow();
    expect(isEntryPoint(url(), path.join(root, 'gone.js'))).toBe(false);
  });

  it('keeps the suffix fallback for a launcher that rewrites argv[1]', () => {
    expect(isEntryPoint(url(), '/some/packaged/snapshot/cli.js', ['cli.js'])).toBe(true);
    expect(isEntryPoint(url(), '/some/packaged/snapshot/other.js', ['cli.js'])).toBe(false);
  });

  it('THE REGRESSION: matches through a symlink named like an installed command', () => {
    // Exactly what `npm install -g` creates: <prefix>/bin/cortex -> .../cli.js.
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, 'cortex');

    try {
      fs.symlinkSync(realFile, link, 'file');
    } catch (err) {
      // Windows refuses without Developer Mode or elevation. Skipping is
      // honest; Linux and macOS CI cover it, which is where the bug lived.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return;
      throw err;
    }

    // The old guard, for contrast: the link is named `cortex`, so this is false
    // and the whole program silently did nothing.
    expect(link.endsWith('cli.js')).toBe(false);

    expect(isEntryPoint(url(), link)).toBe(true);
  });
});
