/**
 * One shell-ish tokenizer, shared.
 *
 * Extracted from `query/doctor.ts` (FR-19, Story 5.3) because two callers now
 * need it and the second cannot import the first: `query/memory-guard.ts`
 * declares the `PreToolUse` matcher that `doctor`'s `REQUIRED_WIRING` uses, so
 * `doctor` imports the guard and the guard must not import `doctor` back. A
 * second copy of the tokenizer was the alternative, and this repository has
 * paid for a duplicated primitive before — `findDbPath` had four copies, one of
 * which text search could not even see.
 *
 * `doctor` re-exports this so the public barrel and every existing importer
 * stay unchanged.
 */

/**
 * Split a settings hook command — or an agent's shell command — into
 * shell-ish tokens, honouring both quote styles. Needed because the
 * SessionStart command quotes two absolute paths that contain spaces
 * (`"C:/Program Files/nodejs/node.exe"`).
 *
 * Deliberately not a shell parser. It does not expand variables, resolve
 * substitutions, or split on `&&` — a caller reading an agent's command must
 * treat an unrecognised shape as "cannot tell", never as "nothing there".
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current.length > 0) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
  }
  if (started || current.length > 0) tokens.push(current);
  return tokens;
}
