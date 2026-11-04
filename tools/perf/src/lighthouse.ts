// REQ-PERF-001 REQ-UI-003 — Lighthouse user flow over the signed-in console: Puppeteer drives the Chromium that
// Playwright already installed, signs in through the Keycloak realm as the seeded administrator (the same user the
// e2e suite uses, read from the realm export so no credential lives here), then audits the sign-in screen cold and
// every primary screen as a navigation. Category scores land in tools/perf/results/lighthouse.json, which
// `pnpm guard` compares with PERF_BUDGETS; the full flow report is written beside it for review.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { loadEnv } from '@openmap/config';
import { PERF_BUDGETS } from '@openmap/constants';
import { translate, type Locale } from '@openmap/i18n';
import { startFlow } from 'lighthouse';
import puppeteer, { type Page } from 'puppeteer-core';

const resultsDir = fileURLToPath(new URL('../results/', import.meta.url));
const realmFile = fileURLToPath(new URL('../../../deploy/compose/keycloak/realm-openmap.json', import.meta.url));
const LOCALE: Locale = 'en';
const SCREENS = ['dashboard', 'setup', 'layers', 'discovery', 'dependencies', 'cmdb', 'assets', 'software', 'services', 'impact', 'integrations', 'ipam', 'dcim', 'vulnerabilities', 'analytics', 'assistant', 'settings'] as const;
const NAVIGATION_TIMEOUT_MS = 60_000;
const SCORE_DECIMALS = 100;
/** Lighthouse's desktop preset: the console is an operator desk, not a phone app. */
const FORM_FACTOR = 'desktop' as const;
const SCREEN = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, disabled: false };
/** Chrome writes the DevTools port and path here once --remote-debugging-port=0 has bound a socket. */
const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';
const DEVTOOLS_POLL_MS = 100;
const DEVTOOLS_WAIT_MS = 30_000;
/** Loopback: Chrome only ever binds the DevTools socket locally. */
const DEVTOOLS_HOST = '127.0.0.1';
const THROTTLING = { rttMs: 40, throughputKbps: 10_240, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 };

interface RealmUser {
  username: string;
  credentials?: Array<{ type: string; value: string }>;
}

function seededUser(): { username: string; password: string } {
  const realm = JSON.parse(readFileSync(realmFile, 'utf8')) as { users?: RealmUser[] };
  for (const user of realm.users ?? []) {
    const credential = user.credentials?.find((c) => c.type === 'password');
    if (credential !== undefined) return { username: user.username, password: credential.value };
  }
  throw new Error('realm export has no user with a password credential');
}

async function clickByText(page: Page, text: string): Promise<void> {
  const handle = await page.waitForSelector('xpath/.//button[normalize-space()="' + text + '"]', { timeout: NAVIGATION_TIMEOUT_MS });
  if (handle === null) throw new Error('button not found: ' + text);
  await handle.click();
}

async function signIn(page: Page, consoleUrl: string): Promise<void> {
  await page.goto(consoleUrl + '/' + LOCALE + '/dashboard', { waitUntil: 'networkidle0', timeout: NAVIGATION_TIMEOUT_MS });
  await clickByText(page, translate(LOCALE, 'auth.signIn'));
  const user = seededUser();
  await page.waitForSelector('#username', { timeout: NAVIGATION_TIMEOUT_MS });
  await page.type('#username', user.username);
  await page.type('#password', user.password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: NAVIGATION_TIMEOUT_MS }), page.click('#kc-login')]);
  const newPassword = await page.$('#password-new');
  if (newPassword !== null) {
    await page.type('#password-new', user.password);
    await page.type('#password-confirm', user.password);
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: NAVIGATION_TIMEOUT_MS }), page.click('#kc-form-buttons input[type=submit], #kc-form-buttons button[type=submit]')]);
  }
  await page.waitForSelector('nav[aria-label="' + translate(LOCALE, 'nav.primary') + '"]', { timeout: NAVIGATION_TIMEOUT_MS });
}

interface FailingAudit {
  id: string;
  title: string;
  /** Elements the audit flagged, when it reports items. */
  items: number;
}

interface PageScore {
  label: string;
  url: string;
  performance: number;
  accessibility: number;
  bestPractices: number;
  /** Accessibility and best-practice audits that did not pass, so a budget miss names its cause. */
  failing: FailingAudit[];
  /** Core metrics in milliseconds (CLS unitless), so a performance miss names its cause too. */
  metrics: Record<string, number>;
}

/** Lighthouse audit ids whose numeric values explain a performance score. */
const METRIC_AUDITS = ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index', 'interactive'] as const;

function metricsOf(lhr: { audits: Record<string, { numericValue?: number } | undefined> }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of METRIC_AUDITS) {
    const value = lhr.audits[id]?.numericValue;
    if (typeof value === 'number') out[id] = Math.round(value * 1000) / 1000;
  }
  return out;
}

interface AuditLike {
  id: string;
  title: string;
  score: number | null;
  scoreDisplayMode: string;
  details?: { items?: unknown[] };
}

function failingAudits(lhr: { audits: Record<string, AuditLike>; categories: Record<string, { auditRefs: Array<{ id: string }> }> }): FailingAudit[] {
  const ids = new Set<string>();
  for (const category of ['accessibility', 'best-practices']) for (const ref of lhr.categories[category]?.auditRefs ?? []) ids.add(ref.id);
  const out: FailingAudit[] = [];
  for (const id of ids) {
    const audit = lhr.audits[id];
    if (audit === undefined || audit.score === null || audit.score >= 1) continue;
    if (audit.scoreDisplayMode === 'informative' || audit.scoreDisplayMode === 'notApplicable' || audit.scoreDisplayMode === 'manual') continue;
    out.push({ id, title: audit.title, items: audit.details?.items?.length ?? 0 });
  }
  return out;
}

function score(categories: Record<string, { score: number | null }>, id: string): number {
  const value = categories[id]?.score;
  return value === null || value === undefined ? 0 : Math.round(value * SCORE_DECIMALS) / SCORE_DECIMALS;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const consoleUrl = env.PUBLIC_CONSOLE_URL.replace(/\/$/, '');
  // Playwright launches the Chromium it installed (Puppeteer cannot spawn it on every host); Puppeteer, which
  // Lighthouse's flow API drives, attaches to that browser over the DevTools socket Chrome announces on disk.
  const userDataDir = mkdtempSync(join(tmpdir(), 'openmap-lighthouse-'));
  const context = await chromium.launchPersistentContext(userDataDir, { headless: true, args: ['--remote-debugging-port=0'], viewport: { width: SCREEN.width, height: SCREEN.height } });
  const portFile = join(userDataDir, DEVTOOLS_PORT_FILE);
  const deadline = Date.now() + DEVTOOLS_WAIT_MS;
  while (!existsSync(portFile) && Date.now() < deadline) await sleep(DEVTOOLS_POLL_MS);
  const [port, path] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  if (port === undefined || path === undefined) throw new Error('Chrome did not announce a DevTools socket in ' + portFile);
  const browser = await puppeteer.connect({ browserWSEndpoint: 'ws://' + DEVTOOLS_HOST + ':' + port + path, defaultViewport: { width: SCREEN.width, height: SCREEN.height } });
  const page = await browser.newPage();
  const flow = await startFlow(page, {
    name: 'OpenMap console',
    config: { extends: 'lighthouse:default', settings: { formFactor: FORM_FACTOR, screenEmulation: SCREEN, throttling: THROTTLING, onlyCategories: ['performance', 'accessibility', 'best-practices'] } },
  });

  // Cold: the public sign-in screen.
  await flow.navigate(consoleUrl + '/' + LOCALE + '/dashboard', { name: 'sign-in' });
  await flow.endNavigation().catch(() => undefined);
  await signIn(page, consoleUrl);
  // Warm: every signed-in screen as its own navigation (the session restores from the stored refresh token).
  for (const screen of SCREENS) {
    await flow.navigate(consoleUrl + '/' + LOCALE + '/' + screen, { name: screen });
  }

  const result = await flow.createFlowResult();
  const pages: PageScore[] = result.steps.map((step) => ({
    label: step.name,
    url: step.lhr.finalDisplayedUrl,
    performance: score(step.lhr.categories, 'performance'),
    accessibility: score(step.lhr.categories, 'accessibility'),
    bestPractices: score(step.lhr.categories, 'best-practices'),
    failing: failingAudits(step.lhr as unknown as Parameters<typeof failingAudits>[0]),
    metrics: metricsOf(step.lhr as unknown as Parameters<typeof metricsOf>[0]),
  }));
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(resultsDir + 'lighthouse.json', JSON.stringify({ name: 'lighthouse', formFactor: FORM_FACTOR, budgets: { performance: PERF_BUDGETS.lighthousePerformanceMin, accessibility: PERF_BUDGETS.lighthouseAccessibilityMin, bestPractices: PERF_BUDGETS.lighthouseBestPracticesMin }, pages, generatedAt: new Date().toISOString() }, null, 2) + '\n');
  writeFileSync(resultsDir + 'lighthouse-flow.html', await flow.generateReport());
  await browser.disconnect();
  await context.close();

  let failed = false;
  for (const p of pages) {
    // Same floors as tools/guard: screens that host a third-party application have their own performance floor.
    const performanceMin = (PERF_BUDGETS.lighthouseEmbeddedScreens as readonly string[]).includes(p.label) ? PERF_BUDGETS.lighthouseEmbeddedPerformanceMin : PERF_BUDGETS.lighthousePerformanceMin;
    const ok = p.performance >= performanceMin && p.accessibility >= PERF_BUDGETS.lighthouseAccessibilityMin && p.bestPractices >= PERF_BUDGETS.lighthouseBestPracticesMin;
    if (!ok) failed = true;
    console.log((ok ? 'ok   ' : 'UNDER') + ' ' + p.label.padEnd(14) + ' performance ' + String(p.performance) + ' · accessibility ' + String(p.accessibility) + ' · best practices ' + String(p.bestPractices));
    for (const audit of p.failing) console.log('        ' + audit.id + ' (' + String(audit.items) + '): ' + audit.title);
    if (!ok) console.log('        metrics ' + JSON.stringify(p.metrics));
  }
  console.log('lighthouse: results/lighthouse.json and results/lighthouse-flow.html written');
  if (failed) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
