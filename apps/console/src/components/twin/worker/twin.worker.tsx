// REQ-PERF-007 REQ-UI-029 (ADR-077) — the digital twin's renderer, in a worker. The page transfers its canvas here as
// an OffscreenCanvas, so the WebGL context, three.js, the scene's React tree and every frame stay off the main thread:
// on a host without a GPU, where the browser composites in software and reads each frame back, that work was the
// twin's longest main-thread task. The page forwards pointer input and the canvas size; this posts back what the
// operator selected or hovers, the cursor the orbit controls ask for, and where the labels sit on the canvas.
import './worker-env';
import { createEvents, createRoot, extend, type Catalogue, type EventManager, type Events, type Frameloop, type ReconcilerRoot, type RenderProps, type RootStore } from '@react-three/fiber';
import * as THREE from 'three';
import { GEOMETRY, TWIN } from '@openmap/constants';
import type { FacilityModel, GraphModel } from '@/lib/twin-model';
import { TwinSceneContent } from '../TwinSceneContent';
import type { ProjectedLabel, TwinSelection } from '../twin-selection';
import type { CanvasSize, ForwardedEvent, FromWorker, ToWorker } from './protocol';

// In the page the Canvas component registers three's classes as JSX elements (color, mesh and the rest); a bare root
// in a worker must register them itself.
extend(THREE as unknown as Catalogue);

interface WorkerScope {
  postMessage: (message: FromWorker) => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent<ToWorker>) => void) => void;
}
const scope = globalThis as unknown as WorkerScope;
const post = (message: FromWorker): void => {
  scope.postMessage(message);
};

/** A forwarded event as the scene's handlers receive it: the plain fields plus the methods they may call. */
type ShimEvent = ForwardedEvent & { preventDefault: () => void; stopPropagation: () => void; target: OffscreenCanvas | null };
type Listener = (event: ShimEvent) => void;
const listeners = new Map<string, Set<Listener>>();
const on = (name: string, listener: Listener): void => {
  const set = listeners.get(name) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(name, set);
};
const off = (name: string, listener: Listener): void => {
  listeners.get(name)?.delete(listener);
};

/** react-three-fiber's handler names and the DOM events behind them. */
const HANDLER_EVENTS: Readonly<Record<keyof Events, string>> = {
  onClick: 'click',
  onContextMenu: 'contextmenu',
  onDoubleClick: 'dblclick',
  onWheel: 'wheel',
  onPointerDown: 'pointerdown',
  onPointerUp: 'pointerup',
  onPointerLeave: 'pointerleave',
  onPointerMove: 'pointermove',
  onPointerCancel: 'pointercancel',
  onLostPointerCapture: 'lostpointercapture',
};

let canvas: OffscreenCanvas | null = null;
let root: ReconcilerRoot<OffscreenCanvas> | null = null;
let store: RootStore | null = null;
let size: CanvasSize = { width: 0, height: 0 };
let dpr = 1;
let frameloop: Frameloop = 'never';
let facility: FacilityModel | null = null;
let graph: GraphModel | null = null;
let selected: TwinSelection | null = null;
let hovered: TwinSelection | null = null;

/** Gives the OffscreenCanvas the element API the orbit controls and react-three-fiber's events expect. */
function shim(target: OffscreenCanvas): void {
  const style: Record<string, string> = { touchAction: 'none' };
  Object.defineProperty(style, 'cursor', {
    get: () => '',
    set: (cursor: string) => {
      post({ type: 'cursor', cursor });
    },
  });
  Object.assign(target, {
    style,
    ownerDocument: target,
    documentElement: target,
    defaultView: target,
    getRootNode: () => target,
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, width: size.width, height: size.height }),
    setAttribute: () => undefined,
    removeAttribute: () => undefined,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    hasPointerCapture: () => false,
    focus: () => undefined,
    addEventListener: on,
    removeEventListener: off,
  });
  for (const key of ['clientWidth', 'offsetWidth'] as const) Object.defineProperty(target, key, { get: () => size.width });
  for (const key of ['clientHeight', 'offsetHeight'] as const) Object.defineProperty(target, key, { get: () => size.height });
  for (const key of ['clientLeft', 'clientTop', 'offsetLeft', 'offsetTop'] as const) Object.defineProperty(target, key, { get: () => 0 });
}

/** react-three-fiber's pointer events, fed from the forwarded DOM events instead of listeners on an element. */
function pointerEvents(rootStore: RootStore): EventManager<HTMLElement> {
  const { handlePointer } = createEvents(rootStore);
  const handlers = Object.fromEntries(Object.keys(HANDLER_EVENTS).map((key) => [key, handlePointer(key)])) as unknown as Events;
  const bound = Object.entries(HANDLER_EVENTS).map(([key, name]) => [name, handlers[key as keyof Events] as unknown as Listener] as const);
  return {
    priority: 1,
    enabled: true,
    compute(event, state) {
      // Normalised device coordinates from the canvas offset: -1 to 1 across, 1 to -1 down.
      state.pointer.set((event.offsetX / state.size.width) * GEOMETRY.halfDivisor - 1, 1 - (event.offsetY / state.size.height) * GEOMETRY.halfDivisor);
      state.raycaster.setFromCamera(state.pointer, state.camera);
    },
    handlers,
    connect: (target) => {
      const { set, events } = rootStore.getState();
      events.disconnect?.();
      set((state) => ({ events: { ...state.events, connected: target } }));
      for (const [name, listener] of bound) on(name, listener);
    },
    disconnect: () => {
      const { set, events } = rootStore.getState();
      if (events.connected === undefined) return;
      for (const [name, listener] of bound) off(name, listener);
      set((state) => ({ events: { ...state.events, connected: undefined } }));
    },
  };
}

/** Every root option on every call: configure resets what it is not given (the frame loop would start running). */
function rootProps(): RenderProps<OffscreenCanvas> {
  return {
    events: pointerEvents,
    size: { width: size.width, height: size.height, top: 0, left: 0 },
    dpr,
    frameloop,
    camera: { fov: TWIN.cameraFov, near: TWIN.cameraNearM, far: TWIN.cameraFarM },
    gl: { antialias: true, powerPreference: 'high-performance' },
    onPointerMissed: () => {
      post({ type: 'select', selection: null });
    },
  };
}

/** The shaders are compiled: from now on the root draws when something changes. */
function compiled(): void {
  if (root === null || frameloop === 'demand') return;
  frameloop = 'demand';
  void root.configure(rootProps()).then(() => {
    store?.getState().invalidate();
  });
}

function draw(): void {
  if (root === null || facility === null) return;
  store = root.render(
    <TwinSceneContent
      facility={facility}
      graph={graph}
      selected={selected}
      hovered={hovered}
      onCompiled={compiled}
      onHover={(selection) => {
        post({ type: 'hover', selection });
      }}
      onSelect={(selection) => {
        post({ type: 'select', selection });
      }}
      onLabels={(labels: ProjectedLabel[]) => {
        post({ type: 'labels', labels });
      }}
    />,
  );
}

async function init(target: OffscreenCanvas, initialSize: CanvasSize, pixelRatio: number): Promise<void> {
  canvas = target;
  size = initialSize;
  dpr = Math.min(Math.max(1, pixelRatio), TWIN.dprMax);
  shim(target);
  const created = createRoot(target);
  await created.configure(rootProps());
  root = created;
  // Listeners the controls add to the window (pointer moves and ups while dragging) reach the forwarded events.
  (globalThis as unknown as Record<string, unknown>)['window'] = target;
  draw();
}

scope.addEventListener('message', (message) => {
  const data = message.data;
  switch (data.type) {
    case 'init':
      init(data.canvas, data.size, data.pixelRatio).catch((error: unknown) => {
        post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      });
      return;
    case 'resize':
      size = data.size;
      if (root !== null) void root.configure(rootProps());
      return;
    case 'event': {
      const event: ShimEvent = { ...data.event, preventDefault: () => undefined, stopPropagation: () => undefined, target: canvas };
      listeners.get(data.name)?.forEach((listener) => {
        listener(event);
      });
      return;
    }
    case 'models':
      facility = data.facility;
      graph = data.graph;
      draw();
      return;
    case 'selection':
      selected = data.selected;
      hovered = data.hovered;
      draw();
      return;
  }
});
