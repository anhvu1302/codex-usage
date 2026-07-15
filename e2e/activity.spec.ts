import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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
