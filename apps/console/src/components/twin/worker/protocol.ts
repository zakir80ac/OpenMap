// REQ-PERF-007 (ADR-077) — the messages between the twin's host in the page and its renderer in a worker. Only plain
// data crosses: the OffscreenCanvas once, then the scene's models, the selection, forwarded pointer input and the canvas
// size in; selection, hover, cursor and projected labels out.
import type { FacilityModel, GraphModel } from '@/lib/twin-model';
import type { ProjectedLabel, TwinSelection } from '../twin-selection';

/** The DOM events the host forwards, with whether the host may let the browser act on them (passive). */
export const FORWARDED_EVENTS: ReadonlyArray<readonly [name: string, passive: boolean]> = [
  ['click', false],
  ['contextmenu', false],
  ['dblclick', false],
  // Not passive: the orbit controls zoom on the wheel, and the page must not scroll under them.
  ['wheel', false],
  ['pointerdown', true],
  ['pointerup', true],
  ['pointerleave', true],
  ['pointermove', true],
  ['pointercancel', true],
  ['lostpointercapture', true],
];

/** The fields of a pointer or wheel event the scene's raycaster and orbit controls read. */
export interface ForwardedEvent {
  pointerId: number;
  pointerType: string;
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  pageX: number;
  pageY: number;
  x: number;
  y: number;
  movementX: number;
  movementY: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas; size: CanvasSize; pixelRatio: number }
  | { type: 'resize'; size: CanvasSize }
  | { type: 'event'; name: string; event: ForwardedEvent }
  | { type: 'models'; facility: FacilityModel; graph: GraphModel | null }
  | { type: 'selection'; selected: TwinSelection | null; hovered: TwinSelection | null };

export type FromWorker =
  | { type: 'error'; message: string }
  | { type: 'select'; selection: TwinSelection | null }
  | { type: 'hover'; selection: TwinSelection | null }
  | { type: 'cursor'; cursor: string }
  | { type: 'labels'; labels: ProjectedLabel[] };

/** The plain fields of a DOM pointer or wheel event; absent ones (a pointer event has no delta) are zero. */
export function forwardEvent(event: Event): ForwardedEvent {
  const e = event as Partial<PointerEvent & WheelEvent>;
  const n = (v: number | undefined): number => v ?? 0;
  return {
    pointerId: n(e.pointerId),
    pointerType: e.pointerType ?? 'mouse',
    button: n(e.button),
    buttons: n(e.buttons),
    clientX: n(e.clientX),
    clientY: n(e.clientY),
    offsetX: n(e.offsetX),
    offsetY: n(e.offsetY),
    pageX: n(e.pageX),
    pageY: n(e.pageY),
    x: n(e.x),
    y: n(e.y),
    movementX: n(e.movementX),
    movementY: n(e.movementY),
    deltaX: n(e.deltaX),
    deltaY: n(e.deltaY),
    deltaMode: n(e.deltaMode),
    altKey: e.altKey ?? false,
    ctrlKey: e.ctrlKey ?? false,
    metaKey: e.metaKey ?? false,
    shiftKey: e.shiftKey ?? false,
  };
}
