#!/usr/bin/env node
/**
 * CI guard for AC #3 of story 1.5: a locked artifact may change, but the reason
 * has to survive into history on the commit that changed it. Kept as a script
 * rather than inline YAML so the logic is testable —
 * `checkBaselineJustification` in src/eval/gate.ts decides; this only gathers
 * the git facts, per commit.
 *
 * Usage: node scripts/check-baseline-justification.mjs <base-ref> <head-ref>
 */

import { execFileSync } from 'node:child_process';
import { checkBaselineJustification } from '../dist/eval/gate.js';

const NULL_SHA = /^0{40}$/;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return undefined;
  }
}

const [rawBase, rawHead] = process.argv.slice(2);
const head = rawHead && rawHead.trim().length > 0 ? rawHead.trim() : 'HEAD';

/**
 * A branch's first push reports an all-zeros "before" SHA, and a force-push
 * reports a SHA that is no longer reachable. Both used to fall into a catch
 * that degraded to a pass — so the guard skipped exactly the pushes it exists
 * to police. Resolve a real base instead, and only give up if git itself is
 * unusable.
 */
function resolveBase(candidate) {
  if (candidate && candidate.trim().length > 0 && !NULL_SHA.test(candidate.trim())) {
    const ref = candidate.trim();
    if (tryGit(['cat-file', '-e', `${ref}^{commit}`]) !== undefined) {
      return ref;
    }
  }
  // Default branch, then the previous commit, then the root commit.
  for (const fallback of ['origin/main', `${head}~1`]) {
    if (tryGit(['cat-file', '-e', `${fallback}^{commit}`]) !== undefined) {
      return fallback;
    }
  }
  const root = tryGit(['rev-list', '--max-parents=0', head]);
  return root ? root.trim().split('\n')[0] : undefined;
}

let base = resolveBase(rawBase);

// Pushing to the default branch itself resolves the fallback to the pushed tip,
// which would inspect zero commits and pass vacuously — the same blind spot in
// a new shape. Step back one commit instead.
if (
  base !== undefined &&
  tryGit(['rev-parse', `${base}^{commit}`])?.trim() === tryGit(['rev-parse', `${head}^{commit}`])?.trim()
) {
  base = tryGit(['rev-parse', `${head}~1^{commit}`]) !== undefined ? `${head}~1` : base;
}

if (base === undefined) {
  process.stderr.write(
    'baseline-justification: FAILED\nCould not resolve a base commit to compare against. ' +
      'The guard refuses to pass on an unverifiable range.\n',
  );
  process.exit(1);
}

// Two dots: commits reachable from head but not from base. `rev-list A...B` is
// the SYMMETRIC difference — it would also list base-only commits and blame the
// branch for someone else's work, which the author cannot amend. (Three-dot
// means merge-base for `git diff`, not for `git rev-list`.)
const shas = (tryGit(['rev-list', `${base}..${head}`]) ?? '').split('\n').filter(Boolean);

const commits = shas.map(sha => ({
  body: tryGit(['log', '-1', '--format=%B', sha]) ?? '',
  // --name-status so an added artifact can be told from a modified or moved
  // one. core.quotePath=false keeps non-ASCII paths from arriving quoted and
  // escaping the guarded-path match.
  files: (tryGit(['-c', 'core.quotePath=false', 'show', '--name-status', '--format=', sha]) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [status, ...rest] = line.split('\t');
      const trimmed = (status ?? '').trim();
      // Renames and copies arrive as `R100\told\tnew`.
      return /^[RC]/i.test(trimmed) && rest.length >= 2
        ? { status: trimmed, from: (rest[0] ?? '').trim(), path: (rest[1] ?? '').trim() }
        : { status: trimmed, path: (rest[rest.length - 1] ?? '').trim() };
    })
    .filter(file => file.path.length > 0),
}));

const verdict = checkBaselineJustification(commits);
if (verdict.ok) {
  process.stdout.write(`baseline-justification: ok (${commits.length} commit(s) in ${base}...${head})\n`);
  process.exit(0);
}

process.stderr.write(`baseline-justification: FAILED\n${verdict.reason}\n`);
process.exit(1);
