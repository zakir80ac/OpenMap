'use client';
// REQ-UI-033 — the Layers stack (ADR-021): twelve slate planes in contract order under a three-quarter orthographic
// camera as the overview, labels as HTML beside them; click a plane (or its row) to ease the camera onto it, recede
// the others and stand the layer's equipment on it, built from primitives at plausible proportions (cabinets,
// switches and firewalls, servers, disk shelves, hypervisor hosts with VM cards, cloud regions, operating-system
// consoles, container hosts, database drums, application tiers, SaaS cards). Vendor marks are SVG in the list and
// the focus panel, never inside the canvas. Every number comes from LAYER_STACK; the model decides what goes where.
import { Edges, OrbitControls, OrthographicCamera } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { GEOMETRY, LAYER_STACK } from '@openmap/constants';
import type { CiLayer } from '@openmap/contracts';
import { accents, cx, layerColors, surfaces, text as textColors } from '@openmap/ui';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Color, DoubleSide, MeshStandardMaterial, Vector3 } from 'three';
import { focusPose, type CameraPose, type EquipmentKind, type LayerPlane, type StackModel } from '@/lib/layer-stack-model';

export interface LayerStack3DProps {
  model: StackModel;
  /** Translated layer names for the labels beside the planes. */
  labels: Readonly<Record<CiLayer, string>>;
  formatInteger: (n: number) => string;
  /** Layer highlighted from the list; the scene lights its plane. */
  hovered: CiLayer | null;
  /** Layer the camera is focused on, or null for the overview. */
  focused: CiLayer | null;
  onHover: (layer: CiLayer | null) => void;
  onFocus: (layer: CiLayer) => void;
}

const X = GEOMETRY.axisX;
const Y = GEOMETRY.axisY;
const Z = GEOMETRY.axisZ;
const HALF = LAYER_STACK.halfDivisor;

const CHASSIS = surfaces.surface3;
const BEZEL = surfaces.surface1;
const PLATFORM = surfaces.surface3;
const LED_OK = accents.emerald;
const LED_WARN = accents.amber;

interface Treatment {
  opacity: number;
  emissive: number;
  color: string;
  /** Shared materials for the tier, created once the treatment is known. */
  materials: Materials | null;
}

/** The materials one tier's equipment shares: chassis, bezel, LEDs. Built once per treatment, not per mesh. */
interface Materials {
  chassis: MeshStandardMaterial;
  bezel: MeshStandardMaterial;
  ledOk: MeshStandardMaterial;
  ledWarn: MeshStandardMaterial;
}

function makeMaterials(t: Treatment): Materials {
  const transparent = t.opacity < 1;
  const led = (color: string): MeshStandardMaterial => new MeshStandardMaterial({ color, emissive: new Color(color), emissiveIntensity: LAYER_STACK.ledEmissive, transparent, opacity: t.opacity });
  return {
    chassis: new MeshStandardMaterial({ color: CHASSIS, metalness: LAYER_STACK.chassisMetalness, roughness: LAYER_STACK.chassisRoughness, emissive: new Color(t.color), emissiveIntensity: t.emissive, transparent, opacity: t.opacity }),
    bezel: new MeshStandardMaterial({ color: BEZEL, metalness: 0, roughness: LAYER_STACK.bezelRoughness, emissive: new Color(t.color), emissiveIntensity: t.emissive, transparent, opacity: t.opacity }),
    ledOk: led(LED_OK),
    ledWarn: led(LED_WARN),
  };
}

function treatment(plane: LayerPlane, hovered: boolean): Treatment {
  return { opacity: plane.visible ? 1 : LAYER_STACK.hiddenOpacity, emissive: hovered ? LAYER_STACK.hoverEmissive : LAYER_STACK.restEmissive, color: layerColors[plane.layer], materials: null };
}

function Chassis({ size, position, t, bezel = false }: { size: readonly [number, number, number]; position: readonly [number, number, number]; t: Treatment; bezel?: boolean }): ReactNode {
  const material = t.materials === null ? undefined : bezel ? t.materials.bezel : t.materials.chassis;
  return (
    <mesh position={[...position]} castShadow receiveShadow {...(material === undefined ? {} : { material })}>
      <boxGeometry args={[...size]} />
    </mesh>
  );
}

function Led({ position, color, t }: { position: readonly [number, number, number]; color: string; t: Treatment }): ReactNode {
  const material = t.materials === null ? undefined : color === LED_WARN ? t.materials.ledWarn : t.materials.ledOk;
  return (
    <mesh position={[...position]} {...(material === undefined ? {} : { material })}>
      <sphereGeometry args={[LAYER_STACK.ledRadiusM, LAYER_STACK.curveSegments / HALF, LAYER_STACK.curveSegments / HALF]} />
    </mesh>
  );
}

/** A cabinet seen from the front with the door off: side panels, top and base, a back panel, and servers racked inside. */
function Cabinet({ at, t }: { at: readonly [number, number, number]; t: Treatment }): ReactNode {
  const c = LAYER_STACK.cabinet;
  const s = LAYER_STACK.server;
  const inner = c.widthM - c.panelM * HALF;
  const scale = inner / s.widthM;
  const pitch = (c.heightM - c.panelM * HALF) / (c.servers + 1);
  return (
    <group position={[...at]}>
      <Chassis size={[c.panelM, c.heightM, c.depthM]} position={[-c.widthM / HALF + c.panelM / HALF, c.heightM / HALF, 0]} t={t} />
      <Chassis size={[c.panelM, c.heightM, c.depthM]} position={[c.widthM / HALF - c.panelM / HALF, c.heightM / HALF, 0]} t={t} />
      <Chassis size={[c.widthM, c.panelM, c.depthM]} position={[0, c.heightM - c.panelM / HALF, 0]} t={t} />
      <Chassis size={[c.widthM, c.panelM, c.depthM]} position={[0, c.panelM / HALF, 0]} t={t} />
      <Chassis size={[inner, c.heightM - c.panelM * HALF, c.panelM]} position={[0, c.heightM / HALF, -c.depthM / HALF + c.panelM / HALF]} t={t} bezel />
      {Array.from({ length: c.servers }, (_, i) => (
        <group key={i} position={[0, c.panelM + pitch * (i + 1) - (s.heightM * scale) / HALF, c.depthM / HALF - (s.depthM * scale) / HALF - c.railInsetM]} scale={scale}>
          <Server at={[0, 0, 0]} t={t} warn={i === c.servers - 1} />
        </group>
      ))}
    </group>
  );
}

/** A 2U server: chassis, bezel with drive bays, power and activity LEDs. */
function Server({ at, t, warn = false }: { at: readonly [number, number, number]; t: Treatment; warn?: boolean }): ReactNode {
  const s = LAYER_STACK.server;
  const bayWidth = (s.widthM - s.gapM * HALF) / s.bays;
  return (
    <group position={[...at]}>
      <Chassis size={[s.widthM, s.heightM, s.depthM]} position={[0, s.heightM / HALF, 0]} t={t} />
      {Array.from({ length: s.bays }, (_, i) => (
        <Chassis key={i} size={[bayWidth - s.bayInsetM, s.heightM - s.bayInsetM * HALF * HALF, s.bayInsetM]} position={[-s.widthM / HALF + s.gapM + bayWidth * (i + 1 / HALF), s.heightM / HALF, s.depthM / HALF + s.bayInsetM / HALF]} t={t} bezel />
      ))}
      <Led position={[s.widthM / HALF - s.gapM / HALF, s.heightM - s.bayInsetM * HALF, s.depthM / HALF + s.bayInsetM]} color={warn ? LED_WARN : LED_OK} t={t} />
    </group>
  );
}

/** A switch: slim chassis with two rows of ports and link LEDs. */
function Switch({ at, t }: { at: readonly [number, number, number]; t: Treatment }): ReactNode {
  const w = LAYER_STACK.switch;
  const rowPitch = w.portSizeM + w.portGapM;
  const start = -((w.portsPerRow - 1) * rowPitch) / HALF;
  return (
    <group position={[...at]}>
      <Chassis size={[w.widthM, w.heightM, w.depthM]} position={[0, w.heightM / HALF, 0]} t={t} />
      {Array.from({ length: w.portRows }, (_, row) =>
        Array.from({ length: w.portsPerRow }, (_, i) => (
          <group key={String(row) + ':' + String(i)}>
            <Chassis size={[w.portSizeM, w.portSizeM, w.portGapM]} position={[start + i * rowPitch, w.heightM / HALF + (row === 0 ? w.portSizeM / HALF : -w.portSizeM / HALF), w.depthM / HALF + w.portGapM / HALF]} t={t} bezel />
            {i % HALF === 0 ? <Led position={[start + i * rowPitch, w.heightM - w.portGapM, w.depthM / HALF + w.portGapM]} color={LED_OK} t={t} /> : null}
          </group>
        )),
      )}
    </group>
  );
}

/** A firewall appliance: a shorter chassis with the vendor's warning stripe along the bezel. */
function Firewall({ at, t }: { at: readonly [number, number, number]; t: Treatment }): ReactNode {
  const f = LAYER_STACK.firewall;
  return (
    <group position={[...at]}>
      <Chassis size={[f.widthM, f.heightM, f.depthM]} position={[0, f.heightM / HALF, 0]} t={t} />
      <mesh position={[0, f.heightM - f.stripeM, f.depthM / HALF + f.stripeM / HALF]}>
        <boxGeometry args={[f.widthM - f.stripeM * HALF, f.stripeM, f.stripeM]} />
        <meshStandardMaterial color={accents.rose} emissive={new Color(accents.rose)} emissiveIntensity={LAYER_STACK.hoverEmissive} transparent={t.opacity < 1} opacity={t.opacity} />
      </mesh>
      <Led position={[f.widthM / HALF - f.stripeM * HALF, f.stripeM * HALF, f.depthM / HALF + f.stripeM]} color={LED_OK} t={t} />
    </group>
  );
}

/** A disk shelf: vertical drive slots across the bezel. */
function Shelf({ at, t }: { at: readonly [number, number, number]; t: Treatment }): ReactNode {
  const s = LAYER_STACK.shelf;
  const slotWidth = s.widthM / s.slots;
  return (
    <group position={[...at]}>
      <Chassis size={[s.widthM, s.heightM, s.depthM]} position={[0, s.heightM / HALF, 0]} t={t} />
      {Array.from({ length: s.slots }, (_, i) => (
        <Chassis key={i} size={[slotWidth - s.slotInsetM, s.heightM - s.slotInsetM * HALF, s.slotInsetM]} position={[-s.widthM / HALF + slotWidth * (i + 1 / HALF), s.heightM / HALF, s.depthM / HALF + s.slotInsetM / HALF]} t={t} bezel />
      ))}
      <Led position={[s.widthM / HALF - s.slotInsetM * HALF, s.heightM - s.slotInsetM, s.depthM / HALF + s.slotInsetM]} color={LED_OK} t={t} />
    </group>
  );
}

function SanSwitch({ at, t }: { at: readonly [number, number, number]; t: Treatment }): ReactNode {
  const s = LAYER_STACK.sanSwitch;
  return (
    <group position={[...at]}>
      <Chassis size={[s.widthM, s.heightM, s.depthM]} position={[0, s.heightM / HALF, 0]} t={t} />
      <Led position={[s.widthM / HALF - s.heightM / HALF, s.heightM / HALF, s.depthM / HALF + s.heightM / HALF / HALF]} color={LED_OK} t={t} />
    </group>
  );
}

/** Database drums: the stacked-cylinder symbol every operator reads as a database, in the layer colour. */
function Drums({ at, t }: { at: readonly [number, number, number]; t: Treatment }): ReactNode {
  const d = LAYER_STACK.drum;
  return (
    <group position={[...at]}>
      {Array.from({ length: d.count }, (_, i) => (
        <mesh key={i} position={[0, d.heightM / HALF + i * (d.heightM + d.gapM), 0]} castShadow receiveShadow>
          <cylinderGeometry args={[d.radiusM, d.radiusM, d.heightM, LAYER_STACK.curveSegments]} />
          <meshStandardMaterial color={t.color} metalness={LAYER_STACK.chassisMetalness} roughness={LAYER_STACK.chassisRoughness} emissive={new Color(t.color)} emissiveIntensity={t.emissive} transparent={t.opacity < 1} opacity={t.opacity} />
        </mesh>
      ))}
    </group>
  );
}

/** A hypervisor host with translucent VM cards hovering above it. */
function Hypervisor({ at, t }: { at: readonly [number, number, number]; t: Treatment }): ReactNode {
  const v = LAYER_STACK.vmCard;
  const s = LAYER_STACK.server;
  const startX = -((v.columns - 1) * (v.widthM + v.gapM)) / HALF;
  const startZ = -((v.rows - 1) * (v.depthM + v.gapM)) / HALF;
  return (
    <group position={[...at]}>
      <Server at={[0, 0, 0]} t={t} />
      {Array.from({ length: v.rows }, (_, r) =>
        Array.from({ length: v.columns }, (_, c) => (
          <mesh key={String(r) + ':' + String(c)} position={[startX + c * (v.widthM + v.gapM), s.heightM + v.liftM + r * v.heightM * HALF, startZ + r * (v.depthM + v.gapM)]}>
            <boxGeometry args={[v.widthM, v.heightM, v.depthM]} />
            <meshStandardMaterial color={t.color} transparent opacity={t.opacity * LAYER_STACK.glassOpacity} emissive={new Color(t.color)} emissiveIntensity={t.emissive} />
            <Edges color={t.color} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** A container host: a server carrying rows of container blocks. */
function ContainerHost({ at, t }: { at: readonly [number, number, number]; t: Treatment }): ReactNode {
  const c = LAYER_STACK.container;
  const s = LAYER_STACK.server;
  const startX = -((c.columns - 1) * (c.widthM + c.gapM)) / HALF;
  return (
    <group position={[...at]}>
      <Server at={[0, 0, 0]} t={t} />
      {Array.from({ length: c.rows }, (_, r) =>
        Array.from({ length: c.columns }, (_, i) => (
          <mesh key={String(r) + ':' + String(i)} position={[startX + i * (c.widthM + c.gapM), s.heightM + c.heightM / HALF + r * c.heightM, 0]} castShadow>
            <boxGeometry args={[c.widthM, c.heightM, c.depthM]} />
            <meshStandardMaterial color={t.color} metalness={LAYER_STACK.chassisMetalness} roughness={LAYER_STACK.chassisRoughness} emissive={new Color(t.color)} emissiveIntensity={t.emissive} transparent={t.opacity < 1} opacity={t.opacity} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** A cloud region: a slab per availability zone. */
function Region({ at, t }: { at: readonly [number, number, number]; t: Treatment }): ReactNode {
  const z = LAYER_STACK.zone;
  const startX = -((z.count - 1) * (z.widthM + z.gapM)) / HALF;
  return (
    <group position={[...at]}>
      {Array.from({ length: z.count }, (_, i) => (
        <mesh key={i} position={[startX + i * (z.widthM + z.gapM), z.heightM / HALF, 0]} castShadow receiveShadow>
          <boxGeometry args={[z.widthM, z.heightM, z.depthM]} />
          <meshStandardMaterial color={t.color} transparent opacity={t.opacity * LAYER_STACK.glassOpacity} emissive={new Color(t.color)} emissiveIntensity={t.emissive} />
          <Edges color={t.color} />
        </mesh>
      ))}
    </group>
  );
}

/** An operating-system console: a server with a screen in the layer colour. */
function Console({ at, t }: { at: readonly [number, number, number]; t: Treatment }): ReactNode {
  const s = LAYER_STACK.screen;
  const srv = LAYER_STACK.server;
  return (
    <group position={[...at]}>
      <Server at={[0, 0, 0]} t={t} />
      <Chassis size={[s.depthM * HALF, s.standM, s.depthM * HALF]} position={[0, srv.heightM + s.standM / HALF, -srv.depthM / HALF / HALF]} t={t} />
      <mesh position={[0, srv.heightM + s.standM + s.heightM / HALF, -srv.depthM / HALF / HALF]} castShadow>
        <boxGeometry args={[s.widthM, s.heightM, s.depthM]} />
        <meshStandardMaterial color={BEZEL} roughness={LAYER_STACK.bezelRoughness} transparent={t.opacity < 1} opacity={t.opacity} />
      </mesh>
      <mesh position={[0, srv.heightM + s.standM + s.heightM / HALF, -srv.depthM / HALF / HALF + s.depthM / HALF + s.depthM / HALF / HALF]}>
        <planeGeometry args={[s.widthM - s.depthM, s.heightM - s.depthM]} />
        <meshStandardMaterial color={t.color} emissive={new Color(t.color)} emissiveIntensity={LAYER_STACK.hoverEmissive} transparent opacity={t.opacity} side={DoubleSide} />
      </mesh>
    </group>
  );
}

/** An application tier: three servers side by side (web, application, API) behind one bezel line. */
function ApplicationTier({ at, t }: { at: readonly [number, number, number]; t: Treatment }): ReactNode {
  const s = LAYER_STACK.server;
  return (
    <group position={[...at]}>
      <Server at={[0, 0, 0]} t={t} />
      <Server at={[0, s.heightM + s.gapM, 0]} t={t} />
      <Server at={[0, (s.heightM + s.gapM) * HALF, 0]} t={t} warn />
    </group>
  );
}

/** An unknown-layer crate: a translucent box with no face. */
function Crate({ at, t }: { at: readonly [number, number, number]; t: Treatment }): ReactNode {
  const c = LAYER_STACK.crate;
  return (
    <mesh position={[at[X], at[Y] + c.sizeM / HALF, at[Z]]}>
      <boxGeometry args={[c.sizeM, c.sizeM, c.sizeM]} />
      <meshStandardMaterial color={textColors.muted} transparent opacity={t.opacity * LAYER_STACK.hiddenOpacity} emissive={new Color(textColors.muted)} emissiveIntensity={t.emissive} />
      <Edges color={textColors.muted} />
    </mesh>
  );
}

function Equipment({ kind, at, t }: { kind: EquipmentKind; at: readonly [number, number, number]; t: Treatment }): ReactNode {
  switch (kind) {
    case 'cabinets':
      return <Cabinet at={at} t={t} />;
    case 'network':
      return (
        <group>
          <Switch at={[at[X] - LAYER_STACK.firewall.widthM / HALF, at[Y], at[Z]]} t={t} />
          <Firewall at={[at[X] + LAYER_STACK.switch.widthM / HALF + LAYER_STACK.unitGapM / HALF, at[Y], at[Z]]} t={t} />
        </group>
      );
    case 'servers':
      return <Server at={at} t={t} />;
    case 'storage':
      return (
        <group>
          <Shelf at={at} t={t} />
          <SanSwitch at={[at[X], at[Y] + LAYER_STACK.shelf.heightM + LAYER_STACK.server.gapM, at[Z]]} t={t} />
        </group>
      );
    case 'hypervisor':
      return <Hypervisor at={at} t={t} />;
    case 'cloud':
      return <Region at={at} t={t} />;
    case 'os':
      return <Console at={at} t={t} />;
    case 'containers':
      return <ContainerHost at={at} t={t} />;
    case 'database':
      return <Drums at={at} t={t} />;
    case 'applications':
      return <ApplicationTier at={at} t={t} />;
    case 'saas':
      return <Region at={at} t={t} />;
    case 'unknown':
      return <Crate at={at} t={t} />;
  }
}

/** Width one unit of the family takes, for spacing repeats on a tier. */
function unitWidth(kind: EquipmentKind): number {
  switch (kind) {
    case 'cabinets':
      return LAYER_STACK.cabinet.widthM;
    case 'network':
      return LAYER_STACK.switch.widthM + LAYER_STACK.firewall.widthM + LAYER_STACK.unitGapM;
    case 'storage':
      return LAYER_STACK.shelf.widthM;
    case 'cloud':
    case 'saas':
      return LAYER_STACK.zone.count * (LAYER_STACK.zone.widthM + LAYER_STACK.zone.gapM);
    case 'database':
      return LAYER_STACK.drum.radiusM * HALF;
    case 'unknown':
      return LAYER_STACK.crate.sizeM;
    default:
      return LAYER_STACK.server.widthM;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Planes, labels, camera and the scene
// ---------------------------------------------------------------------------------------------------------------

/** One plane of the stack: a slate slab with an accent strip, hover to light it, click to focus it. When focused, the
 * layer's equipment stands on it; when another plane is focused, it recedes. */
function Plane({ plane, hovered, focused, dimmed, above, onHover, onFocus }: { plane: LayerPlane; hovered: boolean; focused: boolean; dimmed: boolean; above: boolean; onHover: (layer: CiLayer | null) => void; onFocus: (layer: CiLayer) => void }): ReactNode {
  const base = treatment(plane, hovered);
  const materials = useMemo(() => makeMaterials(base), [base.color, base.emissive, base.opacity]);
  useEffect(
    () => () => {
      for (const m of [materials.chassis, materials.bezel, materials.ledOk, materials.ledWarn]) m.dispose();
    },
    [materials],
  );
  const t: Treatment = { ...base, materials };
  const [w, th, d] = plane.size;
  const opacity = dimmed ? LAYER_STACK.recededOpacity : plane.visible ? 1 : LAYER_STACK.hiddenOpacity;
  const unitW = unitWidth(plane.equipment) * LAYER_STACK.equipmentScale;
  const span = plane.units * unitW + (plane.units - 1) * LAYER_STACK.unitGapM;
  const startX = -span / HALF + unitW / HALF;
  return (
    <group position={[plane.position[X], plane.position[Y], plane.position[Z]]} visible={!above}>
      <mesh
        position={[0, th / HALF, 0]}
        receiveShadow
        onPointerOver={(e) => {
          e.stopPropagation();
          onHover(plane.layer);
        }}
        onPointerOut={() => {
          onHover(null);
        }}
        onClick={(e) => {
          e.stopPropagation();
          onFocus(plane.layer);
        }}
      >
        <boxGeometry args={[w, th, d]} />
        <meshStandardMaterial color={PLATFORM} roughness={LAYER_STACK.platformRoughness} metalness={LAYER_STACK.platformMetalness} emissive={new Color(t.color)} emissiveIntensity={hovered || focused ? LAYER_STACK.hoverEmissive / HALF : 0} transparent={opacity < 1} opacity={opacity} />
        <Edges color={t.color} transparent opacity={opacity * (hovered || focused ? 1 : LAYER_STACK.edgeOpacity)} />
      </mesh>
      <mesh position={[0, th / HALF, d / HALF - LAYER_STACK.edgeStripM / HALF]}>
        <boxGeometry args={[w, th, LAYER_STACK.edgeStripM]} />
        <meshStandardMaterial color={t.color} emissive={new Color(t.color)} emissiveIntensity={hovered || focused ? LAYER_STACK.hoverEmissive * HALF : LAYER_STACK.hoverEmissive} transparent={opacity < 1} opacity={opacity} />
      </mesh>
      {focused
        ? Array.from({ length: plane.units }, (_, i) => (
            <group key={i} position={[startX + i * (unitW + LAYER_STACK.unitGapM), th, 0]} scale={LAYER_STACK.equipmentScale}>
              <Equipment kind={plane.equipment} at={[0, 0, 0]} t={t} />
            </group>
          ))
        : null}
    </group>
  );
}

type LabelTargets = Map<CiLayer, HTMLDivElement | null>;

/** Positions the overlay labels on their DOM nodes by projecting each plane's anchor through the camera, each frame the loop runs. */
function LabelProjector({ planes, targets }: { planes: readonly LayerPlane[]; targets: { current: LabelTargets } }): ReactNode {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const v = useMemo(() => new Vector3(), []);
  useFrame(() => {
    for (const plane of planes) {
      const el = targets.current.get(plane.layer);
      if (!el) continue;
      v.set(plane.labelAnchor[X], plane.labelAnchor[Y], plane.labelAnchor[Z]).project(camera);
      const x = ((v.x + 1) / HALF) * size.width;
      const y = ((1 - v.y) / HALF) * size.height;
      el.style.transform = 'translate(' + String(Math.round(x)) + 'px, ' + String(Math.round(y)) + 'px) translate(-100%, -50%)';
    }
  });
  return null;
}

/** Eases the camera between the overview and a plane's focus pose, rendering frames only while it moves. */
function CameraRig({ pose }: { pose: CameraPose }): ReactNode {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: Vector3; update: () => void } | null;
  const invalidate = useThree((s) => s.invalidate);
  const from = useRef<{ position: Vector3; target: Vector3; zoom: number } | null>(null);
  const startedAt = useRef(0);
  const target = useRef(new Vector3());
  useEffect(() => {
    from.current = { position: camera.position.clone(), target: (controls?.target ?? target.current).clone(), zoom: (camera as { zoom: number }).zoom };
    startedAt.current = performance.now();
    invalidate();
  }, [camera, controls, invalidate, pose]);
  useFrame(() => {
    const start = from.current;
    if (start === null) return;
    const elapsed = performance.now() - startedAt.current;
    const k = Math.min(1, elapsed / LAYER_STACK.focusMs);
    const eased = 1 - (1 - k) * (1 - k);
    camera.position.lerpVectors(start.position, new Vector3(...pose.position), eased);
    target.current.lerpVectors(start.target, new Vector3(...pose.target), eased);
    (camera as { zoom: number }).zoom = start.zoom + (pose.zoom - start.zoom) * eased;
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(target.current);
      controls.update();
    } else {
      camera.lookAt(target.current);
    }
    if (k < 1) invalidate();
    else from.current = null;
  });
  return null;
}

export function LayerStack3D({ model, labels, formatInteger, hovered, focused, onHover, onFocus }: LayerStack3DProps): ReactNode {
  const targets = useRef<LabelTargets>(new Map());
  const focusedPlane = focused === null ? undefined : model.planes.find((p) => p.layer === focused);
  const pose = focusedPlane === undefined ? model.overview : focusPose(focusedPlane);
  return (
    <div data-testid="layer-stack-canvas" data-focused={focused ?? ''} className="relative h-full min-h-[34rem] w-full">
      {/* Labels are HTML beside the planes, projected onto the canvas; they step aside while a plane is focused. */}
      <div className={cx('pointer-events-none absolute inset-0 z-10 overflow-hidden transition-opacity duration-om-base', focused === null ? 'opacity-100' : 'opacity-0')}>
        {model.planes.map((plane) => (
          <div
            key={plane.layer}
            ref={(el) => {
              targets.current.set(plane.layer, el);
            }}
            data-layer={plane.layer}
            data-visible={plane.visible ? 'true' : 'false'}
            className="absolute start-0 top-0 flex items-baseline gap-om-6 whitespace-nowrap pe-om-10 text-end"
          >
            <span className="font-om-body text-om-xs font-medium" style={{ color: plane.visible ? layerColors[plane.layer] : 'var(--om-text-muted)' }}>
              {labels[plane.layer]}
            </span>
            <span className="font-om-mono text-om-2xs tabular-nums text-om-secondary">{formatInteger(plane.count)}</span>
          </div>
        ))}
      </div>
      {/* Nothing moves on its own: frames are rendered on demand (hover, focus, orbit), so the page's main thread stays free. */}
      <Canvas shadows dpr={[1, LAYER_STACK.dprMax]} frameloop="demand" gl={{ antialias: true, alpha: true }}>
        <OrthographicCamera makeDefault zoom={model.overview.zoom} near={LAYER_STACK.cameraNearM} far={LAYER_STACK.cameraFarM} position={[...model.overview.position]} />
        <hemisphereLight intensity={LAYER_STACK.hemisphereIntensity} color={textColors.primary} groundColor={surfaces.surface1} />
        <directionalLight position={[...LAYER_STACK.keyLightPosition]} intensity={LAYER_STACK.keyLightIntensity} castShadow shadow-mapSize-width={LAYER_STACK.shadowMapSize} shadow-mapSize-height={LAYER_STACK.shadowMapSize} />
        <directionalLight position={[...LAYER_STACK.fillLightPosition]} intensity={LAYER_STACK.fillLightIntensity} />
        {model.planes.map((plane) => (
          <Plane key={plane.layer} plane={plane} hovered={hovered === plane.layer} focused={focused === plane.layer} dimmed={focused !== null && focused !== plane.layer} above={focusedPlane !== undefined && plane.index > focusedPlane.index} onHover={onHover} onFocus={onFocus} />
        ))}
        <LabelProjector planes={model.planes} targets={targets} />
        <CameraRig pose={pose} />
        <OrbitControls
          makeDefault
          enablePan={false}
          enableDamping={false}
          enableZoom={false}
          target={[model.overview.target[X], model.overview.target[Y], model.overview.target[Z]]}
          minPolarAngle={LAYER_STACK.orbitPolarMinRad}
          maxPolarAngle={LAYER_STACK.orbitPolarMaxRad}
          minAzimuthAngle={Math.PI / (HALF * HALF) - LAYER_STACK.orbitAzimuthRad}
          maxAzimuthAngle={Math.PI / (HALF * HALF) + LAYER_STACK.orbitAzimuthRad}
        />
      </Canvas>
    </div>
  );
}
