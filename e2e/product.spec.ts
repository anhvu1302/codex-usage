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
  await page.getByRole("textbox", { name: "Lọc role agent" }).fill("explorer");
  await page.getByRole("spinbutton", { name: "Lọc depth agent" }).fill("1");
  await expect(page).toHaveURL(/role=explorer/);
  await expect(page).toHaveURL(/depth=1/);
  await expect(page.getByText("Mapper").last()).toBeVisible();

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
