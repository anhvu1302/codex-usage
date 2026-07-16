import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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

  await expect(page.getByRole("heading", { name: "Pricing Simulator" })).toBeVisible();
  await page.getByRole("button", { name: "Tính thử" }).click();
  await expect(page.getByRole("region", { name: "Kết quả mô phỏng giá" })).toBeVisible();
  await expect(page.getByText("Cost mô phỏng")).toBeVisible();

  await page.getByRole("combobox", { name: "Dữ liệu" }).click();
  await page.getByRole("option", { name: "Dự án" }).click();
  await page.getByRole("combobox", { name: "Định dạng" }).click();
  await page.getByRole("option", { name: "JSON" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("codex-usage-projects.json");

  await page.getByRole("button", { name: /Thông báo/ }).click();
  await expect(page.getByRole("heading", { name: "Trung tâm thông báo" })).toBeVisible();
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
