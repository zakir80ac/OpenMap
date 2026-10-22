// REQ-UI-005 — layer visibility: defaults to every layer visible, persists toggles in localStorage, survives junk.
import { act, renderHook } from '@testing-library/react';
import { CI_LAYERS } from '@openmap/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { LAYER_VISIBILITY_STORAGE_KEY, useLayerVisibility } from './useLayerVisibility';

function stored(): Record<string, unknown> {
  return JSON.parse(window.localStorage.getItem(LAYER_VISIBILITY_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('useLayerVisibility', () => {
  it('defaults to every layer visible', () => {
    const { result } = renderHook(() => useLayerVisibility());
    expect(result.current.visibleCount).toBe(CI_LAYERS.length);
    for (const layer of CI_LAYERS) expect(result.current.isVisible(layer)).toBe(true);
  });

  it('toggles a layer and persists the change', () => {
    const { result } = renderHook(() => useLayerVisibility());
    act(() => {
      result.current.toggle('storage');
    });
    expect(result.current.isVisible('storage')).toBe(false);
    expect(result.current.visibleCount).toBe(CI_LAYERS.length - 1);
    expect(stored()).toMatchObject({ storage: false, dc: true });

    act(() => {
      result.current.toggle('storage');
    });
    expect(result.current.isVisible('storage')).toBe(true);
    expect(stored()).toMatchObject({ storage: true });
  });

  it('reads an existing preference and ignores unknown or malformed entries', () => {
    window.localStorage.setItem(LAYER_VISIBILITY_STORAGE_KEY, JSON.stringify({ cloud: false, bogus: 'x', dc: 'yes' }));
    const { result } = renderHook(() => useLayerVisibility());
    expect(result.current.isVisible('cloud')).toBe(false);
    expect(result.current.isVisible('dc')).toBe(true);
    expect(result.current.visibleCount).toBe(CI_LAYERS.length - 1);
  });

  it('falls back to all visible when storage is corrupt', () => {
    window.localStorage.setItem(LAYER_VISIBILITY_STORAGE_KEY, '{not json');
    const { result } = renderHook(() => useLayerVisibility());
    expect(result.current.visibleCount).toBe(CI_LAYERS.length);
  });

  it('showAll restores every layer and setVisible targets one layer', () => {
    const { result } = renderHook(() => useLayerVisibility());
    act(() => {
      result.current.setVisible('os', false);
      result.current.setVisible('saas', false);
    });
    expect(result.current.visibleCount).toBe(CI_LAYERS.length - 2);
    act(() => {
      result.current.showAll();
    });
    expect(result.current.visibleCount).toBe(CI_LAYERS.length);
    expect(stored()).toMatchObject({ os: true, saas: true });
  });

  it('shares state between two mounted hooks', () => {
    const first = renderHook(() => useLayerVisibility());
    const second = renderHook(() => useLayerVisibility());
    act(() => {
      first.result.current.toggle('containers');
    });
    expect(second.result.current.isVisible('containers')).toBe(false);
  });
});
