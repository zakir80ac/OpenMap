'use client';
// REQ-UI-007 REQ-DEP-005 — runs the lane or force layout off the main thread. Small graphs are placed synchronously (a worker
// round trip would cost more than the layout); larger ones are posted to lane-layout.worker.ts and the latest
// answer wins, so a stale response for a superseded request is ignored.
import { DEPENDENCY_MAP } from '@openmap/constants';
import { useEffect, useRef, useState } from 'react';
import { layoutPositions, type LayoutRequest, type LayoutResponse } from '@/lib/graph-layout';

function createWorker(): Worker | undefined {
  if (typeof Worker === 'undefined') return undefined;
  try {
    return new Worker(new URL('./lane-layout.worker.ts', import.meta.url));
  } catch {
    return undefined;
  }
}

export function useLaneLayout(request: LayoutRequest | undefined): LayoutResponse | undefined {
  const [response, setResponse] = useState<LayoutResponse | undefined>(undefined);
  const workerRef = useRef<Worker | undefined>(undefined);

  useEffect(() => {
    if (request === undefined) {
      setResponse(undefined);
      return;
    }
    const worker =
      request.nodes.length >= DEPENDENCY_MAP.workerMinNodes
        ? (workerRef.current ??= createWorker())
        : undefined;
    if (worker === undefined) {
      setResponse(layoutPositions(request));
      return;
    }
    const onMessage = (event: MessageEvent<LayoutResponse>): void => {
      if (event.data.requestId === request.requestId) setResponse(event.data);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage(request);
    return () => {
      worker.removeEventListener('message', onMessage);
    };
  }, [request]);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = undefined;
    },
    [],
  );

  return response;
}
