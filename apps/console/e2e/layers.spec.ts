// T-126 REQ-UI-033 — the Layers screen on the real stack, per locale project: the equipment scene renders a WebGL
// canvas with a plane per layer (the accessible plane list mirrors it), focusing a layer from its row zooms the
// scene onto it and Escape returns, toggling a layer's switch hides its plane (data-visible), and the screen is
// captured in both states.
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CI_LAYERS } from '@openmap/contracts';
import { isLocale, translate } from '@openmap/i18n';
import { signIn } from './auth';

const screenshotsDir = fileURLToPath(new URL('./screenshots/', import.meta.url));
const SCENE_TIMEOUT_MS = 30_000;

test('the layer stack renders every layer in 3D and follows the visibility switches', async ({ page }, testInfo) => {
  const locale = testInfo.project.name;
  if (!isLocale(locale)) throw new Error('project name must be a locale: ' + locale);
  test.setTimeout(SCENE_TIMEOUT_MS * 3);

  await page.goto('/' + locale + '/layers');
  await signIn(page, locale);
  const canvas = page.locator('[data-testid="layer-stack-canvas"] canvas');
  await expect(canvas).toBeVisible({ timeout: SCENE_TIMEOUT_MS });
  const stack = page.locator('[data-testid="layer-stack-tiers"]');
  for (const layer of CI_LAYERS) await expect(stack.locator('[data-layer="' + layer + '"]')).toHaveAttribute('data-visible', 'true', { timeout: SCENE_TIMEOUT_MS });
  await page.screenshot({ path: screenshotsDir + 'layers-stack-' + locale + '.png', fullPage: false });

  // Focus the storage layer from its row: the focus panel names it and Escape returns to the stack.
  await page.getByRole('button', { name: translate(locale, 'layers.focusOn', { layer: translate(locale, 'layer.storage') }) }).click();
  const panel = page.getByTestId('layer-focus-panel');
  await expect(panel).toBeVisible({ timeout: SCENE_TIMEOUT_MS });
  await expect(panel.getByText(translate(locale, 'layer.storage'))).toBeVisible();
  await expect(page.getByTestId('layer-stack-canvas')).toHaveAttribute('data-focused', 'storage');
  await page.screenshot({ path: screenshotsDir + 'layers-focus-' + locale + '.png', fullPage: false });
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0, { timeout: SCENE_TIMEOUT_MS });

  // Hide the storage layer from the list: its plane is hidden in the scene and the plane list.
  const storageLabel = translate(locale, 'layer.storage');
  await page.getByRole('switch', { name: translate(locale, 'layers.toggle', { layer: storageLabel }) }).click();
  await expect(stack.locator('[data-layer="storage"]')).toHaveAttribute('data-visible', 'false', { timeout: SCENE_TIMEOUT_MS });
  await page.getByRole('switch', { name: translate(locale, 'layers.toggle', { layer: storageLabel }) }).click();
  await expect(stack.locator('[data-layer="storage"]')).toHaveAttribute('data-visible', 'true', { timeout: SCENE_TIMEOUT_MS });
});
