import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const TURN_RANGE = "from=2026-07-12&to=2026-07-12";

test.beforeEach(async ({ page }) => {
  await page.request.put("/api/rates/gpt-e2e", {
    data: { cachedInputRate: 0.5, inputRate: 2, outputRate: 4 },
  });
});

test("mở deep link, xem timeline, quay lại và so sánh 4 turns", async ({ page }) => {
  await page.goto(`/turns?${TURN_RANGE}`);

  await expect(page.getByRole("heading", { level: 1, name: "Turns" })).toBeVisible();
  await expect(page.getByText("5 turn", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Danh sách turns" })).toBeVisible();

  const firstTurn = page.getByRole("button", { name: /^E2E dashboard task .* Turn/ }).first();
  await firstTurn.focus();
  await firstTurn.press("Enter");
  await expect(page).toHaveURL(/\/turns\/[a-f0-9]{64}/);

  const detail = page.getByRole("dialog");
  await expect(detail.getByRole("heading", { name: /E2E dashboard task/ })).toBeVisible();
  await expect(detail.getByRole("tab", { name: "Tổng quan" })).toBeVisible();
  await detail.getByRole("tab", { name: "Timeline" }).click();
  await expect(detail.getByText(/gpt-e2e .* token/).first()).toBeVisible();
  await detail.getByRole("tab", { name: "Cây agent" }).click();
  await expect(detail.getByText(/cây thread của session/i)).toBeVisible();
  await expect(detail.getByText("Mapper", { exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/turns\\?${TURN_RANGE}`));
  await expect(detail).toBeHidden();
  await expect(firstTurn).toBeFocused();

  const choices = page.getByRole("button", { name: /để so sánh$/ });
  await expect(choices).toHaveCount(5);
  for (let index = 0; index < 4; index += 1) await choices.nth(index).click();
  await expect(choices.nth(4)).toBeDisabled();
  await page.getByRole("button", { name: "So sánh 4" }).click();
  await expect(page).toHaveURL(/\/turns\/compare\?.*ids=/);

  const comparison = page.getByRole("dialog", { name: "So sánh turns" });
  await expect(comparison.getByText("So sánh 2–4 turn theo đúng thứ tự đã chọn.")).toBeVisible();
  await expect(comparison.getByRole("heading", { name: /E2E dashboard task/ })).toHaveCount(4);
  await comparison.getByRole("button", { name: "Đóng" }).click();
  await expect(page).toHaveURL(new RegExp(`/turns\\?${TURN_RANGE}`));
});

test("hiển thị card mobile và không có lỗi accessibility", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`/turns?${TURN_RANGE}`);

  await expect(page.getByRole("heading", { level: 1, name: "Turns" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Danh sách turns" })).toHaveCount(0);
  await expect(page.getByTestId("turn-table")).toHaveCount(0);
  await expect(page.getByTestId("turn-cards")).toHaveCount(1);
  await expect(
    page.locator("article").filter({ hasText: "E2E dashboard task" }).first(),
  ).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("dark mode reveal lan tròn và tôn trọng reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    window.localStorage.setItem("codex-usage-theme", "light");
    const revealState: {
      animations: { keyframes: unknown; options: unknown }[];
      transitions: number;
    } = { animations: [], transitions: 0 };
    Object.defineProperty(window, "__themeRevealState", { value: revealState });
    const originalAnimate = Reflect.get(Element.prototype, "animate");
    Element.prototype.animate = function animate(keyframes, options) {
      revealState.animations.push({ keyframes, options });
      return Reflect.apply(originalAnimate, this, [keyframes, options]);
    };
    Object.defineProperty(Document.prototype, "startViewTransition", {
      configurable: true,
      value: (update: () => void) => {
        revealState.transitions += 1;
        update();
        return {
          finished: Promise.resolve(),
          ready: Promise.resolve(),
          skipTransition: () => undefined,
          updateCallbackDone: Promise.resolve(),
        } as ViewTransition;
      },
    });
  });
  await page.goto("/");

  await page.getByRole("combobox", { name: "Giao diện" }).selectOption("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          window as Window & {
            __themeRevealState?: {
              animations: { keyframes: unknown; options: unknown }[];
              transitions: number;
            };
          }
        ).__themeRevealState;
        if (!state) throw new Error("Missing theme reveal test state");
        return state;
      }),
    )
    .toMatchObject({
      animations: [
        expect.objectContaining({
          keyframes: expect.objectContaining({
            clipPath: expect.arrayContaining([expect.stringContaining("circle(0px")]),
          }),
          options: expect.objectContaining({
            duration: 550,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            pseudoElement: "::view-transition-new(root)",
          }),
        }),
      ],
      transitions: 1,
    });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("combobox", { name: "Giao diện" }).selectOption("light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __themeRevealState?: { transitions: number };
            }
          ).__themeRevealState?.transitions ?? -1,
      ),
    )
    .toBe(1);
});

test("favicon và manifest production được phục vụ đầy đủ", async ({ page }) => {
  await page.goto("/");
  const paths = [
    "/favicon.svg",
    "/favicon.ico",
    "/favicon-32x32.png",
    "/apple-touch-icon.png",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/icon-maskable-512.png",
    "/site.webmanifest",
  ];
  for (const path of paths) expect((await page.request.get(path)).status()).toBe(200);

  const manifest = await (await page.request.get("/site.webmanifest")).json();
  expect(manifest).toMatchObject({
    display: "standalone",
    name: "Codex Usage",
    short_name: "Codex Usage",
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192" }),
      expect.objectContaining({ purpose: "maskable", sizes: "512x512" }),
    ]),
  );
  expect(await page.locator('link[rel="manifest"]').getAttribute("href")).toBe("/site.webmanifest");

  const index = await page.request.get("/");
  expect(index.headers()["cache-control"]).toBe("no-cache");
  expect(index.headers()["etag"]).toBeTruthy();
  const deepLink = await page.request.get("/activity");
  expect(deepLink.headers()["cache-control"]).toBe("no-cache");
  const conditional = await page.request.get("/", {
    headers: { "if-none-match": index.headers()["etag"] ?? "" },
  });
  expect(conditional.status()).toBe(304);
  const manifestResponse = await page.request.get("/site.webmanifest");
  expect(manifestResponse.headers()["cache-control"]).toBe("public, max-age=86400");
  const assetPath = await page.locator('script[type="module"]').getAttribute("src");
  expect(assetPath).toBeTruthy();
  if (!assetPath) throw new Error("Missing production entry asset");
  expect((await page.request.get(assetPath)).headers()["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
  expect((await page.request.get("/api/status")).headers()["cache-control"]).toBe("no-store");
});
