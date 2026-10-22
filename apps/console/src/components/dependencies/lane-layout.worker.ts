// REQ-UI-007 REQ-DEP-005 — layout Web Worker: receives a LayoutRequest, answers with a LayoutResponse. The lane
// layout itself lives in @/lib/graph-layout so the main-thread fallback and this worker run identical code.
import { assignLanePositions, type LayoutRequest, type LayoutResponse } from '@/lib/graph-layout';

interface WorkerScope {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
  postMessage: (message: LayoutResponse) => void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  scope.postMessage(assignLanePositions(event.data));
};
