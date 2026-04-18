import { describe, it, expect } from 'vitest';
import {
  captureOutputTail,
  classifyCommand,
  redactCommand,
  redactSensitiveText,
  extractTouchedFiles,
} from '../src/capture/redact.js';

// ── classifyCommand ────────────────────────────────────────────────────

describe('classifyCommand', () => {
  // git
  it('classifies git commands', () => {
    expect(classifyCommand('git commit -m "fix"')).toBe('git');
    expect(classifyCommand('git push origin main')).toBe('git');
    expect(classifyCommand('git status')).toBe('git');
  });

  // npm family
  it('classifies npm/npx/yarn/pnpm/bun as npm', () => {
    expect(classifyCommand('npm install')).toBe('npm');
    expect(classifyCommand('npx tsc --noEmit')).toBe('npm');
    expect(classifyCommand('yarn add lodash')).toBe('npm');
    expect(classifyCommand('pnpm run build')).toBe('npm');
    expect(classifyCommand('bun run test')).toBe('npm');
  });

  // test runners
  it('classifies test runners', () => {
    expect(classifyCommand('vitest run')).toBe('test');
    expect(classifyCommand('jest --coverage')).toBe('test');
    expect(classifyCommand('pytest tests/')).toBe('test');
    expect(classifyCommand('go test ./...')).toBe('test');
    expect(classifyCommand('cargo test')).toBe('test');
    expect(classifyCommand('dotnet test')).toBe('test');
    expect(classifyCommand('mocha --timeout 5000')).toBe('test');
    expect(classifyCommand('ava')).toBe('test');
  });

  // build tools
  it('classifies build tools', () => {
    expect(classifyCommand('tsc --build')).toBe('build');
    expect(classifyCommand('cargo build --release')).toBe('build');
    expect(classifyCommand('go build ./...')).toBe('build');
    expect(classifyCommand('make all')).toBe('build');
    expect(classifyCommand('cmake ..')).toBe('build');
    expect(classifyCommand('gradle build')).toBe('build');
    expect(classifyCommand('mvn package')).toBe('build');
    expect(classifyCommand('dotnet build')).toBe('build');
  });

  // run
  it('classifies runtime invocations', () => {
    expect(classifyCommand('node index.js')).toBe('run');
    expect(classifyCommand('python script.py')).toBe('run');
    expect(classifyCommand('python3 app.py')).toBe('run');
    expect(classifyCommand('go run main.go')).toBe('run');
    expect(classifyCommand('cargo run')).toBe('run');
    expect(classifyCommand('dotnet run')).toBe('run');
  });

  // read
  it('classifies read/search commands', () => {
    expect(classifyCommand('ls -la')).toBe('read');
    expect(classifyCommand('dir /b')).toBe('read');
    expect(classifyCommand('cat README.md')).toBe('read');
    expect(classifyCommand('head -n 20 file.ts')).toBe('read');
    expect(classifyCommand('tail -f log.txt')).toBe('read');
    expect(classifyCommand('wc -l src/*.ts')).toBe('read');
    expect(classifyCommand('find . -name "*.ts"')).toBe('read');
    expect(classifyCommand('grep -r "TODO" src/')).toBe('read');
    expect(classifyCommand('rg "pattern"')).toBe('read');
    expect(classifyCommand('fd "*.ts"')).toBe('read');
    expect(classifyCommand('tree src/')).toBe('read');
  });

  // shell
  it('classifies shell/navigation commands', () => {
    expect(classifyCommand('cd /home/user')).toBe('shell');
    expect(classifyCommand('pwd')).toBe('shell');
    expect(classifyCommand('echo hello')).toBe('shell');
    expect(classifyCommand('mkdir -p src/components')).toBe('shell');
    expect(classifyCommand('cp file.ts backup.ts')).toBe('shell');
    expect(classifyCommand('mv old.ts new.ts')).toBe('shell');
  });

  // other
  it('classifies unknown commands as other', () => {
    expect(classifyCommand('docker run -it ubuntu')).toBe('other');
    expect(classifyCommand('kubectl apply -f pod.yaml')).toBe('other');
    expect(classifyCommand('curl https://example.com')).toBe('other');
    expect(classifyCommand('ssh user@host')).toBe('other');
  });

  // edge cases
  it('handles empty and whitespace-only input', () => {
    expect(classifyCommand('')).toBe('other');
    expect(classifyCommand('   ')).toBe('other');
  });

  it('is case-insensitive for the first word', () => {
    // commands are typically lowercase; first word matched lowercase
    expect(classifyCommand('Git status')).toBe('git');
    expect(classifyCommand('NPM install')).toBe('npm');
  });
});

// ── redactCommand ──────────────────────────────────────────────────────

describe('redactCommand', () => {
  it('returns empty/whitespace input as-is', () => {
    expect(redactCommand('')).toBe('');
    expect(redactCommand('   ')).toBe('   ');
  });

  it('passes safe commands through unchanged', () => {
    expect(redactCommand('git commit -m "fix typo"')).toBe('git commit -m "fix typo"');
    expect(redactCommand('npm install lodash')).toBe('npm install lodash');
    expect(redactCommand('ls -la src/')).toBe('ls -la src/');
  });

  it('redacts sk- API keys', () => {
    expect(redactCommand('curl -H "Authorization: sk-abcdefghijklmno" https://api.openai.com'))
      .toBe('curl -H "Authorization: [REDACTED]" https://api.openai.com');
  });

  it('redacts GitHub token prefixes', () => {
    expect(redactCommand('export TOKEN=ghp_ABCDEFGHIJKLMNOPabc')).toContain('[REDACTED]');
    expect(redactCommand('echo gho_ABCDEFGHIJKLMNOPabc')).toContain('[REDACTED]');
    expect(redactCommand('echo ghu_ABCDEFGHIJKLMNOPabc')).toContain('[REDACTED]');
    expect(redactCommand('echo ghs_ABCDEFGHIJKLMNOPabc')).toContain('[REDACTED]');
    expect(redactCommand('echo ghr_ABCDEFGHIJKLMNOPabc')).toContain('[REDACTED]');
  });

  it('redacts GitLab personal access tokens', () => {
    expect(redactCommand('git clone https://oauth2:glpat-ABCDEFGHIJKLMno@gitlab.com/repo'))
      .toContain('[REDACTED]');
  });

  it('redacts Slack tokens', () => {
    expect(redactCommand('slack-cli --token xoxb-ABCDEFGHIJKLMNOPabc')).toContain('[REDACTED]');
    expect(redactCommand('export T=xoxp-ABCDEFGHIJKLMNOPabc')).toContain('[REDACTED]');
    expect(redactCommand('export T=xoxs-ABCDEFGHIJKLMNOPabc')).toContain('[REDACTED]');
  });

  it('redacts AWS access key IDs', () => {
    expect(redactCommand('aws --key AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    const cmd = 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"';
    expect(redactCommand(cmd)).toContain('Bearer [REDACTED]');
    expect(redactCommand(cmd)).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('does NOT redact short Bearer tokens (under 20 chars)', () => {
    const cmd = 'curl -H "Authorization: Bearer shorttoken"';
    // "shorttoken" is 10 chars < 20, should NOT be redacted
    expect(redactCommand(cmd)).toBe(cmd);
  });

  it('redacts --password= flag values', () => {
    expect(redactCommand('mysql --password=supersecret')).toBe('mysql --password=[REDACTED]');
  });

  it('redacts --token= flag values', () => {
    expect(redactCommand('deploy --token=myverysecrettoken')).toBe('deploy --token=[REDACTED]');
  });

  it('redacts --secret= flag values', () => {
    expect(redactCommand('tool --secret=abc123')).toBe('tool --secret=[REDACTED]');
  });

  it('redacts --api-key= flag values', () => {
    expect(redactCommand('tool --api-key=abc123')).toBe('tool --api-key=[REDACTED]');
  });

  it('redacts --password VALUE (space separator)', () => {
    expect(redactCommand('mysql --password supersecret')).toBe('mysql --password [REDACTED]');
  });

  it('redacts --token VALUE (space separator)', () => {
    expect(redactCommand('deploy --token myverysecrettoken')).toBe('deploy --token [REDACTED]');
  });

  it('redacts --secret VALUE (space separator)', () => {
    expect(redactCommand('tool --secret abc123')).toBe('tool --secret [REDACTED]');
  });

  it('redacts --api-key VALUE (space separator)', () => {
    expect(redactCommand('tool --api-key abc123')).toBe('tool --api-key [REDACTED]');
  });

  it('redacts API_KEY env var assignments', () => {
    expect(redactCommand('API_KEY=mysecret node app.js')).toBe('API_KEY=[REDACTED] node app.js');
  });

  it('redacts SECRET env var assignments', () => {
    expect(redactCommand('SECRET=mysecret npm run deploy')).toBe('SECRET=[REDACTED] npm run deploy');
  });

  it('redacts TOKEN env var assignments', () => {
    expect(redactCommand('TOKEN=mytoken123 ./script.sh')).toBe('TOKEN=[REDACTED] ./script.sh');
  });

  it('redacts PASSWORD env var assignments', () => {
    expect(redactCommand('PASSWORD=hunter2 db-migrate')).toBe('PASSWORD=[REDACTED] db-migrate');
  });

  it('redacts CREDENTIALS env var assignments', () => {
    expect(redactCommand('CREDENTIALS=abc123 deploy')).toBe('CREDENTIALS=[REDACTED] deploy');
  });

  it('redacts AUTH env var assignments', () => {
    expect(redactCommand('AUTH=bearer123 fetch-data')).toBe('AUTH=[REDACTED] fetch-data');
  });

  it('keeps flag prefix when redacting', () => {
    const result = redactCommand('tool --password=hunter2');
    expect(result).toContain('--password=');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('hunter2');
  });
});

describe('redactSensitiveText', () => {
  it('redacts secrets in generic output text', () => {
    const output = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456';
    expect(redactSensitiveText(output)).toContain('Bearer [REDACTED]');
  });
});

describe('captureOutputTail', () => {
  it('keeps only the tail of long output', () => {
    const input = Array.from({ length: 60 }, (_, index) => `line-${index + 1}`).join('\n');
    const tail = captureOutputTail(input);
    expect(tail).toContain('line-60');
    expect(tail).not.toContain('line-1');
  });
});

// ── extractTouchedFiles ────────────────────────────────────────────────

describe('extractTouchedFiles', () => {
  it('returns empty array when no files found', () => {
    expect(extractTouchedFiles('git status')).toEqual([]);
    expect(extractTouchedFiles('ls -la')).toEqual([]);
    expect(extractTouchedFiles('')).toEqual([]);
  });

  it('extracts TypeScript files', () => {
    expect(extractTouchedFiles('tsc src/index.ts')).toEqual(['src/index.ts']);
  });

  it('extracts multiple files', () => {
    const files = extractTouchedFiles('cp src/foo.ts dist/foo.js');
    expect(files).toContain('src/foo.ts');
    expect(files).toContain('dist/foo.js');
  });

  it('extracts various extensions', () => {
    const cmd = 'edit src/app.tsx tests/app.test.ts styles.css config.json README.md';
    const files = extractTouchedFiles(cmd);
    expect(files).toContain('src/app.tsx');
    expect(files).toContain('tests/app.test.ts');
    expect(files).toContain('styles.css');
    expect(files).toContain('config.json');
    expect(files).toContain('README.md');
  });

  it('deduplicates repeated file references', () => {
    const files = extractTouchedFiles('diff src/foo.ts src/foo.ts');
    expect(files).toEqual(['src/foo.ts']);
  });

  it('extracts Go, Rust, Python, Java, C# files', () => {
    expect(extractTouchedFiles('go run main.go')).toContain('main.go');
    expect(extractTouchedFiles('cargo run src/main.rs')).toContain('src/main.rs');
    expect(extractTouchedFiles('python app.py')).toContain('app.py');
    expect(extractTouchedFiles('javac Main.java')).toContain('Main.java');
    expect(extractTouchedFiles('dotnet run Program.cs')).toContain('Program.cs');
  });

  it('extracts yaml/yml/toml/sql/sh files', () => {
    const cmd = 'validate config.yaml schema.yml migrations.sql setup.sh Cargo.toml';
    const files = extractTouchedFiles(cmd);
    expect(files).toContain('config.yaml');
    expect(files).toContain('schema.yml');
    expect(files).toContain('migrations.sql');
    expect(files).toContain('setup.sh');
    expect(files).toContain('Cargo.toml');
  });

  it('preserves order of first appearance', () => {
    const files = extractTouchedFiles('diff a.ts b.ts c.ts');
    expect(files).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});
