import { test, expect, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

// Cases (beta) against the real local server: no wallet, so signing stays
// off, which is exactly what the pages must say. Every test uses its own
// image bytes so fingerprints never collide across runs or projects.
function png(width = 256, height = 256) {
  const seed = randomBytes(8);
  const crc = (bytes: Buffer) => {
    let n = 0xffffffff;
    for (const byte of bytes) { n ^= byte; for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); }
    return (n ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(name), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (1 + width * 3) + 1 + x * 3;
    pixels[offset] = (64 + x + seed[0]!) & 0xff; pixels[offset + 1] = (64 + y + seed[1]!) & 0xff; pixels[offset + 2] = seed[(x + y) % 8]!;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
async function openCase(page: Page, image: Buffer): Promise<string> {
  await page.goto('/cases/new');
  await page.locator('input[type=file]').setInputFiles({ name: 'scan.png', mimeType: 'image/png', buffer: image });
  await expect(page).toHaveURL(/\/cases\/c\/VC-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  return /VC-[0-9A-Z-]+$/.exec(page.url())![0];
}

test('the Vatermark header offers Cases as a beta, and the Cases home shows the flow', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('link', { name: 'Cases beta' }).click();
  await expect(page).toHaveURL(/\/cases$/);
  await expect(page.getByRole('heading', { name: 'Who’s looking after this scan?' })).toBeVisible();
  await expect(page.getByRole('img', { name: /How a case moves/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Find a case' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Vatermark' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('tab', { name: 'Verify an image' })).toBeVisible();
  expect(errors).toEqual([]);
  await noOverflow(page);
});

test('an image opens a draft case; the number and the same bytes both find it again', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const image = png();
  const number = await openCase(page, image);
  await expect(page.getByRole('heading', { name: 'Who owns this case?' })).toBeVisible();
  await expect(page.getByText('Not opened yet')).toBeVisible();
  await expect(page.getByText(/Nobody can sign yet/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open the case' })).toBeDisabled();
  await expect(page.getByText('Nothing signed yet.')).toBeVisible();
  await noOverflow(page);
  await page.goto('/cases');
  await page.getByLabel('Case number').fill(number.toLowerCase().replace(/-/g, ''));
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/cases/c/${number}$`));
  await expect(page.getByRole('heading', { name: number })).toBeVisible();
  await page.goto('/cases');
  await page.locator('input[type=file]').setInputFiles({ name: 'copy.png', mimeType: 'image/png', buffer: image });
  await expect(page).toHaveURL(new RegExp(`/cases/c/${number}$`));
  await expect(page.getByText('Found it.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('an unknown number and a malformed number both get a plain answer', async ({ page }) => {
  await page.goto('/cases/c/VC-0000-0000-0000');
  await expect(page.getByRole('heading', { name: 'No case under VC-0000-0000-0000' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Cases' }).click();
  await expect(page).toHaveURL(/\/cases$/);
  await page.getByLabel('Case number').fill('not a number');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByText(/doesn’t look like a case number/)).toBeVisible();
});

test('a wallet return lands on the case with its outcome and leaves a clean URL', async ({ page }) => {
  const number = await openCase(page, png());
  await page.goto(`/cases?caseReturn=${number}&returnError=WRONG_IDENTITY`);
  await expect(page).toHaveURL(new RegExp(`/cases/c/${number}$`));
  await expect(page.getByText(/different identity than the step needs/)).toBeVisible();
  await page.goto(`/cases?caseReturn=${number}`);
  await expect(page).toHaveURL(new RegExp(`/cases/c/${number}$`));
  await expect(page.getByText(/Signed and recorded/)).toBeVisible();
  await page.goto('/cases?returnError=JOB_CLOSED');
  await expect(page.getByText(/isn’t waiting for a signature any more/)).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
});
