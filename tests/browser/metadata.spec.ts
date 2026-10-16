import { test, expect, type Page } from '@playwright/test';

const id = 'b'.repeat(32);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=', 'base64');
const expiresAt = () => new Date(Date.now() + 900_000).toISOString();
type Metadata = { status: string; expiresAt: string; walletUri?: string; message?: string; txid?: string };
const awaiting = (): Metadata => ({ status: 'awaiting_approval', expiresAt: expiresAt(), walletUri: 'verus://1/local-metadata-update-fixture' });

async function mockCompletedJob(page: Page, metadata?: Metadata) {
  const job = {
    id, status: 'complete', expiresAt: expiresAt(), width: 512, height: 512,
    previewUrl: `/api/sign-jobs/${id}/preview`, downloadUrl: `/api/sign-jobs/${id}/image`,
    identity: { id: 'iLocalBrowserMetadataIdentity', name: 'Local metadata test', signingHeight: 123 },
    metadata,
  };
  await page.route('**/api/config', route => route.fulfill({ json: {
    network: 'VRSCTEST', signing: { enabled: true }, responseMode: 'redirect',
    maxUploadBytes: 30 * 1024 * 1024, maxPixels: 24_000_000, metadata: { enabled: true, maxBytes: 512 },
  } }));
  await page.route(`**/api/sign-jobs/${id}`, route => route.fulfill({ json: job }));
  await page.route(`**/api/sign-jobs/${id}/preview`, route => route.fulfill({ contentType: 'image/png', body: png }));
  await page.route(`**/api/sign-jobs/${id}/image`, route => route.fulfill({ contentType: 'image/png', body: png }));
  return job;
}

test('optional details create a wallet request without blocking the completed download', async ({ page }) => {
  const job = await mockCompletedJob(page);
  let submitted: unknown;
  await page.route(`**/api/sign-jobs/${id}/metadata`, async route => {
    expect(route.request().method()).toBe('POST');
    submitted = route.request().postDataJSON();
    job.metadata = awaiting();
    await route.fulfill({ json: job });
  });
  await page.goto(`/?walletReturn=${id}`);
  await expect(page.getByRole('button', { name: 'Download signed image' })).toBeEnabled();
  await expect(page.getByLabel('Image title', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add image details', exact: true }).click();
  await page.getByLabel('Image title', { exact: true }).fill('  A coastal walk  ');
  await page.getByLabel('Description', { exact: true }).fill('An afternoon beside the sea.');
  await page.getByLabel('Website link', { exact: true }).fill('https://example.com/photos');
  await page.getByRole('button', { name: 'Create details request' }).click();
  await expect(page.getByRole('img', { name: 'QR code containing the optional identity update request' })).toBeVisible();
  expect(submitted).toEqual({ metadata: { title: 'A coastal walk', description: 'An afternoon beside the sea.', url: 'https://example.com/photos' } });
  await page.getByRole('button', { name: 'Enlarge QR' }).click();
  await expect(page.getByRole('dialog', { name: 'Scan image details request' })).toBeVisible();
  await expect.poll(() => page.getByRole('img', { name: 'Enlarged QR code containing the optional identity update request' }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1024);
  await page.getByRole('button', { name: 'Close QR' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open wallet for details' })).toHaveAttribute('href', awaiting().walletUri!);
  await expect(page.getByText(/separate wallet approval and a network fee/)).toBeVisible();
  await expect(page.getByText(/The QR and wallet link contain these details\. Your wallet encrypts them before publication\./)).toBeVisible();
  await expect(page.getByText(/Anyone with the signed image can read them/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download signed image' })).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download signed image' }).click();
  expect((await download).suggestedFilename()).toBe('vatermark-signed.png');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('details validate UTF-8 byte limits and web links before sending a request', async ({ page }) => {
  const job = await mockCompletedJob(page);
  let requests = 0;
  await page.route(`**/api/sign-jobs/${id}/metadata`, route => {
    requests += 1; job.metadata = awaiting();
    return route.fulfill({ json: job });
  });
  await page.goto(`/?walletReturn=${id}`);
  await page.getByRole('button', { name: 'Add image details', exact: true }).click();
  await page.getByRole('button', { name: 'Create details request' }).click();
  await expect(page.getByRole('alert')).toContainText('Add a title, description, or link.');
  await page.getByLabel('Website link').fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Create details request' }).click();
  await expect(page.getByRole('alert')).toContainText('Use a full HTTP or HTTPS link without a username or password.');
  await page.getByLabel('Website link').fill('https://name:password@example.com');
  await page.getByRole('button', { name: 'Create details request' }).click();
  await expect(page.getByRole('alert')).toContainText('Use a full HTTP or HTTPS link without a username or password.');
  await page.getByLabel('Website link').fill('');
  await page.getByLabel('Description', { exact: true }).fill('é'.repeat(260));
  await page.getByRole('button', { name: 'Create details request' }).click();
  await expect(page.getByRole('alert')).toContainText('These details exceed 512 bytes.');
  expect(requests).toBe(0);
  await page.getByLabel('Description', { exact: true }).fill('A short description');
  await page.getByRole('button', { name: 'Create details request' }).click();
  await expect(page.getByRole('link', { name: 'Open wallet for details' })).toBeVisible();
  expect(requests).toBe(1);
});

test('cancelling an optional update retains the signed image and does not delete its job', async ({ page }) => {
  const job = await mockCompletedJob(page, awaiting());
  const deleted: string[] = [];
  page.on('request', request => { if (request.method() === 'DELETE') deleted.push(new URL(request.url()).pathname); });
  await page.route(`**/api/sign-jobs/${id}/metadata`, route => {
    expect(route.request().method()).toBe('DELETE');
    job.metadata = undefined;
    return route.fulfill({ json: job });
  });
  await page.goto(`/?walletReturn=${id}&metadataReturn=1`);
  await page.getByRole('button', { name: 'Cancel details request' }).click();
  await expect(page.getByRole('button', { name: 'Add image details', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download signed image' })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Signed and ready to share.' })).toBeVisible();
  expect(deleted).toEqual([`/api/sign-jobs/${id}/metadata`]);
});

test('metadata wallet returns restore the owner job, clean the URL, and keep errors separate from signing', async ({ page }) => {
  await mockCompletedJob(page, awaiting());
  await page.goto(`/?walletReturn=${id}&metadataReturn=1&returnError=INVALID_RESPONSE&campaign=local#image-panel`);
  await expect(page.getByRole('heading', { name: 'Signed and ready to share.' })).toBeVisible();
  await expect(page.getByText('The details update response could not be accepted. Your image is still signed; you can retry this optional step.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open wallet for details' })).toBeVisible();
  expect(new URL(page.url()).search).toBe('?campaign=local');
  expect(new URL(page.url()).hash).toBe('#image-panel');
  await expect(page.getByRole('button', { name: 'Download signed image' })).toBeEnabled();
});

test('publication checks and polling advance metadata without changing image completion', async ({ page }) => {
  const job = await mockCompletedJob(page, { status: 'preparing', expiresAt: expiresAt() });
  await page.goto(`/?walletReturn=${id}&metadataReturn=1`);
  await expect(page.getByText('Preparing the details request…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download signed image' })).toBeEnabled();
  job.metadata = { status: 'submitted', expiresAt: expiresAt(), txid: '1'.repeat(64) };
  await expect(page.getByText('Waiting for the identity update to appear on chain')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole('button', { name: /Cancel details request|Stop checking details/ })).toHaveCount(0);
  await expect(page.getByText('An identity update already submitted to the chain cannot be cancelled here.')).toBeVisible();
  await page.route(`**/api/sign-jobs/${id}/metadata/check`, route => {
    expect(route.request().method()).toBe('POST');
    job.metadata = { status: 'published', expiresAt: expiresAt(), txid: '1'.repeat(64) };
    return route.fulfill({ json: job });
  });
  await page.getByRole('button', { name: 'Check publication' }).click();
  await expect(page.getByText('Image details published', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download signed image' })).toBeEnabled();
});

test('verification shows decrypted plain text and safely opens web links', async ({ page }) => {
  await page.route('**/api/verify', route => route.fulfill({ json: {
    status: 'verified', message: 'The image signature is valid.',
    metadata: { status: 'decrypted', data: { title: '<img src=x onerror=alert(1)>', description: '<script>not executable</script>\nA second line.', url: 'https://example.com/gallery' }, height: 123 },
  } }));
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'signed.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Verify signature' }).click();
  await expect(page.getByRole('heading', { name: 'Signature verified' })).toBeVisible();
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(page.locator('img[onerror]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'https://example.com/gallery' })).toHaveAttribute('href', 'https://example.com/gallery');
  await expect(page.getByRole('link', { name: 'https://example.com/gallery' })).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('unsafe metadata links are inert and unavailable details do not invalidate an image signature', async ({ page }) => {
  let unavailable = false;
  await page.route('**/api/verify', route => route.fulfill({ json: {
    status: 'verified', message: 'The image signature is valid.',
    metadata: unavailable ? { status: 'unavailable', message: 'Identity details could not be retrieved.' } : { status: 'decrypted', data: { title: 'A title', url: 'javascript:alert(1)' } },
  } }));
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'signed.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Verify signature' }).click();
  await expect(page.getByRole('heading', { name: 'Signature verified' })).toBeVisible();
  await expect(page.getByText('The stored link is not a supported web address.')).toBeVisible();
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  unavailable = true;
  await page.getByRole('button', { name: 'Verify again' }).click();
  await expect(page.getByRole('alert')).toContainText('Image details are unavailable');
  await expect(page.getByRole('heading', { name: 'Signature verified' })).toBeVisible();
});
