import { describe, expect, it } from "vitest";
import { describeApproval, describeCard } from "../src/lib/presentation";
import type { ApprovalDetail, BriefCard } from "../src/lib/types";

describe("D2 display projection", () => {
  const card: BriefCard & { fire_at_utc: string } = {
    card_id: "card_task_1",
    kind: "task",
    schema_version: 1,
    title: "喝水",
    status: "scheduled",
    fire_at_local: "2026-10-17 09:20",
    fire_at_utc: "2026-10-17T01:20:00Z",
    ref: { task_id: "11111111-1111-4111-8111-111111111111" },
  };

  it("changing the UTC instant does not change rendered output", () => {
    const before = describeCard(card);
    const mutated = { ...card, fire_at_utc: "2026-10-17T02:20:00Z" };
    expect(describeCard(mutated)).toEqual(before);
    expect(before.time).toBe("2026-10-17 09:20");
    expect(before.status).toBe("已排期");
  });

  it("keeps approval display off the UTC snapshot", () => {
    const detail: ApprovalDetail = {
      approval_id: "22222222-2222-4222-8222-222222222222",
      kind: "create_task",
      status: "pending",
      echo_text: "请确认：2026-10-17 09:20（Asia/Shanghai）提醒你：喝水。",
      original_text: "明天 9:20 喝水",
      fire_at_local: "2026-10-17 09:20",
      expires_in_seconds: 3600,
      snapshot: {
        fire_at_utc: "2026-10-17T01:20:00Z",
        timezone_id: "Asia/Shanghai",
        fold: 0,
        offset_seconds: 28800,
      },
      presentation_hash: "ph",
      presentation_version: "v1",
      expires_at: "2026-10-18T01:20:00Z",
      recreated_from: null,
    };
    const before = describeApproval(detail);
    const mutated = {
      ...detail,
      snapshot: { ...detail.snapshot, fire_at_utc: "2030-01-01T00:00:00Z" },
    };
    expect(describeApproval(mutated)).toEqual(before);
    expect(before.localTime).toBe("2026-10-17 09:20");
  });

  it("degrades unknown card kinds to the safe title only", () => {
    const view = describeCard({
      card_id: "x",
      kind: "health",
      schema_version: 2,
      title: "健康卡",
      fire_at_local: "2030-01-01 00:00",
    });
    expect(view.time).toBeNull();
    expect(view.href).toBeNull();
    expect(view.warning).toContain("升级");
  });
});
