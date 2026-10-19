import { describe, expect, it } from "vitest";
import { classifyEntry } from "../src/entry.js";
import { FIXTURE_V1 } from "../src/fixtures/fixture-v1.js";
import { normalize } from "../src/normalize.js";
import { TIME_EXPRESSIONS_V1 } from "./fixtures/time-expressions-v1.js";

describe("M1 50 expressions", () => {
  it("covers all seven doc categories", () => {
    expect(TIME_EXPRESSIONS_V1).toHaveLength(50);
    const counts: Record<string, number> = {};
    for (const row of TIME_EXPRESSIONS_V1) {
      const n = Number(row.expr_id.slice(1));
      const cat = n <= 10 ? "direct" : n <= 16 ? "noyear" : n <= 22 ? "notz" : n <= 28 ? "nodp" : n <= 36 ? "fuzzy" : n <= 42 ? "anchor" : n <= 46 ? "dst" : "alias";
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    expect(counts).toEqual({ direct: 10, noyear: 6, notz: 6, nodp: 6, fuzzy: 8, anchor: 6, dst: 4, alias: 4 });
  });

  it("all 50 rows classify and normalize as expected", () => {
    let okFire = 0;
    let okTotal = 0;
    for (const row of TIME_EXPRESSIONS_V1) {
      const c = classifyEntry({
        text: row.text,
        anchorReceivedAtUtc: row.anchor_received_at_utc,
        receivedAtUtc: row.received_at_utc,
        confirmedTz: row.confirmed_tz,
        fold: row.expect_detail.fold,
        ruleset: FIXTURE_V1,
      });
      expect(c.class, row.expr_id).toBe(row.expect);
      if (row.expect === "normalize_ok") {
        okTotal += 1;
        expect(c.wall_time, row.expr_id).toBe(row.expect_detail.wall_time);
        expect(c.timezone_id, row.expr_id).toBe(row.expect_detail.timezone_id);
        if (!c.wall_time || !c.timezone_id) continue;
        const r = normalize(c.wall_time, c.timezone_id, c.fold ?? "none", FIXTURE_V1);
        if (row.expect_detail.fire_at_utc) {
          expect(r.kind === "ok" ? r.fire_at_utc : r.kind, row.expr_id).toBe(row.expect_detail.fire_at_utc);
          if (r.kind === "ok") {
            okFire += 1;
            expect(r.ruleset_id).toBe("FIXTURE_V1");
          }
        } else {
          // DST rows without fire_at: assert the reject/ambiguity shape.
          expect(r.kind, row.expr_id).toBe("error");
        }
      } else {
        expect(c.reason, row.expr_id).toBe(row.expect_detail.reason);
      }
    }
    expect(okTotal).toBe(22);
    expect(okFire).toBe(19);
  });
});
