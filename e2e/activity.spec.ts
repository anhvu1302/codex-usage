import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { ActivitySummaryResponse, DataHealthResponse } from "../src/shared/types";

test("timeline và data health không tải chart graph", async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname);
  });

  await page.goto("/activity?from=2026-07-12&to=2026-07-12&tab=health");
  await expect(page.getByRole("heading", { name: "Trung tâm sức khoẻ dữ liệu" })).toBeVisible();
  expect(scripts.some((path) => /charts-.+\.js$/.test(path))).toBe(false);
  expect(scripts.some((path) => path.includes("activity-trend-chart"))).toBe(false);

  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page.getByRole("heading", { name: /Session timeline/ })).toBeVisible();
  expect(scripts.some((path) => /charts-.+\.js$/.test(path))).toBe(false);
  expect(scripts.some((path) => path.includes("activity-trend-chart"))).toBe(false);
});

test("filter hoạt động, agent timeline và sức khỏe dữ liệu", async ({ page }) => {
  await page.goto("/activity?from=2026-07-12&to=2026-07-12");

  await expect(page.getByRole("heading", { name: "Hoạt động", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Xu hướng event theo ngày" })).toBeVisible();
  await expect(page.getByRole("grid", { name: /Heatmap activity/ })).toBeVisible();

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
  await expect(page.getByText("Đang nhận cập nhật trực tiếp.")).toBeVisible();

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

test("heatmap đổi Event, Token, Cost không refetch và hỗ trợ bàn phím", async ({ page }) => {
  let summaryRequests = 0;
  const summary: ActivitySummaryResponse = {
    daily: [
      {
        agentKind: "main",
        count: 1,
        date: "2026-07-11",
        kind: "shell",
        projectId: "e2e-project",
      },
      {
        agentKind: "main",
        count: 4,
        date: "2026-07-12",
        kind: "web",
        projectId: "e2e-project",
      },
    ],
    dailyUsage: [
      {
        date: "2026-07-11",
        estimatedCostUsd: 10,
        requestCount: 2,
        totalTokens: 1_000,
        unpricedUsageCount: 0,
      },
      {
        date: "2026-07-12",
        estimatedCostUsd: 30,
        requestCount: 3,
        totalTokens: 100,
        unpricedUsageCount: 1,
      },
    ],
    timelineCoverage: { from: "2026-07-11", status: "full", to: "2026-07-12" },
    timelineTotal: 5,
  };
  await page.route("**/api/activity/summary?**", async (route) => {
    summaryRequests += 1;
    await route.fulfill({ json: summary });
  });

  await page.goto("/activity?from=2026-07-11&to=2026-07-12");
  const heatmap = page.getByTestId("activity-heatmap-card");
  const grid = heatmap.getByRole("grid", { name: /Heatmap activity/ });
  await expect(grid).toBeVisible();
  const firstDay = grid.locator('[data-heatmap-date="2026-07-11"]');
  const secondDay = grid.locator('[data-heatmap-date="2026-07-12"]');
  await expect(firstDay).toHaveAttribute("data-heatmap-level", "1");
  await expect(secondDay).toHaveAttribute("data-heatmap-level", "4");
  const firstDayBox = await firstDay.boundingBox();
  expect(firstDayBox).not.toBeNull();
  expect(firstDayBox?.height).toBeGreaterThanOrEqual(23.5);
  expect(firstDayBox?.width).toBeGreaterThanOrEqual(23.5);
  expect(
    await grid
      .getByRole("gridcell")
      .evaluateAll((cells) =>
        cells
          .filter((cell) => cell.getAttribute("tabindex") === "0")
          .map((cell) => cell.getAttribute("data-heatmap-date")),
      ),
  ).toEqual(["2026-07-12"]);

  await firstDay.hover();
  const detail = page.getByTestId("activity-heatmap-detail");
  await expect(detail).toContainText("11/07/2026");
  await expect(detail).toContainText("1,000");
  await expect(detail).toContainText("$10.00");

  await heatmap.getByRole("button", { name: "Token", exact: true }).click();
  await expect(firstDay).toHaveAttribute("data-heatmap-level", "4");
  await heatmap.getByRole("button", { name: "Cost", exact: true }).click();
  await expect(firstDay).toHaveAttribute("data-heatmap-level", "2");
  await expect.poll(() => summaryRequests).toBe(1);

  await firstDay.focus();
  await page.keyboard.press("ArrowDown");
  await expect(secondDay).toBeFocused();
  await expect(detail).toContainText("12/07/2026");
  await expect(detail).toContainText("1/3 yêu cầu chưa định giá");
  expect(
    await grid
      .getByRole("gridcell")
      .evaluateAll((cells) =>
        cells
          .filter((cell) => cell.getAttribute("tabindex") === "0")
          .map((cell) => cell.getAttribute("data-heatmap-date")),
      ),
  ).toEqual(["2026-07-12"]);

  await heatmap.getByRole("button", { name: "Xem dữ liệu dạng bảng" }).click();
  await expect(
    page.getByRole("row", { name: /11\/07\/2026 1 1,000 \$10\.00 Đầy đủ/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /12\/07\/2026 4 100 \$30\.00 1\/3 chưa định giá/ }),
  ).toBeVisible();

  await page.setViewportSize({ height: 844, width: 390 });
  await heatmap.scrollIntoViewIfNeeded();
  const mobileCardBox = await heatmap.boundingBox();
  const mobileScrollBox = await heatmap.getByTestId("activity-heatmap-scroll").boundingBox();
  expect(mobileCardBox).not.toBeNull();
  expect(mobileScrollBox).not.toBeNull();
  expect(mobileCardBox?.x).toBeGreaterThanOrEqual(0);
  expect((mobileCardBox?.x ?? 0) + (mobileCardBox?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(mobileScrollBox?.width).toBeLessThanOrEqual(mobileCardBox?.width ?? 0);

  const accessibility = await new AxeBuilder({ page })
    .include('[data-testid="activity-heatmap-card"]')
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("kiểm chứng sâu có dialog bàn phím, polling tiến độ và phục hồi lỗi", async ({ page }) => {
  await page.route("**/api/events", (route) => route.abort());
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
  await page.waitForTimeout(2_500);
  expect(deepPolls).toBe(0);
  await expect(page.getByText(/Kiểm chứng sâu · đang đọc JSONL/)).toBeVisible({ timeout: 12_000 });
  await expect(page.getByText("Deep · 4.0 giây", { exact: true })).toBeVisible({ timeout: 5_000 });

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});
