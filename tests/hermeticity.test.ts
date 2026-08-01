import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { cortexHome, resolveStoreIdentity } from '../src/scope/identity.js';

/**
 * The guard that keeps the suite out of the developer's real memory store.
 *
 * These assertions exist because the protection they check is invisible: it
 * lives in `vitest.config.ts`'s `setupFiles`, nothing imports it, and deleting
 * that one line would make every other test in the repo pass while silently
 * writing into `~/.cortex`. Measured before the guard existed: one run created
 * 163 directories there.
 */
describe('test-suite hermeticity', () => {
  it('runs with CORTEX_HOME pointed at a throwaway directory', () => {
    const configured = process.env['CORTEX_HOME'];
    expect(configured, 'setupFiles must set CORTEX_HOME before any test runs').toBeTruthy();

    // Not merely set — set to somewhere disposable. A CORTEX_HOME pointing at
    // the real home would satisfy a truthiness check and protect nothing.
    const resolved = path.resolve(configured as string);
    expect(resolved.startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(resolved).not.toBe(path.join(os.homedir(), '.cortex'));
  });

  it('resolves store paths inside that directory, not under the real home', () => {
    // The end-to-end property, asserted through the real resolver rather than
    // by re-reading the variable: whatever a test resolves must land in temp.
    const identity = resolveStoreIdentity(process.cwd());
    expect(identity.home).toBe(path.resolve(process.env['CORTEX_HOME'] as string));
    expect(identity.dbPath.startsWith(path.resolve(os.tmpdir()))).toBe(true);

    const realHome = path.join(os.homedir(), '.cortex');
    expect(identity.dbPath.startsWith(realHome)).toBe(false);
  });

  it('would fall back to the real home if the variable were absent', () => {
    // Proves the guard is load-bearing rather than redundant: with CORTEX_HOME
    // removed, resolution really does point at ~/.cortex. If this ever stops
    // being true the setup file can be retired — until then it cannot.
    const saved = process.env['CORTEX_HOME'];
    try {
      delete process.env['CORTEX_HOME'];
      expect(cortexHome()).toBe(path.join(os.homedir(), '.cortex'));
    } finally {
      if (saved === undefined) delete process.env['CORTEX_HOME'];
      else process.env['CORTEX_HOME'] = saved;
    }
  });

  it('resolves this repository to a store outside its own working tree', () => {
    // Story 2.5's headline promise, checked against the repo itself.
    //
    // Deliberately NOT "no .cortex.db exists here": AC #3 requires migration to
    // leave the original in place until the user removes it, so this checkout
    // legitimately still has one. Asserting its absence would have been a test
    // demanding the opposite of the acceptance criterion.
    const identity = resolveStoreIdentity(process.cwd());
    const insideWorkingTree = path
      .resolve(identity.dbPath)
      .startsWith(path.resolve(process.cwd()) + path.sep);
    expect(insideWorkingTree, `${identity.dbPath} must live outside the repo`).toBe(false);
  });
});
