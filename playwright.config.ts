import { defineConfig, devices } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';

// Browser checks run against a deployed environment (default: dev). The Access
// service token from .env.local authenticates the browser through request headers.
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}
const env = (process.env.CONVERGE_E2E_ENV ?? 'dev').toUpperCase();
const baseURL = process.env.CONVERGE_E2E_URL ?? 'https://converge-dev.converge-42.workers.dev';
const headers: Record<string, string> = {};
if (process.env[`CF_ACCESS_CLIENT_ID_${env}`]) {
  headers['CF-Access-Client-Id'] = process.env[`CF_ACCESS_CLIENT_ID_${env}`]!;
  headers['CF-Access-Client-Secret'] = process.env[`CF_ACCESS_CLIENT_SECRET_${env}`]!;
}

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: { baseURL, extraHTTPHeaders: headers, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
