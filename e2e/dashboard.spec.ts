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

test("báo cáo hôm nay drilldown theo bucket 5 phút mà không tạo request thừa", async ({ page }) => {
  const today = localDateInHoChiMinh(new Date());
  const yesterday = shiftIsoDate(today, -1);
  let minuteRequests = 0;
  const invalidChartSizeWarnings: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "warning" &&
      message.text().includes("width(") &&
      message.text().includes("height(") &&
      message.text().includes("should be greater than 0")
    ) {
      invalidChartSizeWarnings.push(message.text());
    }
  });
  await page.route("**/api/dashboard/minutes?*", async (route) => {
    minuteRequests += 1;
    expect(new URL(route.request().url()).searchParams.get("date")).toBe(today);
    await route.fulfill({
      contentType: "application/json",
      json: {
        available: true,
        availableDate: today,
        bucketMinutes: 5,
        buckets: [
          {
            cachedInputTokens: 100,
            estimatedCostUsd: 1.25,
            inputTokens: 250,
            minute: "00:00",
            outputTokens: 50,
            reasoningOutputTokens: 20,
            requestCount: 2,
            sessionCount: 1,
            totalTokens: 300,
            unpricedUsageCount: 1,
          },
          {
            cachedInputTokens: 300,
            estimatedCostUsd: 2.5,
            inputTokens: 750,
            minute: "00:05",
            outputTokens: 90,
            reasoningOutputTokens: 45,
            requestCount: 3,
            sessionCount: 2,
            totalTokens: 840,
            unpricedUsageCount: 0,
          },
          {
            cachedInputTokens: 0,
            estimatedCostUsd: 0,
            inputTokens: 0,
            minute: "00:10",
            outputTokens: 0,
            reasoningOutputTokens: 0,
            requestCount: 0,
            sessionCount: 0,
            totalTokens: 0,
            unpricedUsageCount: 0,
          },
        ],
        date: today,
        generatedAt: `${today}T00:12:30.000+07:00`,
        modelCalls: [
          { minute: "00:00", model: "gpt-monitor", requestCount: 2 },
          { minute: "00:05", model: "gpt-monitor", requestCount: 2 },
          { minute: "00:05", model: "gpt-review", requestCount: 1 },
        ],
        timeZone: "Asia/Ho_Chi_Minh",
      },
      status: 200,
    });
  });

  await page.goto(`/?from=${today}&to=${today}`);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const report = page.getByTestId("daily-minute-report");
  await expect(report.getByRole("heading", { name: "Chi tiết 5 phút hôm nay" })).toBeVisible();
  await expect(report.getByTestId("minute-report-detail")).toContainText("Bucket 00:05");
  await expect(report.getByTestId("minute-report-detail")).toContainText("840");
  await expect(report.getByTestId("minute-report-detail")).toContainText("gpt-monitor");
  await expect(report.getByTestId("minute-report-detail")).toContainText("2 lượt");
  await expect(report.getByTestId("minute-report-detail")).toContainText("gpt-review");
  await expect.poll(() => minuteRequests).toBe(1);

  await page
    .getByLabel("Metric biểu đồ")
    .getByRole("button", { exact: true, name: "Cost" })
    .click();
  await expect(report.getByTestId("minute-report-chart")).toHaveAttribute(
    "aria-label",
    /Cost theo bucket 5 phút/,
  );
  await page.waitForTimeout(100);
  expect(minuteRequests).toBe(1);

  const chart = report.getByTestId("minute-report-chart");
  await chart.focus();
  await chart.press("Home");
  await expect(report.getByTestId("minute-report-detail")).toContainText("Bucket 00:00");
  await chart.press("ArrowRight");
  await expect(report.getByTestId("minute-report-detail")).toContainText("Bucket 00:05");

  await report.getByRole("button", { name: "Xem dữ liệu dạng bảng" }).click();
  const table = report.getByRole("table", { name: /Usage hôm nay theo từng bucket 5 phút/ });
  await expect(table.getByRole("row", { name: /00:05/ })).toContainText("$2.50");
  await expect(table.getByRole("row", { name: /00:05/ })).toContainText("840");
  await expect(table.getByRole("row", { name: /00:05/ })).toContainText(
    "gpt-monitor: 2 · gpt-review: 1",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(report).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const accessibility = await new AxeBuilder({ page })
    .include('[data-testid="daily-minute-report"]')
    .analyze();
  expect(accessibility.violations).toEqual([]);
  expect(invalidChartSizeWarnings).toEqual([]);

  await page.goto(`/?from=${yesterday}&to=${yesterday}`);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.getByTestId("daily-minute-report")).toContainText(
    "Chi tiết 5 phút chỉ có cho hôm nay",
  );
  expect(minuteRequests).toBe(1);

  await page.goto(`/?from=${yesterday}&to=${today}`);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.getByTestId("daily-minute-report")).toHaveCount(0);
  expect(minuteRequests).toBe(1);
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

function localDateInHoChiMinh(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value["year"]}-${value["month"]}-${value["day"]}`;
}

function shiftIsoDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
