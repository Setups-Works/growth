import { expect, test } from "@playwright/test";

/**
 * The application shell, with nothing connected.
 *
 * A fresh clone must be usable enough to explain itself. These check that it
 * says what is missing rather than showing an empty dashboard or an error page.
 */

test("the home page introduces the product and offers sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Growth by Setups Works/i);
  await expect(page.getByRole("link", { name: /log in|sign in/i }).first()).toBeVisible();
});

test("sign-up checks each field and names the one that's wrong", async ({ page }) => {
  const base = { name: "Asha K", email: `su-${Date.now()}@example.com`, phone: "98765 43210", password: "a-long-password-1" };
  for (const [field, value] of [["name", "x"], ["email", "nope"], ["phone", "12345"], ["password", "short"]] as const) {
    const res = await page.request.post("/api/auth/signup", { data: { ...base, [field]: value } });
    expect(res.status()).toBe(400);
    expect((await res.json()).field).toBe(field);
  }
});

test("signed out, the dashboard redirects to sign-in", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("a new account lands on the connect form, which refuses a plainly invalid URL", async ({ page }) => {
  const res = await page.request.post("/api/auth/signup", {
    data: {
      name: "E2E Tester",
      email: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      phone: "9876543210",
      password: "e2e-password-1",
    },
  });
  expect(res.ok()).toBeTruthy();

  await page.goto("/connect");
  const input = page.getByLabel(/store url/i);
  await input.fill("x");
  await page.getByRole("button", { name: /continue to woocommerce/i }).click();
  await expect(page).toHaveURL(/\/connect/);
  expect(await input.evaluate((el: HTMLInputElement) => el.checkValidity())).toBe(false);
});

test("the API reference renders the spec", async ({ page }) => {
  await page.goto("/api-docs");
  // Rendered by Scalar from the bundled spec: a real heading from the real
  // document, which fails if the spec stops parsing or the viewer stops mounting.
  await expect(page.getByRole("heading", { name: "Setups Works Growth API" })).toBeVisible({ timeout: 20_000 });
});
