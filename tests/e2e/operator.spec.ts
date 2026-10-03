import { expect, test, type Page } from '@playwright/test';

// Browser checks against a deployed environment (see playwright.config.ts).
// Default checks are read-only. Set CONVERGE_E2E_FULL=1 to also run a full
// fixture session through the UI; that moves canonical main (promotion).

const PREVIEW_ORIGIN = process.env.CONVERGE_E2E_PREVIEW_URL ?? 'https://converge-preview-dev.converge-42.workers.dev';
const REPLAY_ID = process.env.CONVERGE_E2E_REPLAY ?? 'rpl_suwonabsqmruq2gq6pvnctj2vq';

/** On phones the sidebar is a menu; open it before reading project and session links. */
async function openNav(page: Page, isMobile: boolean) {
  if (!isMobile) return;
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Open the project and session menu' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test('the operator UI loads behind Access and shows the project', async ({ page, isMobile }) => {
  await page.goto('/');
  await openNav(page, isMobile);
  await expect(page.getByRole('heading', { name: 'Project' })).toBeVisible();
  await expect(page.getByText(/Repo\s*cv-/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await noHorizontalOverflow(page);
});

test('a skip link moves keyboard focus to the main content', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard check runs on desktop');
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});

test('settings show the limits and the model', async ({ page, isMobile }) => {
  await page.goto('/');
  await openNav(page, isMobile);
  await page.getByRole('link', { name: 'Settings and limits' }).click();
  await expect(page.getByText(/claude-/).first()).toBeVisible();
  await noHorizontalOverflow(page);
});

for (const state of ['ready', 'running', 'cancelling', 'failed-agent', 'stale', 'promoted']) {
  test(`sample state "${state}" renders with a sample-data label and no overflow`, async ({ page }) => {
    await page.goto(`/?sample=${state}`);
    await expect(page.getByText(/sample data/i).first()).toBeVisible();
    await expect(page.locator('h1')).not.toBeEmpty();
    await noHorizontalOverflow(page);
  });
}

test('the matrix opens a counterexample with expected and observed values', async ({ page }) => {
  await page.goto('/?sample=ready');
  const failed = page.getByRole('button', { name: /Customer isolation: Failed/ }).first();
  await failed.scrollIntoViewIfNeeded();
  await failed.click();
  await expect(page.getByText('10000').first()).toBeVisible();
  await expect(page.getByText('8000').first()).toBeVisible();
  await page.keyboard.press('Escape');
});

test('the approve button names the exact commit it authorizes', async ({ page }) => {
  await page.goto('/?sample=ready');
  await expect(page.getByRole('button', { name: /^Approve commit [0-9a-f]{7} for promotion to main$/ })).toBeVisible();
});

test('unknown API routes return a JSON error, not the SPA', async ({ request }) => {
  const res = await request.get('/api/does-not-exist');
  expect(res.status()).toBe(404);
  expect((await res.json()).error.code).toBe('NOT_FOUND');
});

test.describe('public replay (anonymous)', () => {
  test.use({ extraHTTPHeaders: {} });

  test('renders read-only with its original mode and real timestamps', async ({ page }) => {
    await page.goto(`${PREVIEW_ORIGIN}/replay/${REPLAY_ID}`);
    await expect(page.getByText('Replay', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/read-only/i).first()).toBeVisible();
    await expect(page.getByText(/real recorded timestamps/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Approve|Promote|Start agents|Cancel session/ })).toHaveCount(0);
    await noHorizontalOverflow(page);
  });

  test('an unknown replay shows a not-found state', async ({ page }) => {
    await page.goto(`${PREVIEW_ORIGIN}/replay/rpl_aaaaaaaaaaaaaaaaaaaaaaaaaa`);
    await expect(page.getByText(/not found|no replay/i).first()).toBeVisible();
  });
});

test.describe('full fixture flow through the UI', () => {
  test.skip(!process.env.CONVERGE_E2E_FULL, 'set CONVERGE_E2E_FULL=1 to run (moves canonical main)');
  test.setTimeout(10 * 60_000);

  test('create, start, review, approve, promote', async ({ page, isMobile }) => {
    test.skip(isMobile, 'run the full flow once');
    await page.goto('/');
    await page.getByRole('button', { name: 'Create session' }).click();
    await page.getByRole('button', { name: 'Start agents' }).click();
    await expect(page.locator('h1')).toHaveText(/Ready to approve this commit/, { timeout: 8 * 60_000 });
    const approve = page.getByRole('button', { name: /^Approve commit/ });
    await approve.scrollIntoViewIfNeeded();
    await approve.click();
    const promote = page.getByRole('button', { name: /^Promote commit/ });
    await promote.scrollIntoViewIfNeeded();
    await promote.click();
    await expect(page.getByText('Main now equals the approved commit').first()).toBeVisible({ timeout: 120_000 });
  });
});
