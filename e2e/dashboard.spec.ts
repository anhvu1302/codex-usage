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

  await page.getByRole("combobox", { name: "Giao diện" }).click();
  await page.getByRole("option", { name: "Tối" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("combobox", { name: "Mật độ" }).click();
  await page.getByRole("option", { name: "Gọn" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");

  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await expect(page.getByRole("heading", { name: "Tổng quan mức sử dụng" })).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Mở menu điều hướng" }).click();
  await page.getByRole("link", { name: "Phiên" }).click();
  await expect(page.getByRole("heading", { name: "Khám phá phiên" })).toBeVisible();
  await expect(page.getByRole("button", { name: /E2E dashboard task/ }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Bảng danh sách session" })).toHaveCount(0);
});
