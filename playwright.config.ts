import { defineConfig, devices } from '@playwright/test';

const port = process.env.PLAYWRIGHT_PORT || '5174';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/browser', fullyParallel: true,
  use: {
    baseURL, trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'node --import tsx server/index.ts', url: `${baseURL}/api/health`, reuseExistingServer: false,
    env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: port, DATA_DIR: '.data/browser-tests',
      PUBLIC_ORIGIN: '', VATERMARK_SERVICE_ID: '', VATERMARK_SERVICE_WIF: '', TLS_CERT_PATH: '', TLS_KEY_PATH: '',
      GIFTS_ENABLED: 'false' },
  },
});
