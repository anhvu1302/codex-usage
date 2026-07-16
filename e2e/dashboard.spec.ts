import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("điều hướng dashboard, filter, settings và session bằng bàn phím", async ({ page }) => {
  await page.goto("/");
  await page.request.put("/api/rates/gpt-e2e", {
    data: { cachedInputRate: 0.5, inputRate: 2, outputRate: 4 },
  });
  await page.reload();

  await expect(page.getByRole("heading", { name: "Tổng quan mức sử dụng" })).toBeVisible();
  await expect(page.getByText("Tổng token")).toBeVisible();
  await page.getByRole("heading", { name: "Usage theo ngày" }).scrollIntoViewIfNeeded();
  await expect(page.locator(".recharts-bar-rectangle path").first()).toBeVisible();
  await page.locator(".recharts-bar-rectangle path").first().hover();
  await expect(page.getByText(/Tổng token:/)).toBeVisible();
  const metricToggle = page.locator('[aria-label="Metric biểu đồ"]');
  await metricToggle.getByRole("button", { exact: true, name: "Cost" }).click();
  await page.locator(".recharts-bar-rectangle path").first().hover();
  await expect(page.getByText(/Tổng cost:/)).toBeVisible();
  await expect(page.getByText(/gpt-e2e:/).first()).toBeVisible();
  await metricToggle.getByRole("button", { exact: true, name: "Yêu cầu" }).click();
  await page.locator(".recharts-bar-rectangle path").first().hover();
  await expect(page.getByText(/Tổng yêu cầu:/)).toBeVisible();
  await page.getByRole("button", { name: "Xem dữ liệu dạng bảng" }).first().click();
  const requestFallback = page.getByRole("table", {
    name: /Yêu cầu theo ngày và từng model/,
  });
  await expect(requestFallback).toBeAttached();
  await expect(requestFallback.getByRole("row", { name: /gpt-e2e/ }).first()).toBeAttached();
  await metricToggle.getByRole("button", { exact: true, name: "Token" }).click();

  await page.getByRole("button", { name: "Sync ngay" }).click();
  await expect(page.getByText(/Đã sync/)).toBeVisible();
  await page.getByRole("button", { name: "Hôm nay", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Usage theo giờ" })).toBeVisible();
  await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  const todayUrl = page.url();
  await page.getByRole("button", { name: "30 ngày", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Usage theo giờ" })).toBeHidden();
  const thirtyDayUrl = page.url();
  await page.goBack();
  await expect(page).toHaveURL(todayUrl);
  await expect(page.getByRole("heading", { name: "Usage theo giờ" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(thirtyDayUrl);
  await expect(page.getByRole("heading", { name: "Usage theo giờ" })).toBeHidden();

  await page.getByRole("link", { name: "Cài đặt" }).click();
  await expect(page.getByRole("heading", { name: "Cài đặt" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bảng giá model" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chính sách lưu trữ" })).toBeVisible();
  await page.getByRole("button", { name: "Compact ngay" }).click();
  await expect(page.getByText(/Đã compact/)).toBeVisible();

  await page.getByRole("link", { name: "Tổng quan" }).click();
  const modelFilter = page.getByRole("button", { name: "Lọc theo model" });
  await modelFilter.click();
  await page
    .locator("[data-radix-popper-content-wrapper]")
    .getByRole("button", { exact: true, name: "gpt-e2e" })
    .click();
  await expect(modelFilter).toHaveText("gpt-e2e");
  await expect(page).toHaveURL(/models=gpt-e2e/);

  const sessionButton = page.getByRole("button", { name: /E2E dashboard task/ }).first();
  await sessionButton.focus();
  await sessionButton.press("Enter");
  const sessionSheet = page.getByRole("dialog", { name: "E2E dashboard task" });
  await expect(sessionSheet.getByRole("heading", { name: "Chi tiết agent" })).toBeVisible();
  await expect(sessionSheet.getByText("Mapper", { exact: true })).toBeVisible();
  await expect(sessionSheet.getByText("Map the dashboard source")).toBeVisible();
});

test("theme, density, mobile navigation và accessibility", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("combobox", { name: "Giao diện" }).selectOption("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("combobox", { name: "Mật độ" }).selectOption("compact");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");

  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await expect(page.getByRole("heading", { name: "Tổng quan mức sử dụng" })).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  const metricCards = page.locator(".metric-card");
  await expect(metricCards).toHaveCount(8);
  const firstMetric = await metricCards.nth(0).boundingBox();
  const secondMetric = await metricCards.nth(1).boundingBox();
  expect(Math.abs((firstMetric?.y ?? 0) - (secondMetric?.y ?? 0))).toBeLessThan(1);
  expect(firstMetric?.x).not.toBe(secondMetric?.x);
  const presetRail = page.getByLabel("Khoảng thời gian").first();
  const selectedPreset = presetRail.getByRole("button", { exact: true, name: "30 ngày" });
  await expect(selectedPreset).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Mở menu điều hướng" }).click();
  await page.getByRole("link", { name: "Phiên" }).click();
  await expect(page.getByRole("heading", { name: "Khám phá phiên" })).toBeVisible();
  await expect(page.getByRole("button", { name: /E2E dashboard task/ }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Bảng danh sách session" })).toHaveCount(0);
});

test("request graph theo route không tải dữ liệu hoặc chart thừa", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));

  await page.goto("/sessions?from=2026-07-12&to=2026-07-12");
  await expect(page.getByRole("heading", { name: "Khám phá phiên" })).toBeVisible();
  expect(requests.filter((path) => path === "/api/dashboard" || path === "/api/overview")).toEqual(
    [],
  );
  expect(requests.filter((path) => /charts-.+\.js$/.test(path))).toEqual([]);
  expect(requests).toContain("/api/sessions/summary");
  expect(requests).toContain("/api/projects/options");
  expect(requests).not.toContain("/api/projects");
  expect(requests.filter((path) => path === "/api/sessions/summary")).toHaveLength(1);
  expect(requests.filter((path) => path === "/api/projects/options")).toHaveLength(1);

  requests.length = 0;
  await page.getByRole("link", { name: "Khám phá" }).click();
  await expect(page.getByRole("heading", { name: "Khám phá mức sử dụng" })).toBeVisible();
  expect(requests).not.toContain("/api/sessions");
  expect(requests).not.toContain("/api/sessions/summary");
});

test("SSE scoped refresh, reconnect và fallback không tạo request wave", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    type TestEventSource = EventTarget & {
      onerror: ((event: Event) => void) | null;
      onopen: ((event: Event) => void) | null;
    };
    const sources: TestEventSource[] = [];
    class FakeEventSource extends EventTarget {
      onerror: ((event: Event) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;

      constructor() {
        super();
        sources.push(this);
        window.setTimeout(() => this.onopen?.(new Event("open")), 0);
      }

      close() {
        return undefined;
      }
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
    Reflect.set(
      window,
      "__emitTestRevision",
      (revision: number, reconnect: boolean, scopes?: string[]) => {
        const source = sources.at(-1);
        if (!source) throw new Error("Missing fake EventSource");
        if (reconnect) {
          source.onerror?.(new Event("error"));
          source.onopen?.(new Event("open"));
        }
        source.dispatchEvent(
          new MessageEvent("revision", {
            data: JSON.stringify({ reason: "import", revision, ...(scopes ? { scopes } : {}) }),
          }),
        );
      },
    );
    Reflect.set(window, "__emitTestScan", (isSyncing = false) => {
      const source = sources.at(-1);
      if (!source) throw new Error("Missing fake EventSource");
      source.dispatchEvent(
        new MessageEvent("scan", {
          data: JSON.stringify({
            error: null,
            filesProcessed: 1,
            isSyncing,
            lastSyncAt: "2026-07-16T05:00:00.000Z",
            recordsBackfilled: 0,
            recordsInserted: 0,
            recordsReclassified: 0,
            sourceScan: {
              current: null,
              deepQueued: false,
              lastCompleted: null,
              nextScheduledAt: null,
            },
            turnBackfill: {
              attributionVersion: 1,
              costAttributionMissingCount: 0,
              error: null,
              filesProcessed: 0,
              isRunning: false,
              lastRunAt: null,
              sourceDeletedGaps: 0,
              totalFiles: 0,
            },
          }),
        }),
      );
    });
    Reflect.set(window, "__failTestEventSource", () => {
      const source = sources.at(-1);
      if (!source) throw new Error("Missing fake EventSource");
      source.onerror?.(new Event("error"));
    });
  });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  const emitRevision = (revision: number, reconnect: boolean, scopes?: string[]) =>
    page.evaluate(
      ({ reconnect, revision, scopes }) => {
        const emit = Reflect.get(window, "__emitTestRevision") as (
          revision: number,
          reconnect: boolean,
          scopes?: string[],
        ) => void;
        emit(revision, reconnect, scopes);
      },
      { reconnect, revision, scopes },
    );
  const emitScan = (isSyncing = false) =>
    page.evaluate((syncing) => {
      const emit = Reflect.get(window, "__emitTestScan") as (isSyncing?: boolean) => void;
      emit(syncing);
    }, isSyncing);
  const failEventSource = () =>
    page.evaluate(() => {
      const fail = Reflect.get(window, "__failTestEventSource") as () => void;
      fail();
    });

  await page.goto("/sessions?from=2026-07-12&to=2026-07-12");
  await expect(page.getByRole("heading", { name: "Khám phá phiên" })).toBeVisible();
  await emitRevision(5, false);
  requests.length = 0;

  await emitRevision(5, true);
  await page.waitForTimeout(350);
  expect(requests.filter((path) => path === "/api/sessions/summary")).toHaveLength(0);

  await emitRevision(6, true);
  await expect
    .poll(() => requests.filter((path) => path === "/api/sessions/summary").length)
    .toBe(1);
  requests.length = 0;

  await emitRevision(1, true);
  await expect
    .poll(() => requests.filter((path) => path === "/api/sessions/summary").length)
    .toBe(1);

  await page.goto("/?from=2026-07-12&to=2026-07-12");
  await expect(page.getByRole("heading", { name: "Tổng quan mức sử dụng" })).toBeVisible();
  requests.length = 0;
  await emitRevision(2, false, ["activity", "data-health", "turns"]);
  await page.waitForTimeout(2_200);
  expect(requests.filter((path) => path === "/api/overview")).toHaveLength(0);
  expect(requests.filter((path) => path === "/api/sessions/summary")).toHaveLength(0);
  expect(requests.filter((path) => path === "/api/models")).toHaveLength(0);
  expect(requests.filter((path) => path === "/api/projects/options")).toHaveLength(0);
  expect(requests.filter((path) => path === "/api/alerts")).toHaveLength(0);
  expect(requests.filter((path) => path === "/api/status")).toHaveLength(0);

  requests.length = 0;
  await emitScan();
  await page.waitForTimeout(200);
  expect(requests.filter((path) => path === "/api/status")).toHaveLength(0);

  requests.length = 0;
  for (let revision = 3; revision <= 22; revision += 1) {
    await emitRevision(revision, false, ["catalog", "dashboard", "sessions"]);
  }
  await page.waitForTimeout(2_200);
  expect(requests.filter((path) => path === "/api/overview")).toHaveLength(1);
  expect(requests.filter((path) => path === "/api/models")).toHaveLength(1);
  expect(requests.filter((path) => path === "/api/projects/options")).toHaveLength(1);
  expect(requests.filter((path) => path === "/api/alerts")).toHaveLength(0);

  const statusResponse = await page.request.get("/api/status");
  expect(statusResponse.ok()).toBe(true);
  const status = await statusResponse.json();
  await page.route("**/api/sync", async (route) => {
    await route.fulfill({ json: { ...status, recordsInserted: 1 }, status: 200 });
  });
  requests.length = 0;
  await page.getByRole("button", { name: "Sync ngay" }).click();
  await expect(page.getByText(/Đã sync .*thêm 1 usage event/)).toBeVisible();
  await emitRevision(23, false, ["catalog", "dashboard", "sessions"]);
  await page.waitForTimeout(2_200);
  expect(requests.filter((path) => path === "/api/overview")).toHaveLength(1);
  expect(requests.filter((path) => path === "/api/models")).toHaveLength(1);
  expect(requests.filter((path) => path === "/api/projects/options")).toHaveLength(1);

  await emitScan(true);
  requests.length = 0;
  await failEventSource();
  await page.waitForTimeout(3_000);
  expect(requests.filter((path) => path === "/api/status")).toHaveLength(0);
  await expect
    .poll(() => requests.filter((path) => path === "/api/status").length, { timeout: 12_000 })
    .toBeGreaterThan(0);

  await emitScan(true);
  await emitRevision(23, true);
  requests.length = 0;
  await page.waitForTimeout(2_500);
  expect(requests.filter((path) => path === "/api/status")).toHaveLength(0);
});
