// T-089 REQ-PERF-001 REQ-PERF-003 — performance budgets measured in the browser against the production build and
// written to tools/perf/results for `pnpm guard`: p95 of screen interactions (click to the next painted frame, across
// layer toggles, CMDB layer filters, the account menu and the dependency-map direction select) and the sustained
// frame rate of the dependency map while it is zoomed and panned. Runs in the `en` project only: the budget is about
// rendering cost, not copy, and one run keeps the result file deterministic.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PERF_BUDGETS } from '@openmap/constants';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const resultsDir = fileURLToPath(new URL('../../../tools/perf/results/', import.meta.url));
const SHELL_TIMEOUT_MS = 30_000;
/** Interactions sampled per control; enough for a stable p95 without inflating the run. */
const SAMPLES_PER_CONTROL = 8;
/** Frame-rate sampling window for the dependency map. */
const FPS_WINDOW_MS = 3_000;
const WHEEL_STEP = 120;
const PAN_STEP_PX = 40;
const PERCENTILE_95 = 0.95;

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * PERCENTILE_95) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/** Time from dispatching the click to the second animation frame after it: the frame that shows the result. */
async function measureClick(locator: Locator): Promise<number> {
  return locator.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        const started = performance.now();
        (element as HTMLElement).click();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(performance.now() - started);
          });
        });
      }),
  );
}

async function sampleControl(locator: Locator, samples: number[]): Promise<void> {
  for (let i = 0; i < SAMPLES_PER_CONTROL; i += 1) samples.push(await measureClick(locator));
}

async function openShell(page: Page, locale: 'en' | 'ar', path: string): Promise<void> {
  await page.goto('/' + locale + path);
  await expect(page.getByRole('navigation', { name: translate(locale, 'nav.primary') })).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await page.waitForLoadState('networkidle');
}

test('screen interactions stay under the p95 budget and the dependency map holds its frame rate', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('Playwright project must be named after a locale: ' + locale);
  test.skip(locale !== 'en', 'budgets are measured once, in the en project');
  test.setTimeout(SHELL_TIMEOUT_MS * 8);

  await page.goto('/' + locale + '/dashboard');
  await signIn(page, locale);

  const samples: number[] = [];

  await openShell(page, locale, '/layers');
  const toggles = page.getByRole('switch');
  await expect(toggles.first()).toBeVisible();
  await sampleControl(toggles.first(), samples);
  await sampleControl(toggles.nth(1), samples);
  // Leave every layer visible for the screens that follow.
  await page.getByRole('button', { name: translate(locale, 'layer.showAll') }).click();

  await openShell(page, locale, '/cmdb');
  const filters = page.getByRole('group', { name: translate(locale, 'cmdb.filter.label') });
  await sampleControl(filters.getByRole('button', { name: translate(locale, 'layer.hardware') }), samples);
  await sampleControl(filters.getByRole('button', { name: translate(locale, 'cmdb.filter.all') }), samples);

  const menu = page.getByRole('button', { name: translate(locale, 'auth.menu') });
  await sampleControl(menu, samples);

  // Dependency map: the first application as focus (applications sit between services and infrastructure, so the
  // map always has both dependants and dependencies), both directions, default depth.
  await filters.getByRole('button', { name: translate(locale, 'layer.applications') }).click();
  // A CI row's link: the header also links to /cmdb/import.
  const firstCi = page.locator('main [role="row"] a[href*="/cmdb/"]').first();
  await expect(firstCi).toBeVisible();
  const href = await firstCi.getAttribute('href');
  const ciId = href?.split('/cmdb/')[1] ?? '';
  expect(ciId).not.toBe('');
  await openShell(page, locale, '/dependencies?ci=' + ciId + '&direction=both');
  const canvas = page.locator('main canvas').first();
  await expect(canvas).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const toolbar = page.getByRole('toolbar', { name: translate(locale, 'dependencies.toolbar') });
  const direction = toolbar.getByRole('combobox').first();
  await sampleControl(direction, samples);

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const centre = { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 };
  await page.mouse.move(centre.x, centre.y);
  const framesPromise = page.evaluate(
    (windowMs) =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const started = performance.now();
        const tick = (): void => {
          frames += 1;
          if (performance.now() - started < windowMs) requestAnimationFrame(tick);
          else resolve((frames * 1000) / (performance.now() - started));
        };
        requestAnimationFrame(tick);
      }),
    FPS_WINDOW_MS,
  );
  const deadline = Date.now() + FPS_WINDOW_MS;
  let step = 0;
  while (Date.now() < deadline) {
    await page.mouse.wheel(0, step % 2 === 0 ? -WHEEL_STEP : WHEEL_STEP);
    await page.mouse.down();
    await page.mouse.move(centre.x + PAN_STEP_PX, centre.y + PAN_STEP_PX, { steps: 4 });
    await page.mouse.up();
    await page.mouse.move(centre.x, centre.y);
    step += 1;
  }
  const fps = await framesPromise;

  const interaction = { name: 'screen-interaction', p95Ms: Math.round(p95(samples) * 100) / 100, samples: samples.length, budgetMs: PERF_BUDGETS.screenInteractionP95Ms, generatedAt: new Date().toISOString() };
  const render = { name: 'graph-render', fps: Math.round(fps * 10) / 10, windowMs: FPS_WINDOW_MS, budgetFps: PERF_BUDGETS.graphRenderFps, ciId, generatedAt: new Date().toISOString() };
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(resultsDir + 'screen-interaction.json', JSON.stringify(interaction, null, 2) + '\n');
  writeFileSync(resultsDir + 'graph-render.json', JSON.stringify(render, null, 2) + '\n');
  testInfo.annotations.push({ type: 'screen-interaction-p95-ms', description: String(interaction.p95Ms) }, { type: 'graph-render-fps', description: String(render.fps) });

  expect(interaction.p95Ms).toBeLessThanOrEqual(PERF_BUDGETS.screenInteractionP95Ms);
  expect(render.fps).toBeGreaterThanOrEqual(PERF_BUDGETS.graphRenderFps);
});
