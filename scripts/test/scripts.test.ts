import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const node = process.execPath;

function run(script: string, target: string): { code: number; output: string } {
  try {
    const output = execFileSync(node, [join(root, 'scripts', script), target], {
      encoding: 'utf8',
    });
    return { code: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('governance scripts', () => {
  it('gate manifest passes on repo root', () => {
    expect(run('check-gate-manifest.mjs', root).code).toBe(0);
  });

  it('gate manifest fails on deferred fixture', () => {
    const target = join(root, 'scripts', 'fixtures', 'gates-deferred-only');
    expect(run('check-gate-manifest.mjs', target).code).toBe(1);
  });

  it('frozen names pass on repo root', () => {
    expect(run('check-frozen-names.mjs', root).code).toBe(0);
  });

  it('frozen names catch fixture violation', () => {
    const target = join(root, 'scripts', 'fixtures', 'frozen-bad-only');
    expect(run('check-frozen-names.mjs', target).code).toBe(1);
  });

  it('copy scan passes on repo root', () => {
    expect(run('scan-copy-claims.mjs', root).code).toBe(0);
  });

  it('copy scan catches fixture violation', () => {
    const target = join(root, 'scripts', 'fixtures', 'copy-bad-only');
    expect(run('scan-copy-claims.mjs', target).code).toBe(1);
  });

  it('copy scan allows negated disclaimers', () => {
    const target = mkdtempSync(join(tmpdir(), 'copy-neg-'));
    writeFileSync(join(target, 'note.md'), '口径只说已记录步骤，不承诺必达，也不保证送达。');
    expect(run('scan-copy-claims.mjs', target).code).toBe(0);
  });

  it('copy scan skips test directories', () => {
    const target = mkdtempSync(join(tmpdir(), 'copy-testdir-'));
    mkdirSync(join(target, 'test'), { recursive: true });
    writeFileSync(join(target, 'test', 'reject.test.ts'), 'const claim = "必达";');
    expect(run('scan-copy-claims.mjs', target).code).toBe(0);
  });

  it('permits exactly account migration 0017 without broadening identity ownership', () => {
    for (const [name, accepted] of [
      ['0017_identity_account_access.sql', true],
      ['0016_identity_account_access.sql', false],
      ['0018_identity_account_access.sql', false],
      ['0017_identity_unapproved_change.sql', false],
    ] as const) {
      const target = mkdtempSync(join(tmpdir(), 'migration-account-'));
      try {
        mkdirSync(join(target, 'infra', 'migrations'), { recursive: true });
        writeFileSync(join(target, 'infra', 'migrations', name), 'BEGIN; COMMIT;');
        expect(run('check-migrations.mjs', target).code === 0).toBe(accepted);
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    }
  });

  it('permits exactly conversation history migration 0018 without broadening ownership', () => {
    for (const [name, accepted] of [
      ['0018_conversation_history.sql', true],
      ['0015_conversation_history.sql', false],
      ['0017_conversation_history.sql', false],
      ['0019_conversation_history.sql', false],
      ['0018_conversation_unapproved_change.sql', false],
    ] as const) {
      const target = mkdtempSync(join(tmpdir(), 'migration-history-'));
      try {
        mkdirSync(join(target, 'infra', 'migrations'), { recursive: true });
        writeFileSync(join(target, 'infra', 'migrations', name), 'BEGIN; COMMIT;');
        expect(run('check-migrations.mjs', target).code === 0).toBe(accepted);
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    }
  });

  it('permits exactly context policy migration 0019 without broadening ownership', () => {
    for (const [name, accepted] of [
      ['0019_conversation_context_policies.sql', true],
      ['0018_conversation_context_policies.sql', false],
      ['0020_conversation_context_policies.sql', false],
      ['0019_conversation_unapproved_change.sql', false],
    ] as const) {
      const target = mkdtempSync(join(tmpdir(), 'migration-context-'));
      try {
        mkdirSync(join(target, 'infra', 'migrations'), { recursive: true });
        writeFileSync(join(target, 'infra', 'migrations', name), 'BEGIN; COMMIT;');
        expect(run('check-migrations.mjs', target).code === 0).toBe(accepted);
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    }
  });
});
