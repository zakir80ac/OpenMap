'use client';
// REQ-UI-029 REQ-UI-037 REQ-PERF-007 — the digital twin's scene (ADR-018): rooms as glass slabs, racks and device
// plates as instanced boxes at true proportions, the layer planes stacked above with the focus CI's dependency graph as
// spheres and lines. Orbit to look around, hover for a label, click a rack or a node to select it. Rendering is on
// demand: a frame is drawn only when the camera or the selection changes, so an idle twin costs nothing.
// ADR-077: the same content runs in a worker on an OffscreenCanvas (twin.worker.tsx) or, where the browser cannot
// transfer a canvas, in the page (TwinCanvasInPage.tsx). It touches no DOM: labels are projected to screen positions
// and the host draws them.
import { Edges, Grid, Instance, Instances, Line, OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { GEOMETRY, TWIN } from '@openmap/constants';
import { accents, ground, text, withAlpha } from '@openmap/ui/tokens';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Vector3 } from 'three';
import { cameraStart, sceneRadius, xyz, type FacilityModel, type GraphModel, type Vec3 } from '@/lib/twin-model';
import { InstancedBoxes, type BoxInstance } from './InstancedBoxes';
import { labelAnchors, openRackId, type ProjectedLabel, type TwinSelection } from './twin-selection';

export interface TwinSceneContentProps {
  facility: FacilityModel;
  graph: GraphModel | null;
  selected: TwinSelection | null;
  hovered: TwinSelection | null;
  onHover: (selection: TwinSelection | null) => void;
  onSelect: (selection: TwinSelection | null) => void;
  /** The labels shown, projected to the canvas, whenever a frame is drawn and they moved. */
  onLabels: (labels: ProjectedLabel[]) => void;
  /** Every shader is compiled: the host switches its root from frameloop 'never' to 'demand'. */
  onCompiled: () => void;
}

// REQ-PERF-001: Lambert, not the physically based standard material: the boxes need diffuse light and an emissive
// glow only, and the standard material's far larger shader made the first frame's compile a long task.

function RoomSlabs({ facility }: { facility: FacilityModel }): ReactNode {
  return (
    <group>
      {facility.rooms.map((room) => (
        <mesh key={room.id} position={xyz(room.center)}>
          <boxGeometry args={xyz(room.size)} />
          <meshLambertMaterial color={accents.violet} transparent opacity={TWIN.roomOpacity} emissive={accents.violet} emissiveIntensity={TWIN.softEmissiveShare} />
          <Edges color={withAlpha(accents.violet, TWIN.planeEdgeOpacity)} />
        </mesh>
      ))}
    </group>
  );
}

type Pointer = Pick<TwinSceneContentProps, 'facility' | 'selected' | 'hovered' | 'onHover' | 'onSelect'>;

function RackInstances({ facility, selected, hovered, onHover, onSelect }: Pointer): ReactNode {
  const racks = useMemo(() => facility.racks.slice(0, TWIN.maxRacks), [facility]);
  const boxes = useMemo<BoxInstance[]>(() => racks.map((rack) => ({ position: rack.center, size: rack.size, color: rack.color })), [racks]);
  const openRack = openRackId(facility, selected);
  const highlight = useMemo(() => {
    const lit = new Map<number, string>();
    racks.forEach((rack, i) => {
      if ((selected?.kind === 'rack' && selected.id === rack.id) || (hovered?.kind === 'rack' && hovered.id === rack.id)) lit.set(i, text.primary);
    });
    return lit;
  }, [racks, selected, hovered]);
  return (
    <InstancedBoxes
      boxes={boxes}
      highlight={highlight}
      material={<meshLambertMaterial transparent opacity={TWIN.rackOpacity} emissive={accents.cyan} emissiveIntensity={TWIN.emissiveShare} />}
      // An open rack lets pointer events through its glass to the devices inside it (REQ-UI-037).
      onHover={(i) => {
        const rack = racks[i];
        if (rack === undefined || rack.id === openRack) return false;
        onHover({ kind: 'rack', id: rack.id });
        return true;
      }}
      onLeave={() => {
        if (hovered?.kind === 'rack') onHover(null);
      }}
      onPick={(i) => {
        const rack = racks[i];
        if (rack === undefined || rack.id === openRack) return false;
        onSelect({ kind: 'rack', id: rack.id });
        return true;
      }}
    />
  );
}

/** Devices at their U positions; those of the open rack take clicks and light up when hovered or selected. */
function DeviceInstances({ facility, selected, hovered, onHover, onSelect }: Pointer): ReactNode {
  const devices = useMemo(() => facility.devices.slice(0, TWIN.maxDevices), [facility]);
  const boxes = useMemo<BoxInstance[]>(() => devices.map((device) => ({ position: device.position, size: device.size, color: device.color })), [devices]);
  const openRack = openRackId(facility, selected);
  const highlight = useMemo(() => {
    const lit = new Map<number, string>();
    devices.forEach((device, i) => {
      if ((selected?.kind === 'device' && selected.id === device.id) || (hovered?.kind === 'device' && hovered.id === device.id)) lit.set(i, accents.cyan);
    });
    return lit;
  }, [devices, selected, hovered]);
  return (
    <InstancedBoxes
      boxes={boxes}
      highlight={highlight}
      material={<meshLambertMaterial emissiveIntensity={TWIN.softEmissiveShare} />}
      onHover={(i) => {
        const device = devices[i];
        if (device === undefined || device.rackId !== openRack) return false;
        onHover({ kind: 'device', id: device.id });
        return true;
      }}
      onLeave={() => {
        if (hovered?.kind === 'device') onHover(null);
      }}
      onPick={(i) => {
        const device = devices[i];
        if (device === undefined || device.rackId !== openRack) return false;
        onSelect({ kind: 'device', id: device.id });
        return true;
      }}
    />
  );
}

/**
 * REQ-PERF-001: compiles the scene's shaders without blocking (three's compileAsync polls between frames where the
 * browser offers parallel shader compilation) and only then lets the root draw: the host starts it with frameloop
 * 'never' and switches it to 'demand' when told.
 */
function CompileFirst({ onCompiled }: { onCompiled: () => void }): ReactNode {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    let live = true;
    const done = (): void => {
      if (live) onCompiled();
    };
    gl.compileAsync(scene, camera).then(done, done);
    return () => {
      live = false;
    };
  }, [gl, scene, camera, onCompiled]);
  return null;
}

/** Moves the camera to the start position and the orbit target whenever the framed subject changes. */
function CameraRig({ start, target }: { start: Vec3; target: Vec3 }): ReactNode {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    camera.position.set(start[GEOMETRY.axisX], start[GEOMETRY.axisY], start[GEOMETRY.axisZ]);
    camera.lookAt(target[GEOMETRY.axisX], target[GEOMETRY.axisY], target[GEOMETRY.axisZ]);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, invalidate, start, target]);
  return null;
}

const VERTICES_PER_EDGE = GEOMETRY.halfDivisor;
const AXES = GEOMETRY.axisZ + 1;

/** Every edge in one geometry (two vertices each, vertex colours): one draw call however many edges there are. */
function EdgeBatch({ graph }: { graph: GraphModel }): ReactNode {
  const geometry = useMemo(() => {
    const positions = new Float32Array(graph.edges.length * VERTICES_PER_EDGE * AXES);
    const colors = new Float32Array(graph.edges.length * VERTICES_PER_EDGE * AXES);
    const color = new Color();
    graph.edges.forEach((edge, index) => {
      const base = index * VERTICES_PER_EDGE * AXES;
      positions.set(xyz(edge.from), base);
      positions.set(xyz(edge.to), base + AXES);
      color.set(edge.color);
      colors.set([color.r, color.g, color.b], base);
      colors.set([color.r, color.g, color.b], base + AXES);
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, AXES));
    g.setAttribute('color', new BufferAttribute(colors, AXES));
    return g;
  }, [graph]);
  useEffect(() => () => { geometry.dispose(); }, [geometry]);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial vertexColors transparent opacity={TWIN.edgeOpacity} />
    </lineSegments>
  );
}

function LayerPlanes({ graph }: { graph: GraphModel }): ReactNode {
  return (
    <group>
      {graph.planes.map((plane) => (
        <mesh key={plane.layer} position={[graph.center[GEOMETRY.axisX], plane.y, graph.center[GEOMETRY.axisZ]]} rotation={[TWIN.planeRotationRad, 0, 0]}>
          <planeGeometry args={[plane.sizeM, plane.sizeM]} />
          <meshBasicMaterial color={plane.color} transparent opacity={TWIN.planeOpacity} depthWrite={false} side={DoubleSide} />
          <Edges color={withAlpha(plane.color, TWIN.planeEdgeOpacity)} />
        </mesh>
      ))}
    </group>
  );
}

function GraphNodes({ graph, selected, hovered, onHover, onSelect }: { graph: GraphModel } & Omit<Pointer, 'facility'>): ReactNode {
  return (
    <>
      <Instances limit={graph.nodes.length} range={graph.nodes.length}>
        <sphereGeometry args={[1, TWIN.sphereSegments, TWIN.sphereSegments]} />
        <meshLambertMaterial emissive={accents.cyan} emissiveIntensity={TWIN.emissiveShare} />
        {graph.nodes.map((node) => {
          const lit = (selected?.kind === 'node' && selected.id === node.id) || (hovered?.kind === 'node' && hovered.id === node.id);
          return (
            <Instance
              key={node.id}
              position={xyz(node.position)}
              scale={[node.radius, node.radius, node.radius]}
              color={lit ? text.primary : node.color}
              onPointerOver={(event) => {
                event.stopPropagation();
                onHover({ kind: 'node', id: node.id });
              }}
              onPointerOut={() => {
                onHover(null);
              }}
              onClick={(event) => {
                event.stopPropagation();
                onSelect({ kind: 'node', id: node.id });
              }}
            />
          );
        })}
      </Instances>
      <EdgeBatch graph={graph} />
      {graph.edges.filter((edge) => edge.onServicePath).slice(0, TWIN.maxPathLines).map((edge) => (
        <Line key={edge.id} points={[xyz(edge.from), xyz(edge.to)]} color={edge.color} lineWidth={TWIN.pathEdgeWidthPx} transparent opacity={TWIN.edgeOpacity} />
      ))}
    </>
  );
}

/** Projects the shown labels to the canvas after each drawn frame and reports them when they moved. */
function LabelProjector({ facility, graph, selected, hovered, onLabels }: Pick<TwinSceneContentProps, 'facility' | 'graph' | 'selected' | 'hovered' | 'onLabels'>): ReactNode {
  const anchors = useMemo(() => labelAnchors(facility, graph, selected, hovered), [facility, graph, selected, hovered]);
  const point = useMemo(() => new Vector3(), []);
  const last = useRef('');
  useFrame(({ camera, size }) => {
    const projected: ProjectedLabel[] = [];
    for (const anchor of anchors) {
      point.set(anchor.position[GEOMETRY.axisX], anchor.position[GEOMETRY.axisY], anchor.position[GEOMETRY.axisZ]).project(camera);
      // Behind the camera or outside the frame: not shown.
      if (point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) continue;
      projected.push({ key: anchor.key, kind: anchor.kind, x: Math.round(((point.x + 1) / GEOMETRY.halfDivisor) * size.width), y: Math.round(((1 - point.y) / GEOMETRY.halfDivisor) * size.height) });
    }
    const signature = JSON.stringify(projected);
    if (signature === last.current) return;
    last.current = signature;
    onLabels(projected);
  });
  return null;
}

export function TwinSceneContent({ facility, graph, selected, hovered, onHover, onSelect, onLabels, onCompiled }: TwinSceneContentProps): ReactNode {
  // REQ-UI-037: an open rack (selected, or holding the selected device) draws the camera to it; keyed by the rack, so
  // drilling within it keeps the operator's orbit.
  const openId = openRackId(facility, selected);
  const openRack = useMemo(() => (openId === null ? undefined : facility.racks.find((r) => r.id === openId)), [facility, openId]);
  const radius = useMemo(() => (openRack === undefined ? sceneRadius(facility, graph) : TWIN.rackFocusRadiusM), [facility, graph, openRack]);
  const target = useMemo<Vec3>(() => openRack?.center ?? (graph === null ? facility.center : graph.center), [facility, graph, openRack]);
  const start = useMemo(() => cameraStart(target, radius), [target, radius]);
  return (
    <>
      <color attach="background" args={[ground]} />
      <CompileFirst onCompiled={onCompiled} />
      <CameraRig start={start} target={target} />
      <ambientLight intensity={TWIN.ambientIntensity} />
      <directionalLight position={xyz(TWIN.keyLightPosition)} intensity={TWIN.keyLightIntensity} />
      <directionalLight position={xyz(TWIN.rimLightPosition)} intensity={TWIN.rimLightIntensity} color={accents.violet} />
      <Grid position={[facility.center[GEOMETRY.axisX], 0, facility.center[GEOMETRY.axisZ]]} args={[TWIN.gridFadeDistanceM, TWIN.gridFadeDistanceM]} cellSize={TWIN.gridCellM} sectionSize={TWIN.gridSectionM} cellColor={withAlpha(accents.cyan, TWIN.planeOpacity)} sectionColor={withAlpha(accents.cyan, TWIN.planeEdgeOpacity)} fadeDistance={TWIN.gridFadeDistanceM} infiniteGrid />
      <RoomSlabs facility={facility} />
      <RackInstances facility={facility} selected={selected} hovered={hovered} onHover={onHover} onSelect={onSelect} />
      <DeviceInstances facility={facility} selected={selected} hovered={hovered} onHover={onHover} onSelect={onSelect} />
      {graph === null ? null : (
        <>
          <LayerPlanes graph={graph} />
          <GraphNodes graph={graph} selected={selected} hovered={hovered} onHover={onHover} onSelect={onSelect} />
        </>
      )}
      <LabelProjector facility={facility} graph={graph} selected={selected} hovered={hovered} onLabels={onLabels} />
      <OrbitControls makeDefault enableDamping dampingFactor={TWIN.dampingFactor} minDistance={TWIN.cameraMinDistanceM} maxDistance={TWIN.cameraMaxDistanceM} target={xyz(target)} />
    </>
  );
}
