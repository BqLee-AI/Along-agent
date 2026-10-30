import { describe, expect, it } from 'bun:test';
import { assertInstallationSchema } from '../local/runtime.mjs';

const targetVersion = '0018';

describe('local installation schema admission', () => {
  it.each(['0016', '0017'])(
    'prepares verified %s only for first-time adoption and still rejects ordinary startup',
    (version) => {
      const state = { kind: 'supported', version, reason: 'explicit_upgrade_required' };
      expect(assertInstallationSchema(state, targetVersion, { adopting: true })).toEqual({
        version,
        targetVersion,
        upgradeRequired: true,
      });

      // Startup/reload and an already-prepared installation's init use the
      // strict default (or explicitly false), not the first-adoption permit.
      for (const options of [{}, { adopting: false }]) {
        let thrown: unknown;
        try {
          assertInstallationSchema(state, targetVersion, options);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code: 'UPGRADE_REQUIRED' });
      }
    },
  );

  it('accepts the verified current target for adoption and ordinary lifecycle actions', () => {
    const state = {
      kind: 'supported',
      version: targetVersion,
      reason: 'target_schema_verified',
    };
    for (const options of [{}, { adopting: false }, { adopting: true }]) {
      expect(assertInstallationSchema(state, targetVersion, options)).toEqual({
        version: targetVersion,
        targetVersion,
        upgradeRequired: false,
      });
    }
  });

  it.each([
    { version: null, reason: 'migration_ledger_missing' },
    { version: '0016', reason: 'migration_ledger_not_contiguous' },
    { version: '0017', reason: 'database_structure_mismatch' },
    { version: '0015', reason: 'unsupported_legacy_database' },
  ])('rejects unknown or partial classifications: $reason', ({ version, reason }) => {
    for (const options of [{}, { adopting: true }]) {
      let thrown: unknown;
      try {
        assertInstallationSchema({ kind: 'unknown', version, reason }, targetVersion, options);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: `DATABASE_${reason.toUpperCase()}` });
    }
  });

  it.each([
    {
      kind: 'unknown',
      reason: 'database_newer_than_artifacts',
      code: 'DATABASE_DATABASE_NEWER_THAN_ARTIFACTS',
    },
    { kind: 'supported', reason: 'target_schema_verified', code: 'UPGRADE_REQUIRED' },
  ])('never admits a future schema, even during adoption: $kind', ({ kind, reason, code }) => {
    for (const options of [{}, { adopting: true }]) {
      let thrown: unknown;
      try {
        assertInstallationSchema({ kind, version: '0019', reason }, targetVersion, options);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code });
    }
  });
});
