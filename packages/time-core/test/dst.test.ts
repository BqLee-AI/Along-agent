import { describe, expect, it } from "vitest";
import { FIXTURE_V1 } from "../src/fixtures/fixture-v1.js";
import { normalize } from "../src/normalize.js";

function wall(date: string, h: number, mi: number, s: number): string {
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${date}T${p(h)}:${p(mi)}:${p(s)}`;
}

describe("DST full-segment sweeps", () => {
  it("spring 2026-03-08 02:00-02:59 all nonexistent", () => {
    const samples: string[] = [wall("2026-03-08", 2, 0, 0), wall("2026-03-08", 2, 59, 59)];
    for (let m = 0; m < 60; m += 1) samples.push(wall("2026-03-08", 2, m, 30));
    for (const w of samples) {
      const r = normalize(w, "America/New_York", "none", FIXTURE_V1);
      expect(r.kind === "error" ? r.error : "ok").toBe("NONEXISTENT_LOCAL_TIME");
    }
    expect(samples.length).toBeGreaterThan(10);
  });

  it("spring 2027-03-14 02:00-02:59 all nonexistent", () => {
    for (const s of [0, 59]) {
      const r = normalize(wall("2027-03-14", 2, 30, s), "America/New_York", "none", FIXTURE_V1);
      expect(r.kind === "error" ? r.error : "ok").toBe("NONEXISTENT_LOCAL_TIME");
    }
  });

  it("fall 01:30 three states", () => {
    const none = normalize("2026-11-01T01:30:00", "America/New_York", "none", FIXTURE_V1);
    expect(none.kind).toBe("error");
    if (none.kind === "error") {
      expect(none.error).toBe("AMBIGUOUS_LOCAL_TIME");
      expect(none.candidates).toHaveLength(2);
    }
    const first = normalize("2026-11-01T01:30:00", "America/New_York", "first", FIXTURE_V1);
    expect(first).toMatchObject({ kind: "ok", fire_at_utc: "2026-11-01T05:30:00Z", offset_seconds: -14400, fold: 0 });
    const second = normalize("2026-11-01T01:30:00", "America/New_York", "second", FIXTURE_V1);
    expect(second).toMatchObject({ kind: "ok", fire_at_utc: "2026-11-01T06:30:00Z", offset_seconds: -18000, fold: 1 });
  });
});
