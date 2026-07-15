import { describe, expect, it } from "vitest";

import { assignModelColors } from "@/web/lib/model-colors";

describe("assignModelColors", () => {
  it("is deterministic regardless of input order", () => {
    const first = assignModelColors(["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra"]);
    const second = assignModelColors(["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5"]);

    expect([...first]).toEqual([...second]);
  });

  it("assigns one distinct color to every model in the set", () => {
    const models = Array.from({ length: 1_000 }, (_, index) => `model-${index}`);
    const colors = assignModelColors(models);

    expect(colors).toHaveLength(models.length);
    expect(new Set(colors.values())).toHaveLength(models.length);
  });
});
