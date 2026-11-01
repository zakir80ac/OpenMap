'use client';
// REQ-UI-007 REQ-DEP-003 REQ-DEP-005 — Sigma.js WebGL canvas for the dependency map (ADR-007). Owns one graphology
// graph and one Sigma renderer; the parent supplies nodes, edges, positions and an optional highlight set (the
// isolated blast radius: everything outside it is dimmed through Sigma reducers), and receives hover, click and
// double-click events. Lane guides and labels are HTML overlays re-projected after every render.
import Graph from 'graphology';
import Sigma from 'sigma';
import { CONSOLE_ALPHA, DEPENDENCY_MAP } from '@openmap/constants';
import type { CiLayer } from '@openmap/contracts';
import { cx, layerColor, surfaces, text, withAlpha } from '@openmap/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import {
  nodeColor,
  nodeSize,
  predictedColor,
  relationshipColor,
  type ImpactGraph,
  type Lane,
  type MapNode,
  type Position,
} from '@/lib/graph-layout';
import { layerKey } from '@/lib/keys';
import { useT } from '@/providers';

export interface HoverInfo {
  node: MapNode;
  /** Pointer position relative to the canvas container, px. */
  x: number;
  y: number;
}

export interface DependencyCanvasProps {
  graph: ImpactGraph;
  positions: Record<string, Position>;
  lanes: Lane[];
  /** Relationship type per edge id (`source→target`) when known; those edges take their family colour. */
  edgeTypes: ReadonlyMap<string, string>;
  rootId: string;
  /** Node ids that stay lit; when set, every other node and edge is dimmed. */
  highlight?: ReadonlySet<string> | undefined;
  label: string;
  onHover: (info: HoverInfo | undefined) => void;
  /** Single click: the parent isolates the node's blast radius. */
  onSelect: (node: MapNode) => void;
  /** Double click: the parent opens the CI. */
  onOpen: (node: MapNode) => void;
  className?: string;
}

interface LaneGuide {
  layer: CiLayer;
  top: number;
  count: number;
}

const LABEL_BACKDROP_ALPHA = CONSOLE_ALPHA.labelBackdrop;
const BRIDGED_EDGE_ALPHA = CONSOLE_ALPHA.bridgedEdge;
const HOVER_ALPHA = CONSOLE_ALPHA.laneTint;
const DIMMED_ALPHA = CONSOLE_ALPHA.dimmedNode;
const DIMMED_Z_INDEX = -1;

/** Nodes are keyed by CI id; attribute names are the ones Sigma's default styles bind (x, y, size, color, label). */
function fillGraph(
  target: Graph,
  graph: ImpactGraph,
  positions: Record<string, Position>,
  edgeTypes: ReadonlyMap<string, string>,
  rootId: string,
): void {
  target.clear();
  for (const node of graph.nodes) {
    const position = positions[node.id];
    if (position === undefined) continue;
    target.addNode(node.id, {
      x: position.x,
      y: position.y,
      size: nodeSize(node.depth),
      color: nodeColor(node),
      dimColor: withAlpha(nodeColor(node), DIMMED_ALPHA),
      label: node.label,
      zIndex: node.id === rootId ? 1 : 0,
    });
  }
  for (const edge of graph.edges) {
    if (
      !target.hasNode(edge.source) ||
      !target.hasNode(edge.target) ||
      target.hasEdge(edge.source, edge.target)
    )
      continue;
    const type = edgeTypes.get(edge.id);
    const base = type === undefined ? predictedColor(edge.predicted) : relationshipColor(type);
    target.addEdgeWithKey(edge.id, edge.source, edge.target, {
      size: edge.onServicePath ? DEPENDENCY_MAP.pathEdgeSize : DEPENDENCY_MAP.edgeSize,
      color: edge.bridged ? withAlpha(base, BRIDGED_EDGE_ALPHA) : base,
      zIndex: edge.onServicePath ? 1 : 0,
    });
  }
}

export function DependencyCanvas({
  graph,
  positions,
  lanes,
  edgeTypes,
  rootId,
  highlight,
  label,
  onHover,
  onSelect,
  onOpen,
  className,
}: DependencyCanvasProps): ReactNode {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | undefined>(undefined);
  const graphRef = useRef<Graph>(new Graph({ type: 'directed' }));
  const graphDataRef = useRef(graph);
  graphDataRef.current = graph;
  const handlersRef = useRef({ onHover, onSelect, onOpen });
  handlersRef.current = { onHover, onSelect, onOpen };
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const [guides, setGuides] = useState<LaneGuide[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;

  // Create the renderer once per mount; WebGL failures fall back to the textual panel beside the canvas.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let sigma: Sigma;
    try {
      sigma = new Sigma(graphRef.current, container, {
        settings: {
          renderLabels: true,
          labelRenderedSizeThreshold: DEPENDENCY_MAP.labelRenderedSizeThreshold,
          minCameraRatio: DEPENDENCY_MAP.cameraMinRatio,
          maxCameraRatio: DEPENDENCY_MAP.cameraMaxRatio,
          zoomDuration: DEPENDENCY_MAP.zoomDurationMs,
          enableNodeDrag: false,
          enableCameraRotation: false,
        },
        // Reducers read the current highlight set: outside the isolated blast radius nodes fade and lose their
        // label, edges hide. With no highlight everything renders as filled.
        nodeReducer: (node, data) => {
          const lit = highlightRef.current;
          if (lit === undefined || lit.has(node)) return data;
          const dimColor = graphRef.current.getNodeAttribute(node, 'dimColor') as string | undefined;
          return { ...data, color: dimColor ?? data.color, label: null, zIndex: DIMMED_Z_INDEX };
        },
        edgeReducer: (edge, data) => {
          const lit = highlightRef.current;
          if (lit === undefined) return data;
          const [source, target] = graphRef.current.extremities(edge);
          return lit.has(source) && lit.has(target) ? data : { ...data, hidden: true };
        },
        styles: {
          nodes: {
            labelColor: text.primary,
            labelSize: DEPENDENCY_MAP.labelSize,
            backdropColor: withAlpha(surfaces.surface2, LABEL_BACKDROP_ALPHA),
          },
        },
      });
    } catch {
      setUnsupported(true);
      return;
    }
    sigmaRef.current = sigma;

    const project = (): void => {
      const next: LaneGuide[] = lanesRef.current.map((lane) => ({
        layer: lane.layer,
        top: sigma.graphToViewport({ x: 0, y: lane.y }).y,
        count: lane.count,
      }));
      const key = (guide: LaneGuide): string =>
        guide.layer + ':' + String(guide.top) + ':' + String(guide.count);
      setGuides((current) => (current.map(key).join('|') === next.map(key).join('|') ? current : next));
    };

    sigma.on('afterRender', project);
    sigma.on('enterNode', ({ node, event }) => {
      const data = graphDataRef.current.nodes.find((n) => n.id === node);
      if (data !== undefined) handlersRef.current.onHover({ node: data, x: event.x, y: event.y });
    });
    sigma.on('leaveNode', () => {
      handlersRef.current.onHover(undefined);
    });
    sigma.on('clickNode', ({ node }) => {
      const data = graphDataRef.current.nodes.find((n) => n.id === node);
      if (data !== undefined) handlersRef.current.onSelect(data);
    });
    sigma.on('doubleClickNode', ({ node, event }) => {
      event.preventSigmaDefault();
      const data = graphDataRef.current.nodes.find((n) => n.id === node);
      if (data !== undefined) handlersRef.current.onOpen(data);
    });
    sigma.on('clickStage', () => {
      handlersRef.current.onHover(undefined);
    });

    return () => {
      sigma.kill();
      sigmaRef.current = undefined;
    };
  }, []);

  // Re-fill the graphology graph whenever the model or the layout changes, then fit the camera.
  useEffect(() => {
    fillGraph(graphRef.current, graph, positions, edgeTypes, rootId);
    const sigma = sigmaRef.current;
    if (sigma === undefined) return;
    sigma.refresh();
    void sigma.getCamera().reset({ duration: DEPENDENCY_MAP.zoomDurationMs });
  }, [graph, positions, edgeTypes, rootId]);

  // Dimming is a reducer concern: a changed highlight only needs a redraw.
  useEffect(() => {
    sigmaRef.current?.refresh({ skipIndexation: true });
  }, [highlight]);

  const zoom = (direction: 'in' | 'out' | 'fit'): void => {
    const camera = sigmaRef.current?.getCamera();
    if (camera === undefined) return;
    const options = { duration: DEPENDENCY_MAP.zoomDurationMs };
    if (direction === 'in') void camera.zoomIn(options);
    else if (direction === 'out') void camera.zoomOut(options);
    else void camera.reset(options);
  };

  return (
    <div
      className={cx(
        'relative isolate overflow-hidden rounded-om-panel-lg border border-om-border-glass bg-om-surface1',
        className,
      )}
    >
      <div ref={containerRef} role="img" aria-label={label} className="absolute inset-0" />

      {guides.map((guide) => (
        <div
          key={guide.layer}
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 flex items-center gap-om-8 px-om-12"
          style={{ top: guide.top, transform: 'translateY(-50%)' }}
        >
          <span
            className="rounded-om-tag px-om-6 py-om-4 font-om-display text-om-2xs font-semibold uppercase tracking-[0.1em]"
            style={{
              color: layerColor(guide.layer),
              background: withAlpha(layerColor(guide.layer), HOVER_ALPHA),
            }}
          >
            {t(layerKey(guide.layer))}
          </span>
          <span
            className="h-px flex-1"
            style={{ background: withAlpha(layerColor(guide.layer), HOVER_ALPHA) }}
          />
        </div>
      ))}

      {unsupported ? (
        <p
          role="alert"
          className="absolute inset-x-om-24 top-1/2 -translate-y-1/2 text-center text-om-sm text-om-secondary"
        >
          {t('dependencies.canvas.unsupported')}
        </p>
      ) : null}

      <div
        role="group"
        aria-label={t('dependencies.toolbar')}
        className="absolute start-om-16 top-om-16 flex gap-om-6 rounded-om-panel border border-om-border-strong bg-om-surface1/80 p-om-6 backdrop-blur-md"
      >
        {(['in', 'out', 'fit'] as const).map((direction) => (
          <button
            key={direction}
            type="button"
            aria-label={t(
              direction === 'in'
                ? 'dependencies.zoomIn'
                : direction === 'out'
                  ? 'dependencies.zoomOut'
                  : 'dependencies.fit',
            )}
            onClick={() => {
              zoom(direction);
            }}
            className="grid size-8 place-items-center rounded-om-control text-om-secondary transition-colors duration-om-fast hover:bg-om-surface3 hover:text-om-primary"
          >
            <Icon
              name={direction === 'in' ? 'zoomIn' : direction === 'out' ? 'zoomOut' : 'fit'}
              className="size-4"
            />
          </button>
        ))}
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-om-16 end-om-16 flex items-center gap-om-12 rounded-om-panel border border-om-border-strong bg-om-surface1/80 px-om-12 py-om-8 text-om-2xs text-om-secondary backdrop-blur-md"
      >
        <span>{t('dependencies.hud.renderer')}</span>
      </div>
    </div>
  );
}
