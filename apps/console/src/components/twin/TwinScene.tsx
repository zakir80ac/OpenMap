'use client';
// REQ-UI-029 REQ-UI-037 REQ-PERF-007 (ADR-077) — the digital twin's canvas in the page. The scene renders in a worker:
// this transfers the canvas there as an OffscreenCanvas, forwards pointer input and the canvas size, sends the facility,
// the graph and the selection, and takes back what the operator selected or hovers, the cursor, and where the labels
// sit, which it draws as DOM over the canvas. A browser that cannot transfer a canvas (or whose worker fails) gets the
// same scene on a canvas in the page.
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { sceneLabel, type FacilityModel, type GraphModel, type RackBox } from '@/lib/twin-model';
import type { ProjectedLabel, TwinSelection } from './twin-selection';
import { FORWARDED_EVENTS, forwardEvent, type FromWorker, type ToWorker } from './worker/protocol';

export { openRackId, type TwinSelection } from './twin-selection';

export interface TwinSceneProps {
  facility: FacilityModel;
  graph: GraphModel | null;
  selected: TwinSelection | null;
  hovered: TwinSelection | null;
  onHover: (selection: TwinSelection | null) => void;
  onSelect: (selection: TwinSelection | null) => void;
  /** Accessible name of the canvas. */
  label: string;
  /** Text shown with a hovered or selected rack: `{name} · {units}U · {load}%`. */
  rackCaption: (rack: RackBox) => string;
}

const LABEL_CLASS = 'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-om-control border border-om-border-strong bg-om-surface1/90 px-om-8 py-om-4 font-om-mono text-om-2xs text-om-primary shadow-om-card';

const TwinCanvasInPage = dynamic(() => import('./TwinCanvasInPage').then((m) => ({ default: m.TwinCanvasInPage })), { ssr: false });

/** Canvases already handed to a worker: React's development double mount must not transfer one twice. */
const transferred = new WeakSet<HTMLCanvasElement>();

export function TwinScene({ facility, graph, selected, hovered, onHover, onSelect, label, rackCaption }: TwinSceneProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const [inPage, setInPage] = useState(false);
  // A fresh canvas element when one was already transferred (a remount in development).
  const [generation, setGeneration] = useState(0);
  const [labels, setLabels] = useState<ProjectedLabel[]>([]);
  const [cursor, setCursor] = useState('auto');
  const callbacks = useRef({ onHover, onSelect });
  callbacks.current = { onHover, onSelect };
  // The latest models and selection, for a worker that starts after they arrived.
  const latest = useRef({ facility, graph, selected, hovered });
  latest.current = { facility, graph, selected, hovered };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || inPage) return;
    if (transferred.has(canvas)) {
      setGeneration((g) => g + 1);
      return;
    }
    if (typeof canvas.transferControlToOffscreen !== 'function' || typeof Worker === 'undefined') {
      setInPage(true);
      return;
    }
    let worker: Worker;
    let offscreen: OffscreenCanvas;
    try {
      worker = new Worker(new URL('./worker/twin.worker.tsx', import.meta.url), { type: 'module' });
      offscreen = canvas.transferControlToOffscreen();
    } catch {
      setInPage(true);
      return;
    }
    transferred.add(canvas);
    workerRef.current = worker;
    const post = (message: ToWorker, transfer: Transferable[] = []): void => {
      worker.postMessage(message, transfer);
    };
    worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
      const data = event.data;
      switch (data.type) {
        case 'select':
          callbacks.current.onSelect(data.selection);
          return;
        case 'hover':
          callbacks.current.onHover(data.selection);
          return;
        case 'cursor':
          setCursor(data.cursor === '' ? 'auto' : data.cursor);
          return;
        case 'labels':
          setLabels(data.labels);
          return;
        case 'error':
          // The canvas went to the worker and cannot come back: the in-page scene gets a canvas of its own.
          setInPage(true);
          return;
      }
    });
    worker.addEventListener('error', () => {
      setInPage(true);
    });
    post({ type: 'init', canvas: offscreen, size: { width: canvas.clientWidth, height: canvas.clientHeight }, pixelRatio: window.devicePixelRatio }, [offscreen]);
    post({ type: 'models', facility: latest.current.facility, graph: latest.current.graph });
    post({ type: 'selection', selected: latest.current.selected, hovered: latest.current.hovered });

    const forwarded = FORWARDED_EVENTS.map(([name, passive]) => {
      const listener = (event: Event): void => {
        if (!passive) event.preventDefault();
        const pointer = event as PointerEvent;
        if (name === 'pointerdown') canvas.setPointerCapture(pointer.pointerId);
        else if (name === 'pointerup' && canvas.hasPointerCapture(pointer.pointerId)) canvas.releasePointerCapture(pointer.pointerId);
        post({ type: 'event', name, event: forwardEvent(event) });
      };
      canvas.addEventListener(name, listener, { passive });
      return [name, listener] as const;
    });
    const observer = new ResizeObserver(() => {
      post({ type: 'resize', size: { width: canvas.clientWidth, height: canvas.clientHeight } });
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      for (const [name, listener] of forwarded) canvas.removeEventListener(name, listener);
      worker.terminate();
      workerRef.current = null;
    };
  }, [inPage, generation]);

  useEffect(() => {
    workerRef.current?.postMessage({ type: 'models', facility, graph } satisfies ToWorker);
  }, [facility, graph]);
  useEffect(() => {
    workerRef.current?.postMessage({ type: 'selection', selected, hovered } satisfies ToWorker);
  }, [selected, hovered]);

  const caption = (label: ProjectedLabel): string => {
    if (label.kind === 'rack') {
      const rack = facility.racks.find((r) => r.id === label.key);
      return rack === undefined ? '' : rackCaption(rack);
    }
    const node = graph?.nodes.find((n) => n.id === label.key);
    return node === undefined ? '' : sceneLabel(node.label);
  };

  return (
    <div className="relative h-full w-full overflow-hidden">
      {inPage ? (
        <TwinCanvasInPage facility={facility} graph={graph} selected={selected} hovered={hovered} onHover={onHover} onSelect={onSelect} onLabels={setLabels} label={label} />
      ) : (
        <canvas key={generation} ref={canvasRef} aria-label={label} role="img" className="block h-full w-full touch-none" style={{ cursor }} />
      )}
      {labels.map((item) => (
        // Canvas pixels from its top left corner, in either reading direction.
        <span key={item.key} className={LABEL_CLASS} style={{ left: item.x, top: item.y }}>
          {caption(item)}
        </span>
      ))}
    </div>
  );
}
