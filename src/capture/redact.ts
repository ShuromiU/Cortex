// ── Command Classification ────────────────────────────────────────────

/**
 * Classify a command into a broad category based on the first word(s).
 */
export function classifyCommand(cmd: string): string {
  const trimmed = cmd.trim();
  if (!trimmed) return 'other';

  // Normalize: collapse multiple spaces
  const normalized = trimmed.replace(/\s+/g, ' ');

  // Two-word prefixes first (more specific)
  if (/^go\s+test\b/.test(normalized)) return 'test';
  if (/^cargo\s+test\b/.test(normalized)) return 'test';
  if (/^dotnet\s+test\b/.test(normalized)) return 'test';
  if (/^go\s+build\b/.test(normalized)) return 'build';
  if (/^cargo\s+build\b/.test(normalized)) return 'build';
  if (/^dotnet\s+build\b/.test(normalized)) return 'build';
  if (/^go\s+run\b/.test(normalized)) return 'run';
  if (/^cargo\s+run\b/.test(normalized)) return 'run';
  if (/^dotnet\s+run\b/.test(normalized)) return 'run';

  // Single-word prefixes
  const first = normalized.split(' ')[0]!.toLowerCase();

  switch (first) {
    case 'git': return 'git';

    case 'npm':
    case 'npx':
    case 'yarn':
    case 'pnpm':
    case 'bun':
      return 'npm';

    case 'vitest':
    case 'jest':
    case 'pytest':
    case 'mocha':
    case 'ava':
      return 'test';

    case 'tsc':
    case 'make':
    case 'cmake':
    case 'gradle':
    case 'mvn':
      return 'build';

    case 'node':
    case 'python':
    case 'python3':
      return 'run';

    case 'ls':
    case 'dir':
    case 'cat':
    case 'head':
    case 'tail':
    case 'wc':
    case 'find':
    case 'grep':
    case 'rg':
    case 'fd':
    case 'tree':
      return 'read';

    case 'cd':
    case 'pwd':
    case 'echo':
    case 'mkdir':
    case 'cp':
    case 'mv':
      return 'shell';

    default:
      return 'other';
  }
}

// ── Secret Redaction ─────────────────────────────────────────────────

/**
 * Redact secrets from a command string.
 * Replaces matched secrets with [REDACTED], keeping flag prefixes intact.
 */
export function redactCommand(cmd: string): string {
  return redactSensitiveText(cmd);
}

export function redactSensitiveText(text: string): string {
  if (!text || !text.trim()) return text;

  let result = text;

  // API key patterns (prefix + 10+ chars)
  // Order matters: longer/more-specific prefixes first
  result = result.replace(/\bAKIA[A-Z0-9]{10,}\b/g, '[REDACTED]');
  result = result.replace(/\bglpat-[A-Za-z0-9_\-]{10,}\b/g, '[REDACTED]');
  result = result.replace(/\bxoxb-[A-Za-z0-9_\-]{10,}\b/g, '[REDACTED]');
  result = result.replace(/\bxoxp-[A-Za-z0-9_\-]{10,}\b/g, '[REDACTED]');
  result = result.replace(/\bxoxs-[A-Za-z0-9_\-]{10,}\b/g, '[REDACTED]');
  result = result.replace(/\bghp_[A-Za-z0-9]{10,}\b/g, '[REDACTED]');
  result = result.replace(/\bgho_[A-Za-z0-9]{10,}\b/g, '[REDACTED]');
  result = result.replace(/\bghu_[A-Za-z0-9]{10,}\b/g, '[REDACTED]');
  result = result.replace(/\bghs_[A-Za-z0-9]{10,}\b/g, '[REDACTED]');
  result = result.replace(/\bghr_[A-Za-z0-9]{10,}\b/g, '[REDACTED]');
  result = result.replace(/\bsk-[A-Za-z0-9]{10,}\b/g, '[REDACTED]');

  // Bearer tokens (20+ chars after "Bearer ")
  result = result.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}\b/g, 'Bearer [REDACTED]');

  // Flag values with = separator: --password=VALUE, --token=VALUE, etc.
  result = result.replace(
    /(--(?:password|token|secret|api-key))=(\S+)/gi,
    '$1=[REDACTED]',
  );

  // Flag values with space separator: --password VALUE, --token VALUE, etc.
  // Only replace the value if it's not already [REDACTED]
  result = result.replace(
    /(--(?:password|token|secret|api-key))\s+(?!\[REDACTED\])(\S+)/gi,
    '$1 [REDACTED]',
  );

  // Env var assignments: API_KEY=value, SECRET=value, etc.
  // Match at word boundary or start of string/after whitespace
  result = result.replace(
    /\b((?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS|AUTH))=(\S+)/g,
    '$1=[REDACTED]',
  );

  return result;
}

const OUTPUT_TAIL_LINE_LIMIT = 40;
const OUTPUT_TAIL_CHAR_LIMIT = 2000;

export function captureOutputTail(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\0/g, '').trimEnd();
  if (!normalized) {
    return '';
  }

  const lines = normalized.split('\n');
  const tailLines = lines.slice(-OUTPUT_TAIL_LINE_LIMIT).join('\n');
  if (tailLines.length <= OUTPUT_TAIL_CHAR_LIMIT) {
    return tailLines;
  }

  return tailLines.slice(-OUTPUT_TAIL_CHAR_LIMIT);
}

// ── File Path Extraction ──────────────────────────────────────────────

const FILE_EXTENSION_RE =
  /\b[\w./\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|css|json|md|yaml|yml|toml|sql|sh)\b/g;

/**
 * Extract file paths with known extensions from a command string.
 * Returns unique list in order of first appearance.
 */
export function extractTouchedFiles(cmd: string): string[] {
  const matches = cmd.match(FILE_EXTENSION_RE) ?? [];
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of matches) {
    if (!seen.has(m)) {
      seen.add(m);
      result.push(m);
    }
  }
  return result;
}
