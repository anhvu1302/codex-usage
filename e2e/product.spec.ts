import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { AlertEvent } from "../src/shared/types";

test("projects, agents và insights dùng đúng filter", async ({ page }) => {
  await page.goto("/?from=2026-07-12&to=2026-07-12");
  await expect(page.getByRole("heading", { name: "Phân tích" })).toBeVisible();
  await expect(page.getByText("Dự phóng tháng")).toBeVisible();

  await page.getByRole("link", { name: "Dự án" }).click();
  await expect(page.getByRole("heading", { name: "Dự án", exact: true })).toBeVisible();
  await expect(page.getByText("/workspace/e2e").last()).toBeVisible();
  await expect(page.getByRole("heading", { name: /Xu hướng/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Task tốn nhiều nhất" })).toBeVisible();
  await expect(page.getByTestId("project-table")).toHaveCount(1);
  await expect(page.getByTestId("project-cards")).toHaveCount(0);

  await page
    .getByRole("button", { name: /Đổi alias/ })
    .last()
    .click();
  await page.getByRole("textbox", { name: "Alias project" }).fill("E2E Workspace");
  await page.getByRole("button", { name: "Lưu alias" }).click();
  await expect(page.getByText("Đã đổi alias project.")).toBeVisible();
  await expect(page.getByText("E2E Workspace").last()).toBeVisible();

  await page.getByRole("link", { name: "Agent" }).click();
  await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Main vs subagent" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent leaderboard" })).toBeVisible();
  await expect(page.getByTestId("agent-table")).toHaveCount(1);
  await expect(page.getByTestId("agent-cards")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Lọc role agent" }).fill("explorer");
  await page.getByRole("spinbutton", { name: "Lọc depth agent" }).fill("1");
  await expect(page).toHaveURL(/role=explorer/);
  await expect(page).toHaveURL(/depth=1/);
  await expect(page.getByText("Mapper").last()).toBeVisible();

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(page.getByTestId("agent-table")).toHaveCount(0);
  await expect(page.getByTestId("agent-cards")).toHaveCount(1);
  await page.goto("/projects?from=2026-07-12&to=2026-07-12");
  await expect(page.getByTestId("project-table")).toHaveCount(0);
  await expect(page.getByTestId("project-cards")).toHaveCount(1);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("budget, notification, pricing simulator và export", async ({ page }) => {
  await page.goto("/settings?from=2026-07-12&to=2026-07-12");

  await expect(page.getByRole("heading", { name: "Budget và ngưỡng cảnh báo" })).toBeVisible();
  await page.getByLabel("Giới hạn USD").first().fill("10");
  await page.getByLabel("Ngưỡng cảnh báo (%)").first().fill("50, 80, 100");
  await page.getByRole("button", { name: "Lưu budget" }).first().click();
  await expect(page.getByText(/Đã lưu budget/)).toBeVisible();

  await page.getByRole("combobox", { name: "Chọn project budget" }).click();
  await page.getByRole("option").first().click();
  await expect(page.getByText("Budget theo project")).toBeVisible();
  await page.getByRole("checkbox").nth(2).check();
  await page.getByLabel("Giới hạn USD").nth(2).fill("1");
  await page.getByLabel("Ngưỡng cảnh báo (%)").nth(2).fill("50, 100");
  await page.getByRole("button", { name: "Lưu budget" }).nth(2).click();
  await expect(page.getByText(/Đã lưu budget/).last()).toBeVisible();

  await expect(page.getByRole("heading", { name: "Pricing Simulator" })).toBeVisible();
  await page.getByRole("button", { name: "Tính thử" }).click();
  await expect(page.getByRole("region", { name: "Kết quả mô phỏng giá" })).toBeVisible();
  await expect(page.getByText("Cost mô phỏng")).toBeVisible();

  await page.getByRole("combobox", { name: "Dữ liệu" }).click();
  await page.getByRole("option", { name: "Dự án" }).click();
  await page.getByRole("combobox", { exact: true, name: "Định dạng" }).click();
  await page.getByRole("option", { name: "JSON" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("codex-usage-projects.json");

  await page.getByRole("button", { name: /Thông báo/ }).click();
  await expect(page.getByRole("heading", { name: "Trung tâm thông báo" })).toBeVisible();
});

test("Report Builder preview và export CSV/JSON với xác nhận privacy", async ({ page }) => {
  await page.goto("/settings?from=2026-07-12&to=2026-07-12");
  await expect(page.getByRole("heading", { name: "Report Builder" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Privacy preview" })).toBeVisible();

  await page.getByRole("combobox", { name: "Chọn preset report" }).click();
  await page.getByRole("option", { name: "Tổng hợp project" }).click();
  const projectName = page.getByRole("checkbox", { name: /Tên project/ });
  await expect(projectName).toBeVisible();
  await projectName.check();
  await expect(page.getByText(/Tạo lại preview trước khi export/)).toBeVisible();
  await page.getByRole("button", { name: "Tạo preview" }).click();

  const warning = page.getByTestId("report-privacy-warning");
  await expect(warning).toContainText("Tên project");
  const exportButton = page.getByRole("button", { name: "Xuất report" });
  await expect(exportButton).toBeDisabled();
  await warning.getByRole("checkbox", { name: /Tôi hiểu file/ }).check();
  await expect(exportButton).toBeEnabled();

  await page.getByRole("combobox", { name: "Chọn định dạng report" }).click();
  await page.getByRole("option", { name: "JSON" }).click();
  const jsonDownloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const jsonDownload = await jsonDownloadPromise;
  expect(jsonDownload.suggestedFilename()).toBe("codex-usage-project-summary.json");

  await page.getByRole("combobox", { name: "Chọn định dạng report" }).click();
  await page.getByRole("option", { name: "CSV" }).click();
  const csvDownloadPromise = page.waitForEvent("download");
  await exportButton.click();
  const csvDownload = await csvDownloadPromise;
  expect(csvDownload.suggestedFilename()).toBe("codex-usage-project-summary.csv");

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(page.getByTestId("report-preview-cards")).toBeVisible();
  const accessibility = await new AxeBuilder({ page })
    .include('[data-testid="report-builder"]')
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("Report Builder hiển thị empty và error state", async ({ page }) => {
  let mode: "empty" | "error" = "empty";
  await page.route("**/api/reports/preview", async (route) => {
    if (mode === "error") {
      await route.fulfill({
        contentType: "application/json",
        json: { error: "Preview fixture failed" },
        status: 500,
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: {
        acknowledgementMatches: true,
        availableColumns: [
          {
            id: "date",
            label: "Ngày",
            selectedByDefault: true,
            sensitive: false,
          },
        ],
        coverage: {
          aggregate: "full",
          detail: { from: "2026-07-12", status: "full", to: "2026-07-12" },
        },
        resolvedColumns: [
          {
            id: "date",
            label: "Ngày",
            selectedByDefault: true,
            sensitive: false,
          },
        ],
        rowCount: { kind: "exact", value: 0 },
        rows: [],
        sensitiveWarning: null,
      },
    });
  });

  await page.goto("/settings?from=2026-07-12&to=2026-07-12");
  await expect(page.getByTestId("report-empty-state")).toBeVisible();
  mode = "error";
  await page.getByRole("button", { name: "Tạo preview" }).click();
  await expect(page.getByRole("alert")).toContainText("Không thể tạo preview");
  await expect(page.getByRole("alert")).toContainText("Preview fixture failed");
});

test("quản lý, gán và lọc project bằng tag xuyên dashboard/activity", async ({ page }) => {
  await page.goto("/settings?from=2026-07-12&to=2026-07-12");
  await page.getByLabel("Tên tag mới").fill("E2E Focus");
  await page.getByRole("button", { name: "Tạo tag" }).click();
  await expect(page.getByText("Đã tạo tag.")).toBeVisible();

  await page.goto("/projects?from=2026-07-12&to=2026-07-12");
  await page
    .getByRole("button", { name: /^Gán tag / })
    .first()
    .click();
  const assignment = page.getByRole("dialog", { name: /Gán tag/ });
  await assignment.getByLabel("E2E Focus").check();
  const dialogAccessibility = await new AxeBuilder({ page }).analyze();
  expect(dialogAccessibility.violations).toEqual([]);
  await assignment.getByRole("button", { name: "Lưu tag" }).click();
  await expect(page.getByText("Đã cập nhật tag cho project.")).toBeVisible();
  await expect(page.getByText("E2E Focus").first()).toBeVisible();

  await page.getByRole("button", { name: "Lọc theo tag" }).click();
  await page
    .getByRole("button", { name: /E2E Focus/ })
    .last()
    .click();
  await expect(page).toHaveURL(/tags=[0-9a-f-]+/);
  const tagId = new URL(page.url()).searchParams.get("tags");
  expect(tagId).toMatch(/^[0-9a-f-]+$/);
  await expect(page.getByTestId("project-table").locator("tbody tr")).toHaveCount(1);

  await page.goto(`/?from=2026-07-12&to=2026-07-12&tags=${tagId}`);
  await expect(page.getByRole("heading", { name: "Phân tích" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lọc theo tag" })).toContainText("E2E Focus");

  await page.goto(`/activity?from=2026-07-12&to=2026-07-12&tags=${tagId}`);
  await expect(page.getByRole("heading", { name: "Hoạt động", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lọc theo tag" })).toContainText("E2E Focus");

  await page.goto("/settings?from=2026-07-12&to=2026-07-12");
  await page.getByRole("button", { name: "Xoá tag E2E Focus" }).click();
  const confirmation = page.getByRole("dialog", { name: "Xoá tag?" });
  await confirmation.getByRole("button", { name: "Xoá tag" }).click();
  await expect(page.getByText("Đã xoá tag và các gán liên quan.")).toBeVisible();
});

test("notification tự đánh dấu đã đọc khi xem turn và hỗ trợ xóa tất cả", async ({ page }) => {
  const turnKey = "a".repeat(64);
  let alerts: AlertEvent[] = [notificationFixture("alert-turn", { turnKey })];
  const seenActions: string[] = [];
  let deleteRequests = 0;
  await page.route("**/api/alerts**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/alerts" && request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        json: { alerts, unseenCount: alerts.filter((alert) => alert.seenAt === null).length },
      });
      return;
    }
    if (path === "/api/alerts" && request.method() === "DELETE") {
      deleteRequests += 1;
      const dismissedCount = alerts.length;
      alerts = [];
      await route.fulfill({ contentType: "application/json", json: { dismissedCount } });
      return;
    }
    if (request.method() === "PATCH") {
      const id = decodeURIComponent(path.split("/").at(-1) ?? "");
      const body = request.postDataJSON() as { action?: string };
      if (body.action === "seen") seenActions.push(id);
      const alert = alerts.find((value) => value.id === id);
      if (!alert) {
        await route.fulfill({
          contentType: "application/json",
          json: { error: "missing" },
          status: 404,
        });
        return;
      }
      const updated = {
        ...alert,
        ...(body.action === "dismiss"
          ? { dismissedAt: new Date().toISOString() }
          : { seenAt: new Date().toISOString() }),
      };
      alerts =
        body.action === "dismiss"
          ? alerts.filter((value) => value.id !== id)
          : alerts.map((value) => (value.id === id ? updated : value));
      await route.fulfill({ contentType: "application/json", json: { alert: updated } });
      return;
    }
    await route.continue();
  });

  await page.goto("/?from=2026-07-12&to=2026-07-12");
  await page.getByRole("button", { name: "Thông báo: 1 chưa đọc" }).click();
  await page.getByRole("button", { name: "Xem turn" }).click();
  await expect.poll(() => seenActions).toEqual(["alert-turn"]);
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/turns/${turnKey}`);
  await expect(page.getByRole("button", { name: "Thông báo", exact: true })).toBeVisible();

  alerts = [notificationFixture("alert-one"), notificationFixture("alert-two")];
  await page.goto("/?from=2026-07-12&to=2026-07-12");
  await page.getByRole("button", { name: "Thông báo: 2 chưa đọc" }).click();
  await page.getByRole("button", { name: "Xóa tất cả" }).click();
  const confirmation = page.getByRole("dialog", { name: "Xóa tất cả thông báo?" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Xóa tất cả" }).click();
  await expect.poll(() => deleteRequests).toBe(1);
  await expect(page.getByText("Chưa có cảnh báo")).toBeVisible();
  await page.getByRole("button", { name: "Đóng" }).click();
  await expect(page.getByRole("button", { name: "Thông báo", exact: true })).toBeVisible();
  await expect(page.getByText("Đã xóa 2 thông báo.")).toBeHidden();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("role và turn text filters debounce thành một request cuối", async ({ page }) => {
  await page.route("**/api/events", (route) => route.abort());
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requests.push(`${url.pathname}${url.search}`);
  });

  await page.goto("/agents?from=2026-07-12&to=2026-07-12");
  await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible();
  requests.length = 0;
  await page
    .getByRole("textbox", { name: "Lọc role agent" })
    .pressSequentially("multi role", { delay: 15 });
  await expect(page).toHaveURL(/role=multi(?:\+|%20)role/);
  await page.waitForTimeout(350);
  expect(requests.filter((url) => url.startsWith("/api/agents/summary?"))).toHaveLength(1);
  expect(requests.filter((url) => url.startsWith("/api/agents/page?"))).toHaveLength(1);
  expect(requests.filter((url) => url.startsWith("/api/projects/options?"))).toHaveLength(0);

  await page.goto(`/turns?from=2026-07-12&to=2026-07-12`);
  await expect(page.getByRole("heading", { level: 1, name: "Turns", exact: true })).toBeVisible();
  requests.length = 0;
  await page.getByRole("textbox", { name: "Tìm turn" }).pressSequentially("dashboard", {
    delay: 15,
  });
  await page.getByRole("textbox", { name: "Reasoning effort" }).fill("high");
  await expect(page).toHaveURL(/q=dashboard/);
  await expect(page).toHaveURL(/effort=high/);
  await page.waitForTimeout(350);
  expect(requests.filter((url) => url.startsWith("/api/turns?"))).toHaveLength(1);
});

test("lưu, mở và xóa Saved View mà không giữ state tạm thời", async ({ page }) => {
  const tagId = "11111111-1111-4111-8111-111111111111";
  await page.goto(
    `/turns?from=2026-07-12&to=2026-07-12&project=project-e2e&q=dashboard&sort=cost&page=4&ids=one,two&tags=${tagId}`,
  );
  await page.getByRole("button", { name: "Lưu view hiện tại" }).click();
  const saveDialog = page.getByRole("dialog", { name: "Lưu view hiện tại" });
  await saveDialog.getByLabel("Tên view").fill("Cost watch");
  await saveDialog.getByRole("button", { name: "Lưu view" }).click();
  await expect(page.getByText("Đã lưu view hiện tại.")).toBeVisible();

  await page.goto("/");
  await page.getByRole("button", { name: "Saved Views: 1" }).click();
  await page.getByRole("button", { name: /^Cost watch \/turns/ }).click();
  await expect(page).toHaveURL(/\/turns\?/);
  await expect(page).toHaveURL(/project=project-e2e/);
  await expect(page).toHaveURL(/q=dashboard/);
  await expect(page).toHaveURL(/sort=cost/);
  await expect(page).toHaveURL(new RegExp(`tags=${tagId}`));
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
  expect(new URL(page.url()).searchParams.has("ids")).toBe(false);

  await page.getByRole("button", { name: "Saved Views: 1" }).click();
  await page.getByRole("button", { name: "Xoá Cost watch" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Xoá Saved View?" });
  await deleteDialog.getByRole("button", { name: "Xoá view" }).click();
  await expect(page.getByText("Đã xoá Saved View.")).toBeVisible();
  await page.getByRole("button", { name: "Saved Views" }).click();
  await expect(page.getByText("Chưa có view nào được lưu.")).toBeVisible();
});

test("browser notification chỉ gửi alert mới sau khi opt-in", async ({ page }) => {
  await page.addInitScript(() => {
    const notifications: { body: string; title: string }[] = [];
    Object.defineProperty(window, "__browserNotifications", {
      configurable: true,
      value: notifications,
    });
    class MockNotification {
      static get permission(): NotificationPermission {
        return (window.localStorage.getItem("e2e-notification-permission") ??
          "default") as NotificationPermission;
      }

      static requestPermission(): Promise<NotificationPermission> {
        window.localStorage.setItem("e2e-notification-permission", "granted");
        return Promise.resolve("granted");
      }

      onclick: (() => void) | null = null;

      constructor(title: string, options?: NotificationOptions) {
        notifications.push({ body: options?.body ?? "", title });
      }

      close() {
        return undefined;
      }
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: MockNotification,
    });
  });

  let alerts: AlertEvent[] = [notificationFixture("existing-alert")];
  let seenMutations = 0;
  await page.route("**/api/alerts**", async (route) => {
    if (route.request().method() !== "GET") {
      seenMutations += 1;
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: { alerts, unseenCount: alerts.length },
    });
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Bật thông báo" }).click();
  await expect(page.getByText("Đã bật browser notification.")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __browserNotifications: unknown[] }).__browserNotifications
          .length,
    ),
  ).toBe(0);

  alerts = [
    ...alerts,
    {
      ...notificationFixture("new-alert"),
      createdAt: new Date(Date.now() + 60_000).toISOString(),
    },
  ];
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __browserNotifications: unknown[] }).__browserNotifications
            .length,
      ),
    )
    .toBe(1);
  expect(seenMutations).toBe(0);
});

function notificationFixture(id: string, options: { turnKey?: string | null } = {}): AlertEvent {
  return {
    createdAt: "2026-07-16T08:00:00.000Z",
    dismissedAt: null,
    id,
    message: "Thông báo kiểm thử không chứa dữ liệu nhạy cảm.",
    periodStart: "2026-07-16",
    seenAt: null,
    severity: "warning",
    title: "Cảnh báo kiểm thử",
    turnKey: options.turnKey ?? null,
    type: options.turnKey ? "context-pressure" : "anomaly",
  };
}
