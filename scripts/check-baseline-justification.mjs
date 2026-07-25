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

const base = resolveBase(rawBase);
if (base === undefined) {
  process.stderr.write(
    'baseline-justification: FAILED\nCould not resolve a base commit to compare against. ' +
      'The guard refuses to pass on an unverifiable range.\n',
  );
  process.exit(1);
}

// Three-dot: compare against the merge base, so commits that landed on the base
// branch after this one forked are not attributed to it.
const shas = (tryGit(['rev-list', `${base}...${head}`]) ?? '').split('\n').filter(Boolean);

const commits = shas.map(sha => ({
  body: tryGit(['log', '-1', '--format=%B', sha]) ?? '',
  // --name-status so an added artifact can be told from a modified one.
  files: (tryGit(['show', '--name-status', '--format=', sha]) ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [status, ...rest] = line.split('\t');
      return { status: (status ?? '').trim(), path: (rest[rest.length - 1] ?? '').trim() };
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
