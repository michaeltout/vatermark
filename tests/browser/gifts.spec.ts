import { test, expect, type Page } from '@playwright/test';

const demoCard = { id: 'a'.repeat(32), identityName: 'brightotter.vrsctest@', identityId: 'iBrowserFixture', amount: '1.00000000', walletUri: 'verusid://browser-fixture-not-a-funded-card' };
async function setup(page: Page, enabled = true) {
  await page.route('**/api/config', route => route.fulfill({ json: { network: 'VRSCTEST', signing: { enabled: false }, maxUploadBytes: 30_000_000, gifts: { enabled } } }));
  await page.route('**/api/gifts/current', route => route.fulfill({ json: { card: null } }));
}
test('get started directly requests a private gift QR', async ({ page }) => {
  await setup(page);
  let claims = 0;
  await page.route('**/api/gifts/claim', async route => {
    expect(route.request().postDataJSON()).toEqual({});
    claims++;
    await route.fulfill({ json: { card: demoCard } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Private gift card QR code' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Get a test identity', exact: true }).click();
  const qr = page.getByRole('img', { name: 'Private gift card QR code' });
  await expect(qr).toBeVisible();
  expect(await qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.getByRole('link', { name: 'Claim in Verus Mobile' })).toHaveAttribute('href', demoCard.walletUri);
  await expect(page.getByText('Keep this QR and wallet link private.', { exact: false })).toBeVisible();
  expect(claims).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Continue to signing' }).click();
  await expect(page.getByRole('tab', { name: 'Sign an image' })).toHaveAttribute('aria-selected', 'true');
});
test('existing allocation is restored without consuming another card', async ({ page }) => {
  await setup(page);
  await page.route('**/api/gifts/current', route => route.fulfill({ json: { card: demoCard } }));
  let claims = 0;
  page.on('request', request => { if (request.url().endsWith('/api/gifts/claim')) claims++; });
  await page.goto('/');
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await expect(page.getByRole('heading', { name: demoCard.identityName })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Get a test identity', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close get started' }).click();
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Claim in Verus Mobile' })).toBeVisible();
  expect(claims).toBe(0);
});
test('a temporary storage failure leaves the claim button available for retry', async ({ page }) => {
  await setup(page);
  let claims = 0;
  await page.route('**/api/gifts/claim', route => {
    claims++;
    return claims === 1
      ? route.fulfill({ status: 503, json: { error: { message: 'Gift cards are busy. Please try again shortly.' } } })
      : route.fulfill({ json: { card: demoCard } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  const claim = page.getByRole('button', { name: 'Get a test identity', exact: true });
  await claim.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Gift cards are busy' })).toBeVisible();
  await expect(claim).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Claim in Verus Mobile' })).toHaveCount(0);
  await claim.click();
  await expect(page.getByRole('link', { name: 'Claim in Verus Mobile' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Gift cards are busy' })).toHaveCount(0);
  expect(claims).toBe(2);
});
test('unconfigured gifts leave signing and verification available', async ({ page }) => {
  await setup(page, false);
  await page.goto('/');
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await expect(page.getByText('Test identities are not available yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Close get started' }).click();
  await expect(page.getByRole('tab', { name: 'Verify an image' })).toHaveAttribute('aria-selected', 'true');
});
