# infra/migrations

Numbering: `<seq>_<group>_*.sql`; `0001` identity, `0002`
conversation/runs, `0003`+ commitments (one file per table group); later
fixes must add new migrations, never edit merged files. The scan
(`scripts/check-migrations.mjs`) only enforces the `commitments` 0003+ range;
it accepts other groups' legal names/numbers.

Once these files are merged they are frozen. Local databases created before
the merge predate the lower reserved numbers; reset with a fresh volume
(`docker compose down -v`) or re-apply from scratch. No migration runner is
selected yet: `scripts/db/apply.sh` applies files in sorted order via psql.
