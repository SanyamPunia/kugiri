import { expect, type Page, test } from "@playwright/test";

// The demo page is the test suite: every case splits as it scrolls into view, and its check
// compares the split with the lines the browser painted before it, text and geometry.

async function revealEverything(page: Page) {
  // The page watches its targets only once its fonts have loaded, which a cold runner can take a
  // while to do; a target scrolled past before then is never split.
  await expect(page.locator("html")).toHaveAttribute("data-watching", "", { timeout: 30_000 });

  const height = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);

  // The observer only learns what is in view when the page renders, and a runner can render a few
  // frames a second: a position scrolled past between two frames is never seen, and the targets
  // there never split. Each step waits for the next frame, which runs the observer after its
  // animation frame callbacks, before the next step can scroll on.
  for (let y = 0; y <= height + 600; y += 600) {
    await page.evaluate(
      (top) =>
        new Promise((resolve) => {
          window.scrollTo({ top, behavior: "instant" });
          requestAnimationFrame(resolve);
        }),
      Math.min(y, height)
    );
    await page.waitForTimeout(120);
  }

  // The longest reveal is a second; the check reads the settled DOM.
  await page.waitForTimeout(2500);
}

/**
 * Cases whose split is right at the moment it is made but whose geometry a browser changes
 * afterwards: WebKit renders a `::first-line` without the `text-transform` it reports, then applies
 * it once an animation has touched the line. The lines themselves are still asserted.
 */
const GEOMETRY_KNOWN_TO_DRIFT: Record<string, string[]> = {
  webkit: ["first-line"],
};

/** What each page threw or logged as an error, so a case that never split can say why. */
const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  pageErrors.set(page, errors);
});

async function expectEveryCaseAsPainted(page: Page, browserName: string) {
  await page.getByRole("button", { name: "Check lines" }).click();

  const cases = page.locator("section[data-case]");
  const count = await cases.count();

  expect(count).toBeGreaterThan(40);

  for (let index = 0; index < count; index += 1) {
    const section = cases.nth(index);
    const id = await section.getAttribute("data-case");
    const result = (await section.locator(".case-result").textContent()) ?? "";
    const status = await section.getAttribute("data-status");
    const knownDrift = GEOMETRY_KNOWN_TO_DRIFT[browserName]?.includes(id ?? "") && / lines as painted, but /.test(result);

    if (status === "mismatch" && knownDrift) {
      continue;
    }

    // A case that never split either never came into view or threw when it did; say which.
    let detail = "";

    if (status === "pending") {
      const where = await section
        .locator("[data-target]")
        .first()
        .evaluate((target) => {
          const rect = target.getBoundingClientRect();

          return `target top ${rect.top.toFixed(0)}, height ${rect.height.toFixed(0)}, scrollY ${window.scrollY.toFixed(0)}, viewport ${window.innerHeight}`;
        });
      const errors = pageErrors.get(page) ?? [];

      detail = `\n${where}\npage errors: ${errors.length > 0 ? `\n${errors.join("\n")}` : "none"}`;
    }

    expect(status, `${id}: ${result}${detail}`).toBe("ok");
  }
}

test("every case splits exactly as the browser painted it", async ({ page, browserName }) => {
  await page.goto("/");
  await revealEverything(page);
  await expectEveryCaseAsPainted(page, browserName);
});

test("a replay reverts and splits again to the same result", async ({ page, browserName }) => {
  await page.goto("/");
  await revealEverything(page);
  await page.getByRole("button", { name: "Replay all" }).click();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await revealEverything(page);
  await expectEveryCaseAsPainted(page, browserName);
});

test("the mask outlines are drawn inside the masks and move nothing", async ({ page, browserName }) => {
  await page.goto("/");
  await revealEverything(page);
  await page.locator("[data-box=masks]").click();

  await expect(page.locator("html")).toHaveAttribute("data-boxes", "masks");
  await expectEveryCaseAsPainted(page, browserName);
});

test("a split leaves no empty link behind", async ({ page }) => {
  await page.goto("/");
  await revealEverything(page);

  const emptyLinks = await page.evaluate(
    () => Array.from(document.querySelectorAll("[data-target] a")).filter((a) => !a.textContent?.trim()).length
  );

  expect(emptyLinks).toBe(0);
});
