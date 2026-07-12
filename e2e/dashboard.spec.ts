import { expect, test } from "@playwright/test";

test("renders the dashboard, sync action, and rate card settings", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Token usage" })).toBeVisible();
  await expect(page.getByText("Total tokens")).toBeVisible();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText(/Đã sync/)).toBeVisible();
  await page.getByRole("button", { name: "Hôm nay" }).click();
  await expect(page.getByRole("heading", { name: "Usage theo giờ" })).toBeVisible();

  await page.getByRole("tab", { name: "Rate cards" }).click();
  await expect(page.getByRole("heading", { name: "Rate cards" })).toBeVisible();

  await page.getByRole("tab", { name: "Dashboard" }).click();
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "gpt-e2e" }).click();
  await expect(page.getByRole("combobox")).toHaveText("gpt-e2e");
  await expect(page.getByText("gpt-e2e").first()).toBeVisible();

  await page.getByText("E2E dashboard task").click();
  const sessionSheet = page.getByRole("dialog", { name: "E2E dashboard task" });
  await expect(sessionSheet.getByRole("heading", { name: "Agent breakdown" })).toBeVisible();
  await expect(sessionSheet.getByText("Mapper", { exact: true })).toBeVisible();
  await expect(sessionSheet.getByText("Map the dashboard source")).toBeVisible();
});
