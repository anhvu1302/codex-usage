import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { DataHealthResponse } from "../src/shared/types";

test("filter hoạt động, agent timeline và sức khỏe dữ liệu", async ({ page }) => {
  await page.goto("/activity?from=2026-07-12&to=2026-07-12");

  await expect(page.getByRole("heading", { name: "Hoạt động", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Xu hướng event theo ngày" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Heatmap activity/ })).toBeVisible();

  await page.getByRole("combobox", { name: "Lọc loại agent" }).click();
  await page.getByRole("option", { name: "Subagent" }).click();
  await expect(page).toHaveURL(/agentKind=subagent/);
  const subagentUrl = page.url();
  await page.goBack();
  await expect(page).not.toHaveURL(/agentKind=subagent/);
  await page.goForward();
  await expect(page).toHaveURL(subagentUrl);

  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page).toHaveURL(/tab=timeline/);
  await expect(page.getByRole("heading", { name: /Session timeline/ })).toBeVisible();
  await expect(page.getByText("Mapper", { exact: true })).toBeVisible();
  await expect(page.getByText(/Subagent · depth 1/)).toBeVisible();

  await page.getByRole("tab", { name: "Sức khỏe dữ liệu" }).click();
  await expect(page).toHaveURL(/tab=health/);
  await expect(page.getByRole("heading", { name: "Trung tâm sức khoẻ dữ liệu" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync ngay" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kiểm chứng sâu" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Compact ngay" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/tab=timeline/);
  await expect(page.getByRole("heading", { name: /Session timeline/ })).toBeVisible();

  await page.goto("/activity?from=2026-07-12&to=2026-07-12&tab=health");
  await expect(page.getByRole("tab", { name: "Sức khỏe dữ liệu" })).toHaveAttribute(
    "data-state",
    "active",
  );

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("kiểm chứng sâu có dialog bàn phím, polling tiến độ và phục hồi lỗi", async ({ page }) => {
  const baselineResponse = await page.request.get("/api/data-health");
  expect(baselineResponse.ok()).toBe(true);
  const baseline = (await baselineResponse.json()) as DataHealthResponse;
  let remainingHealthFailures = 2;
  let deepAccepted = false;
  let deepPolls = 0;

  await page.route("**/api/data-health", async (route) => {
    if (remainingHealthFailures > 0) {
      const delayResponse = remainingHealthFailures === 2;
      remainingHealthFailures -= 1;
      if (delayResponse) await new Promise<void>((resolve) => setTimeout(resolve, 250));
      await route.fulfill({ json: { error: "forced data-health error" }, status: 500 });
      return;
    }

    const sourceScan = structuredClone(baseline.sourceScan);
    if (deepAccepted) {
      deepPolls += 1;
      if (deepPolls === 1) {
        sourceScan.current = null;
        sourceScan.deepQueued = true;
      } else if (deepPolls === 2) {
        sourceScan.current = {
          discoveredFiles: 8,
          filesRead: 3,
          filesSkipped: 0,
          mode: "deep",
          phase: "reading",
          startedAt: "2026-07-15T01:00:00.000Z",
          trigger: "manual",
        };
        sourceScan.deepQueued = false;
      } else {
        sourceScan.current = null;
        sourceScan.deepQueued = false;
        sourceScan.lastCompleted = {
          completedAt: "2026-07-15T01:00:04.000Z",
          discoveredFiles: 8,
          durationMs: 4_000,
          filesRead: 8,
          filesSkipped: 0,
          mode: "deep",
          sourceBytes: 4_096,
          trigger: "manual",
        };
      }
    }
    await route.fulfill({ json: { ...baseline, sourceScan } satisfies DataHealthResponse });
  });
  await page.route("**/api/sync/deep", async (route) => {
    deepAccepted = true;
    deepPolls = 0;
    await route.fulfill({ json: { accepted: true }, status: 202 });
  });

  await page.goto("/activity?from=2026-07-12&to=2026-07-12&tab=health");
  await expect(page.getByLabel("Đang tải sức khỏe dữ liệu")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Không tải được sức khỏe dữ liệu" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(page.getByRole("heading", { name: "Trung tâm sức khoẻ dữ liệu" })).toBeVisible();

  const deepButton = page.getByRole("button", { name: "Kiểm chứng sâu", exact: true });
  await deepButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText(/đọc toàn bộ JSONL từ đầu/)).toBeVisible();
  await expect(page.getByText(/không sửa, di chuyển hay xoá source JSONL/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  await deepButton.focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("button", { name: "Bắt đầu kiểm chứng" });
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Đang chờ kiểm chứng sâu", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Kiểm chứng sâu · đang đọc JSONL/)).toBeVisible({ timeout: 4_000 });
  await expect(page.getByText("Deep · 4.0 giây", { exact: true })).toBeVisible({ timeout: 5_000 });

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});
