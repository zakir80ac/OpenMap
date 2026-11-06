// T-200 REQ-CMDB-021 — the shared layer-visibility rule for estate-wide lists: the layer a person picks always wins,
// hidden layers are otherwise left out, no restriction while every layer is visible; the notice names the hidden
// layers in either locale and Show all clears them.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CI_LAYERS } from '@openmap/contracts';
import { LOCALES, translate } from '@openmap/i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { LAYER_VISIBILITY_STORAGE_KEY, allLayersVisible } from '@/hooks/useLayerVisibility';
import { Providers } from '@/providers';
import { HiddenLayersNotice, hiddenLayers, visibleLayersFilter } from './HiddenLayersNotice';

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(LAYER_VISIBILITY_STORAGE_KEY);
});

describe('visibleLayersFilter', () => {
  it('prefers the picked layer, else the visible ones, else nothing', () => {
    const all = allLayersVisible();
    expect(visibleLayersFilter(all, null)).toBeNull();
    expect(visibleLayersFilter(all, 'dc')).toEqual(['dc']);
    const some = { ...all, cloud: false, saas: false };
    expect(visibleLayersFilter(some, undefined)).toEqual(
      CI_LAYERS.filter((l) => l !== 'cloud' && l !== 'saas'),
    );
    expect(visibleLayersFilter(some, 'cloud')).toEqual(['cloud']);
    expect(hiddenLayers(some)).toEqual(['cloud', 'saas']);
  });
});

describe.each(LOCALES)('HiddenLayersNotice (%s)', (locale) => {
  it('names hidden layers and shows them all again', () => {
    window.localStorage.setItem(LAYER_VISIBILITY_STORAGE_KEY, JSON.stringify({ cloud: false, saas: false }));
    render(
      <Providers locale={locale}>
        <HiddenLayersNotice locale={locale} />
      </Providers>,
    );
    const notice = screen.getByTestId('hidden-layers');
    expect(notice.textContent).toContain(translate(locale, 'layer.cloud'));
    expect(notice.textContent).toContain(translate(locale, 'layer.saas'));
    expect(
      screen.getByRole('link', { name: translate(locale, 'layers.hidden.manage') }).getAttribute('href'),
    ).toContain('/layers');
    fireEvent.click(screen.getByRole('button', { name: translate(locale, 'layers.hidden.showAll') }));
    expect(screen.queryByTestId('hidden-layers')).toBeNull();
  });

  it('renders nothing while every layer is visible', () => {
    render(
      <Providers locale={locale}>
        <HiddenLayersNotice locale={locale} />
      </Providers>,
    );
    expect(screen.queryByTestId('hidden-layers')).toBeNull();
  });
});
