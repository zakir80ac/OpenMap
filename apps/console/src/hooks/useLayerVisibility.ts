'use client';
// REQ-UI-005 — per-device layer visibility. Persisted in localStorage and read through useSyncExternalStore, so the
// value is consistent across every mounted view without effects; the server snapshot is "everything visible".
import { CI_LAYERS, type CiLayer } from '@openmap/contracts';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

export type LayerVisibility = Readonly<Record<CiLayer, boolean>>;

export const LAYER_VISIBILITY_STORAGE_KEY = 'openmap.console.layerVisibility';

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedValue: LayerVisibility | undefined;
/** Used when localStorage is unavailable (private mode, quota), so toggles still work for the session. */
let memoryRaw: string | null = null;

function everyLayer(visible: boolean): Record<CiLayer, boolean> {
  const out: Partial<Record<CiLayer, boolean>> = {};
  for (const layer of CI_LAYERS) out[layer] = visible;
  return out as Record<CiLayer, boolean>;
}

export function allLayersVisible(): LayerVisibility {
  return everyLayer(true);
}

function parse(raw: string | null): LayerVisibility {
  const base = everyLayer(true);
  if (raw === null) return base;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const layer of CI_LAYERS) {
        const value = record[layer];
        if (typeof value === 'boolean') base[layer] = value;
      }
    }
  } catch {
    // Corrupt storage falls back to every layer visible rather than hiding data.
  }
  return base;
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(LAYER_VISIBILITY_STORAGE_KEY) ?? memoryRaw;
  } catch {
    return memoryRaw;
  }
}

function getSnapshot(): LayerVisibility {
  const raw = readRaw();
  if (cachedValue === undefined || raw !== cachedRaw) {
    cachedRaw = raw;
    cachedValue = parse(raw);
  }
  return cachedValue;
}

const SERVER_SNAPSHOT: LayerVisibility = allLayersVisible();

function getServerSnapshot(): LayerVisibility {
  return SERVER_SNAPSHOT;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === LAYER_VISIBILITY_STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function write(next: LayerVisibility): void {
  const raw = JSON.stringify(next);
  memoryRaw = raw;
  try {
    window.localStorage.setItem(LAYER_VISIBILITY_STORAGE_KEY, raw);
  } catch {
    // Storage unavailable: memoryRaw keeps the session consistent.
  }
  for (const listener of listeners) listener();
}

export interface LayerVisibilityApi {
  visibility: LayerVisibility;
  isVisible: (layer: CiLayer) => boolean;
  setVisible: (layer: CiLayer, visible: boolean) => void;
  toggle: (layer: CiLayer) => void;
  showAll: () => void;
  visibleCount: number;
}

export function useLayerVisibility(): LayerVisibilityApi {
  const visibility = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setVisible = useCallback((layer: CiLayer, visible: boolean) => {
    write({ ...getSnapshot(), [layer]: visible });
  }, []);
  const toggle = useCallback(
    (layer: CiLayer) => {
      setVisible(layer, !getSnapshot()[layer]);
    },
    [setVisible],
  );
  const showAll = useCallback(() => {
    write(allLayersVisible());
  }, []);
  return useMemo<LayerVisibilityApi>(
    () => ({
      visibility,
      isVisible: (layer) => visibility[layer],
      setVisible,
      toggle,
      showAll,
      visibleCount: CI_LAYERS.filter((layer) => visibility[layer]).length,
    }),
    [visibility, setVisible, toggle, showAll],
  );
}
