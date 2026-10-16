import { test, expect, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A deterministic unmarked RGB PNG; no external fixture or image library.
function png(width = 512, height = 512, blue = 100) {
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
    pixels[offset] = 64 + Math.floor(x / 4) % 128;
    pixels[offset + 1] = 64 + Math.floor(y / 4) % 128;
    pixels[offset + 2] = blue;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

test('real local API verifies an unmarked image without a service key', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Verify an image' })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'unmarked.png', mimeType: 'image/png', buffer: png() });
  await page.getByRole('button', { name: 'Verify signature' }).click();
  await expect(page.getByRole('heading', { name: 'No supported watermark recovered' })).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('invalid files receive a real processor error', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a PNG') });
  await page.getByRole('button', { name: 'Verify signature' }).click();
  await expect(page.getByRole('heading', { name: 'Authentication failed' })).toBeVisible();
});

test('signing clearly requires configuration and uses a responsive layout', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Sign an image' }).click();
  await expect(page.getByText('Signing needs server setup')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create signing request' })).toBeDisabled();
  await page.getByText('Local setup details').click();
  await expect(page.getByText('VATERMARK_SERVICE_ID', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

const returnedJobId = 'a'.repeat(32);
const returnedJob = {
  id: returnedJobId, status: 'complete', expiresAt: new Date(Date.now() + 900_000).toISOString(),
  width: 512, height: 512, previewUrl: `/api/sign-jobs/${returnedJobId}/preview`,
  downloadUrl: `/api/sign-jobs/${returnedJobId}/image`,
  identity: { id: 'iLocalBrowserTestIdentity', name: 'Local browser test', signingHeight: 123 },
};

test('wallet redirect restores the owner job and removes return parameters', async ({ page }) => {
  const deleted: string[] = [];
  page.on('request', request => { if (request.method() === 'DELETE') deleted.push(request.url()); });
  await page.route(`**/api/sign-jobs/${returnedJobId}`, route => route.fulfill({ json: returnedJob }));
  await page.route(`**/api/sign-jobs/${returnedJobId}/preview`, route => route.fulfill({ contentType: 'image/png', body: png() }));
  // Match the server's clean 303 target: the GenericResponse stays off this page.
  await page.goto(`/?walletReturn=${returnedJobId}&campaign=local#image-panel`);
  await expect(page.getByRole('tab', { name: 'Sign an image' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Signed and ready to share.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download signed image' })).toBeEnabled();
  await expect(page.getByRole('img', { name: 'Completed signed image' })).toBeVisible();
  const cleaned = new URL(page.url());
  expect(cleaned.search).toBe('?campaign=local');
  expect(cleaned.hash).toBe('#image-panel');
  expect(deleted).toEqual([]);
});

test('wallet return in a different browser gives receipt guidance without claiming success', async ({ page }) => {
  await page.route(`**/api/sign-jobs/${returnedJobId}`, route => route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Request not found.' } } }));
  await page.goto(`/?walletReturn=${returnedJobId}`);
  await expect(page.getByText('Return to the browser where you started signing to check the result.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Signed and ready to share.' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download signed image' })).toHaveCount(0);
  expect(new URL(page.url()).search).toBe('');
});

test('a cross-site wallet navigation preserves the original private browser session', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Verify signature' })).toBeVisible();
  await expect.poll(async () => (await context.cookies()).find(cookie => cookie.name === 'vatermark_owner')?.value).toBeTruthy();
  const owner = (await context.cookies()).find(cookie => cookie.name === 'vatermark_owner')!;
  let resumedWithOwner = false;
  await page.route(`**/api/sign-jobs/${returnedJobId}`, async route => {
    resumedWithOwner = (await route.request().allHeaders()).cookie?.includes(`vatermark_owner=${owner.value}`) || false;
    await route.fulfill(resumedWithOwner
      ? { json: { ...returnedJob, status: 'awaiting_signature', downloadUrl: undefined, walletUri: 'verus://1/local-browser-fixture' } }
      : { status: 404, json: { error: { code: 'NOT_FOUND', message: 'Request not found.' } } });
  });
  await page.route(`**/api/sign-jobs/${returnedJobId}/preview`, route => route.fulfill({ contentType: 'image/png', body: png() }));
  const callback = new URL(`/api/sign-jobs/${returnedJobId}/response`, page.url()).href;
  await page.route('http://wallet.example.test/**', route => route.fulfill({ contentType: 'text/html', body: `<a href="${callback}">Return to Vatermark</a>` }));
  await page.goto('http://wallet.example.test/');
  const callbackResponse = page.waitForResponse(response => response.url() === callback);
  await page.getByRole('link', { name: 'Return to Vatermark' }).click();
  // The empty fixture intentionally fails callback validation. Its real 303
  // still must preserve the owner so the pending request can be retried.
  const response = await callbackResponse;
  expect(response.status()).toBe(303);
  expect((await response.request().allHeaders()).cookie || '').not.toContain('vatermark_owner=');
  expect(response.headers()['set-cookie']).toBeUndefined();
  await expect(page.getByRole('heading', { name: 'Scan with your wallet' })).toBeVisible();
  expect(resumedWithOwner).toBe(true);
  expect((await context.cookies()).find(cookie => cookie.name === 'vatermark_owner')?.value).toBe(owner.value);
  expect(new URL(page.url()).search).toBe('');
});

test('a failed wallet return restores the pending request for retry', async ({ page }) => {
  let deleted = false;
  page.on('request', request => { if (request.method() === 'DELETE') deleted = true; });
  await page.route(`**/api/sign-jobs/${returnedJobId}`, route => route.fulfill({ json: {
    ...returnedJob, status: 'awaiting_signature', downloadUrl: undefined,
    walletUri: 'verus://1/local-browser-fixture',
  } }));
  await page.route(`**/api/sign-jobs/${returnedJobId}/preview`, route => route.fulfill({ contentType: 'image/png', body: png() }));
  await page.goto(`/?walletReturn=${returnedJobId}&returnError=INVALID_SIGNATURE`);
  await expect(page.getByText('The wallet response could not be accepted. Check your signing request and try again.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scan with your wallet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open wallet' })).toHaveAttribute('href', 'verus://1/local-browser-fixture');
  await expect(page.getByRole('img', { name: 'QR code containing the wallet signing request' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Signed and ready to share.' })).toHaveCount(0);
  expect(new URL(page.url()).search).toBe('');
  expect(deleted).toBe(false);
});

test('malformed wallet return links are harmless and never interpreted as success', async ({ page }) => {
  const requested: string[] = [];
  const errors: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/sign-jobs/')) requested.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?walletReturn=../../other&returnError=%3Cscript%3Ebad%3C/script%3E&campaign=local');
  await expect(page.getByText('The wallet response could not be accepted. Check your signing request and try again.', { exact: true })).toBeVisible();
  expect(new URL(page.url()).search).toBe('?campaign=local');
  expect(requested).toEqual([]);
  expect(errors).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Signed and ready to share.' })).toHaveCount(0);
  await page.goto('/?returnError=INVALID_RESPONSE');
  await expect(page.getByText('The wallet response could not be accepted. Check your signing request and try again.', { exact: true })).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
});

async function seedPrivateJob(page: Page) {
  await page.goto('/');
  await expect.poll(async () => (await page.context().cookies()).find(cookie => cookie.name === 'vatermark_owner')?.value).toBeTruthy();
  const owner = (await page.context().cookies()).find(cookie => cookie.name === 'vatermark_owner')!.value;
  const id = randomBytes(16).toString('hex');
  // Only the isolated test server's data directory, never a running user's jobs.
  const directory = path.join(fileURLToPath(new URL('../../', import.meta.url)), '.data/browser-tests/jobs', id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const source = png();
  const output = png(512, 512, 140);
  fs.writeFileSync(path.join(directory, 'source.png'), source, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'output.png'), output, { mode: 0o600 });
  const record = {
    id, owner: createHash('sha256').update(owner).digest('hex'), status: 'awaiting_signature',
    createdAt: Date.now(), expiresAt: Date.now() + 900_000, deleteAt: Date.now() + 900_000,
    requestIdHex: randomBytes(20).toString('hex'), walletUri: 'verus://1/local-browser-fixture',
    prepared: { width: 512, height: 512 },
  };
  const save = () => fs.writeFileSync(path.join(directory, 'job.json'), JSON.stringify(record), { mode: 0o600 });
  save();
  return { record, output, save, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('private PNG previews and completed downloads use real file routes', async ({ page }) => {
  const fixture = await seedPrivateJob(page);
  const visibleBlueChannel = async (name: string) => page.getByRole('img', { name }).evaluate(element => {
    const image = element as HTMLImageElement;
    if (!image.complete || !image.naturalWidth) return null;
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, 1, 1).data[2];
  });
  try {
    await page.goto(`/?walletReturn=${fixture.record.id}`);
    await expect(page.getByRole('heading', { name: 'Scan with your wallet' })).toBeVisible();
    await expect.poll(() => visibleBlueChannel('Selected image preview')).toBe(100);
    fixture.record.status = 'complete'; fixture.save();
    await expect(page.getByRole('heading', { name: 'Signed and ready to share.' })).toBeVisible();
    await expect.poll(() => visibleBlueChannel('Completed signed image')).toBe(140);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download signed image' }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('vatermark-signed.png');
    const downloaded = fs.readFileSync((await download.path())!);
    expect(downloaded.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(downloaded).toEqual(fixture.output);
    await expect(page.getByRole('button', { name: 'Download signed image' })).toBeEnabled();
  } finally { fixture.cleanup(); }
});

for (const scenario of [
  { name: 'a missing image', status: 404, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Signing job not found.' } }), error: 'Signing job not found.' },
  { name: 'a server error', status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'The operation could not be completed. Please try again.' } }), error: 'The operation could not be completed. Please try again.' },
  { name: 'a JSON success response', status: 200, contentType: 'application/json', body: '{}', error: 'The server did not return a PNG image. Please try downloading again.' },
  { name: 'a false PNG content type', status: 200, contentType: 'image/png', body: '{}', error: 'The downloaded file is not a valid PNG image. Please try again.' },
]) test(`download shows an error instead of saving ${scenario.name}`, async ({ page }) => {
  const fixture = await seedPrivateJob(page);
  fixture.record.status = 'complete'; fixture.save();
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  let releaseResponse!: () => void;
  const release = new Promise<void>(resolve => { releaseResponse = resolve; });
  await page.route(`**/api/sign-jobs/${fixture.record.id}/image`, async route => {
    await release;
    await route.fulfill({ status: scenario.status, contentType: scenario.contentType, body: scenario.body });
  });
  try {
    await page.goto(`/?walletReturn=${fixture.record.id}`);
    await page.getByRole('button', { name: 'Download signed image' }).click();
    await expect(page.getByRole('button', { name: 'Preparing download…' })).toBeDisabled();
    releaseResponse();
    await expect(page.getByRole('alert')).toContainText(scenario.error);
    await expect(page.getByRole('button', { name: 'Download signed image' })).toBeEnabled();
    expect(downloads).toEqual([]);
  } finally { releaseResponse(); fixture.cleanup(); }
});
