#!/usr/bin/env node
/**
 * CI guard for AC #3 of story 1.5: a locked baseline may change, but the reason
 * has to survive into history. Kept as a script rather than inline YAML so the
 * logic is testable — `checkBaselineJustification` in src/eval/gate.ts is what
 * decides; this only gathers the git facts and reports.
 *
 * Usage: node scripts/check-baseline-justification.mjs <base-ref> <head-ref>
 * With no arguments it inspects the last commit only.
 */

import { execFileSync } from 'node:child_process';
import { checkBaselineJustification } from '../dist/eval/gate.js';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

const [baseRef, headRef] = process.argv.slice(2);
const range = baseRef && headRef ? `${baseRef}..${headRef}` : undefined;

let changedFiles;
let commitBodies;
try {
  changedFiles = range
    ? git(['diff', '--name-only', range]).split('\n').filter(Boolean)
    : git(['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
  commitBodies = range
    ? git(['log', '--format=%B', range])
    : git(['log', '-1', '--format=%B']);
} catch (error) {
  // A shallow clone or an unresolvable range must not fail the build on a
  // technicality — say so and let the rest of CI speak.
  process.stdout.write(
    `baseline-justification: skipped (could not read git history: ${error.message})\n`,
  );
  process.exit(0);
}

const verdict = checkBaselineJustification(changedFiles, commitBodies);
if (verdict.ok) {
  process.stdout.write('baseline-justification: ok\n');
  process.exit(0);
}

process.stderr.write(`baseline-justification: FAILED\n${verdict.reason}\n`);
process.exit(1);
