'use client';
// REQ-UI-029 — the WebGL scene of the digital twin (ADR-018): rooms as glass slabs, racks and device plates as
// instanced boxes at true proportions, the layer planes stacked above with the focus CI's dependency graph as
// spheres and lines. Orbit to look around, hover for a label, click a rack or a node to select it. Rendering is on
// demand: the frame is redrawn only when the camera or the selection changes, so an idle twin costs nothing.
import { Edges, Grid, Html, Instance, Instances, Line, OrbitControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { GEOMETRY, TWIN } from '@openmap/constants';
import { accents, ground, text, withAlpha } from '@openmap/ui';
import { useEffect, useMemo, type ReactNode } from 'react';
import { BufferAttribute, BufferGeometry, Color, DoubleSide } from 'three';
import { cameraStart, sceneLabel, sceneRadius, xyz, type FacilityModel, type GraphModel, type RackBox, type Vec3 } from '@/lib/twin-model';
import { InstancedBoxes, type BoxInstance } from './InstancedBoxes';

export interface TwinSelection {
  /** REQ-UI-037: a device inside an open rack is selected on its own, to drill down from it. */
  kind: 'rack' | 'device' | 'node';
  id: string;
}

/** The rack whose devices take clicks: the selected rack, or the rack of the selected device. */
export function openRackId(facility: FacilityModel, selected: TwinSelection | null): string | null {
  if (selected?.kind === 'rack') return selected.id;
  if (selected?.kind === 'device') return facility.devices.find((d) => d.id === selected.id)?.rackId ?? null;
  return null;
}

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

const LABEL_CLASS = 'pointer-events-none whitespace-nowrap rounded-om-control border border-om-border-strong bg-om-surface1/90 px-om-8 py-om-4 font-om-mono text-om-2xs text-om-primary shadow-om-card';

function RoomSlabs({ facility }: { facility: FacilityModel }): ReactNode {
  return (
    <group>
      {facility.rooms.map((room) => (
        <mesh key={room.id} position={xyz(room.center)}>
          <boxGeometry args={xyz(room.size)} />
          <meshStandardMaterial color={accents.violet} transparent opacity={TWIN.roomOpacity} emissive={accents.violet} emissiveIntensity={TWIN.softEmissiveShare} />
          <Edges color={withAlpha(accents.violet, TWIN.planeEdgeOpacity)} />
        </mesh>
      ))}
    </group>
  );
}

function RackInstances({ facility, selected, hovered, onHover, onSelect }: Pick<TwinSceneProps, 'facility' | 'selected' | 'hovered' | 'onHover' | 'onSelect'>): ReactNode {
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
      material={<meshStandardMaterial transparent opacity={TWIN.rackOpacity} emissive={accents.cyan} emissiveIntensity={TWIN.emissiveShare} />}
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
function DeviceInstances({ facility, selected, hovered, onHover, onSelect }: Pick<TwinSceneProps, 'facility' | 'selected' | 'hovered' | 'onHover' | 'onSelect'>): ReactNode {
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
      material={<meshStandardMaterial emissiveIntensity={TWIN.softEmissiveShare} />}
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

const VERTICES_PER_EDGE = GEOMETRY.halfDivisor;
const AXES = GEOMETRY.axisZ + 1;

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

function GraphNodes({ graph, selected, hovered, onHover, onSelect }: { graph: GraphModel } & Pick<TwinSceneProps, 'selected' | 'hovered' | 'onHover' | 'onSelect'>): ReactNode {
  return (
    <>
      <Instances limit={graph.nodes.length} range={graph.nodes.length}>
        <sphereGeometry args={[1, TWIN.sphereSegments, TWIN.sphereSegments]} />
        <meshStandardMaterial emissive={accents.cyan} emissiveIntensity={TWIN.emissiveShare} />
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

function Labels({ facility, graph, selected, hovered, rackCaption }: Pick<TwinSceneProps, 'facility' | 'graph' | 'selected' | 'hovered' | 'rackCaption'>): ReactNode {
  const shown: Array<{ key: string; position: Vec3; caption: string }> = [];
  const push = (selection: TwinSelection | null): void => {
    if (selection === null) return;
    if (selection.kind === 'rack') {
      const rack = facility.racks.find((r) => r.id === selection.id);
      if (rack && !shown.some((s) => s.key === rack.id)) shown.push({ key: rack.id, position: rack.labelPosition, caption: rackCaption(rack) });
    } else {
      const node = graph?.nodes.find((n) => n.id === selection.id);
      if (node && !shown.some((s) => s.key === node.id)) shown.push({ key: node.id, position: node.labelPosition, caption: sceneLabel(node.label) });
    }
  };
  push(selected);
  push(hovered);
  const root = graph?.nodes.find((n) => n.isRoot);
  if (root && !shown.some((s) => s.key === root.id)) shown.push({ key: root.id, position: root.labelPosition, caption: sceneLabel(root.label) });
  return (
    <>
      {shown.map((item) => (
        <Html key={item.key} position={xyz(item.position)} center zIndexRange={[1, 0]}>
          <span className={LABEL_CLASS}>{item.caption}</span>
        </Html>
      ))}
    </>
  );
}

export function TwinScene({ facility, graph, selected, hovered, onHover, onSelect, label, rackCaption }: TwinSceneProps): ReactNode {
  // REQ-UI-037: an open rack (selected, or holding the selected device) draws the camera to it; keyed by the rack, so
  // drilling within it keeps the operator's orbit.
  const openId = openRackId(facility, selected);
  const openRack = useMemo(() => (openId === null ? undefined : facility.racks.find((r) => r.id === openId)), [facility, openId]);
  const radius = useMemo(() => (openRack === undefined ? sceneRadius(facility, graph) : TWIN.rackFocusRadiusM), [facility, graph, openRack]);
  const target = useMemo<Vec3>(() => openRack?.center ?? (graph === null ? facility.center : graph.center), [facility, graph, openRack]);
  const start = useMemo(() => cameraStart(target, radius), [target, radius]);
  return (
    <Canvas
      aria-label={label}
      role="img"
      dpr={[1, TWIN.dprMax]}
      frameloop="demand"
      camera={{ fov: TWIN.cameraFov, near: TWIN.cameraNearM, far: TWIN.cameraFarM, position: xyz(start) }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onPointerMissed={() => {
        onSelect(null);
      }}
    >
      <color attach="background" args={[ground]} />
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
      <Labels facility={facility} graph={graph} selected={selected} hovered={hovered} rackCaption={rackCaption} />
      <OrbitControls makeDefault enableDamping dampingFactor={TWIN.dampingFactor} minDistance={TWIN.cameraMinDistanceM} maxDistance={TWIN.cameraMaxDistanceM} target={xyz(target)} />
    </Canvas>
  );
}
