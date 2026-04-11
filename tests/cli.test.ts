import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { createProgram } from '../src/transports/cli.js';

// ── createProgram ─────────────────────────────────────────────────────

describe('createProgram', () => {
  it('returns a valid Commander Command instance', () => {
    const program = createProgram();
    expect(program).toBeInstanceOf(Command);
  });

  it('has the name "cortex"', () => {
    const program = createProgram();
    expect(program.name()).toBe('cortex');
  });

  // ── log subcommand ──────────────────────────────────────────────

  describe('log subcommand', () => {
    it('exists as a subcommand', () => {
      const program = createProgram();
      const names = program.commands.map(c => c.name());
      expect(names).toContain('log');
    });

    it('has a read sub-subcommand', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      expect(log).toBeDefined();
      const subNames = log.commands.map(c => c.name());
      expect(subNames).toContain('read');
    });

    it('has an edit sub-subcommand', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const subNames = log.commands.map(c => c.name());
      expect(subNames).toContain('edit');
    });

    it('has a write sub-subcommand', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const subNames = log.commands.map(c => c.name());
      expect(subNames).toContain('write');
    });

    it('has a cmd sub-subcommand', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const subNames = log.commands.map(c => c.name());
      expect(subNames).toContain('cmd');
    });

    it('has an agent sub-subcommand', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const subNames = log.commands.map(c => c.name());
      expect(subNames).toContain('agent');
    });

    it('log read has --file option', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const read = log.commands.find(c => c.name() === 'read')!;
      const optNames = read.options.map(o => o.long);
      expect(optNames).toContain('--file');
    });

    it('log read has optional --lines option', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const read = log.commands.find(c => c.name() === 'read')!;
      const optNames = read.options.map(o => o.long);
      expect(optNames).toContain('--lines');
    });

    it('log edit has --file option', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const edit = log.commands.find(c => c.name() === 'edit')!;
      const optNames = edit.options.map(o => o.long);
      expect(optNames).toContain('--file');
    });

    it('log write has --file option', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const write = log.commands.find(c => c.name() === 'write')!;
      const optNames = write.options.map(o => o.long);
      expect(optNames).toContain('--file');
    });

    it('log cmd has optional --exit and --cmd options', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const cmd = log.commands.find(c => c.name() === 'cmd')!;
      const optNames = cmd.options.map(o => o.long);
      expect(optNames).toContain('--exit');
      expect(optNames).toContain('--cmd');
    });

    it('log agent has --desc option', () => {
      const program = createProgram();
      const log = program.commands.find(c => c.name() === 'log')!;
      const agent = log.commands.find(c => c.name() === 'agent')!;
      const optNames = agent.options.map(o => o.long);
      expect(optNames).toContain('--desc');
    });
  });

  // ── top-level commands ──────────────────────────────────────────

  it('has inject-header command', () => {
    const program = createProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('inject-header');
  });

  it('has status command', () => {
    const program = createProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('status');
  });

  it('has stats command', () => {
    const program = createProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('stats');
  });

  it('has consolidate command', () => {
    const program = createProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('consolidate');
  });

  it('has serve command', () => {
    const program = createProgram();
    const names = program.commands.map(c => c.name());
    expect(names).toContain('serve');
  });
});
