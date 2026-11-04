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

export interface TwinSelection {
  kind: 'rack' | 'node';
  id: string;
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
  return (
    <Instances limit={Math.min(facility.racks.length, TWIN.maxRacks)} range={Math.min(facility.racks.length, TWIN.maxRacks)}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial transparent opacity={TWIN.rackOpacity} emissive={accents.cyan} emissiveIntensity={TWIN.emissiveShare} />
      {facility.racks.map((rack) => {
        const lit = (selected?.kind === 'rack' && selected.id === rack.id) || (hovered?.kind === 'rack' && hovered.id === rack.id);
        return (
          <Instance
            key={rack.id}
            position={xyz(rack.center)}
            scale={xyz(rack.size)}
            color={lit ? text.primary : rack.color}
            onPointerOver={(event) => {
              event.stopPropagation();
              onHover({ kind: 'rack', id: rack.id });
            }}
            onPointerOut={() => {
              onHover(null);
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(selected?.kind === 'rack' && selected.id === rack.id ? null : { kind: 'rack', id: rack.id });
            }}
          />
        );
      })}
    </Instances>
  );
}

function DeviceInstances({ facility }: { facility: FacilityModel }): ReactNode {
  const devices = facility.devices.slice(0, TWIN.maxDevices);
  if (devices.length === 0) return null;
  return (
    <Instances limit={devices.length} range={devices.length}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial emissiveIntensity={TWIN.softEmissiveShare} />
      {devices.map((device) => (
        <Instance key={device.id} position={xyz(device.position)} scale={xyz(device.size)} color={device.color} />
      ))}
    </Instances>
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
  const radius = useMemo(() => sceneRadius(facility, graph), [facility, graph]);
  const target = useMemo<Vec3>(() => (graph === null ? facility.center : graph.center), [facility, graph]);
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
      <DeviceInstances facility={facility} />
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
