'use client';
// REQ-UI-029 REQ-UI-037 REQ-PERF-001 — boxes drawn as one InstancedMesh whose matrices and colours are written
// imperatively. Racks and devices were one React component each (drei <Instance>), so the twin's first render built
// thousands of components before a frame (a long main-thread task on every open; at full scale, tens of thousands).
// Pointer events name the box by its instance index.
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { GEOMETRY } from '@openmap/constants';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Color, Object3D, type InstancedMesh } from 'three';
import type { Vec3 } from '@/lib/twin-model';

export interface BoxInstance {
  position: Vec3;
  size: Vec3;
  color: string;
}

export interface InstancedBoxesProps {
  boxes: readonly BoxInstance[];
  /** Colours that replace a box's own while it is hovered or selected, by index. */
  highlight: ReadonlyMap<number, string>;
  /** The material every box shares (a meshStandardMaterial element). */
  material: ReactNode;
  /** The box under the pointer changed; return true to keep the event from boxes behind it. */
  onHover?: (index: number) => boolean;
  onLeave?: () => void;
  /** A box was clicked; return true to keep the click from boxes behind it. */
  onPick?: (index: number) => boolean;
}

export function InstancedBoxes({ boxes, highlight, material, onHover, onLeave, onPick }: InstancedBoxesProps): ReactNode {
  const ref = useRef<InstancedMesh>(null);
  const hoveredIndex = useRef<number | null>(null);
  const keeps = useRef(false);
  const invalidate = useThree((state) => state.invalidate);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (mesh === null) return;
    const placer = new Object3D();
    boxes.forEach((box, i) => {
      placer.position.set(box.position[GEOMETRY.axisX], box.position[GEOMETRY.axisY], box.position[GEOMETRY.axisZ]);
      placer.scale.set(box.size[GEOMETRY.axisX], box.size[GEOMETRY.axisY], box.size[GEOMETRY.axisZ]);
      placer.updateMatrix();
      mesh.setMatrixAt(i, placer.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    // Raycasting tests the bounding sphere first: it must cover every instance, not the unit box.
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
    invalidate();
  }, [boxes, invalidate]);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (mesh === null) return;
    const color = new Color();
    boxes.forEach((box, i) => {
      mesh.setColorAt(i, color.set(highlight.get(i) ?? box.color));
    });
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    invalidate();
  }, [boxes, highlight, invalidate]);

  if (boxes.length === 0) return null;
  const indexOf = (event: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>): number | null => (event.instanceId === undefined ? null : event.instanceId);
  return (
    <instancedMesh
      // The instance count is fixed when the mesh is made: a different count makes a new mesh.
      key={boxes.length}
      ref={ref}
      args={[undefined, undefined, boxes.length]}
      onPointerMove={(event) => {
        const index = indexOf(event);
        if (index === null || onHover === undefined) return;
        // The owner hears about a change of box only, not every move; the event is held back from boxes behind
        // whenever the owner kept it for this box.
        if (index !== hoveredIndex.current) {
          hoveredIndex.current = index;
          keeps.current = onHover(index);
        }
        if (keeps.current) event.stopPropagation();
      }}
      onPointerOut={() => {
        hoveredIndex.current = null;
        keeps.current = false;
        onLeave?.();
      }}
      onClick={(event) => {
        const index = indexOf(event);
        if (index === null || onPick === undefined) return;
        if (onPick(index)) event.stopPropagation();
      }}
    >
      <boxGeometry args={[1, 1, 1]} />
      {material}
    </instancedMesh>
  );
}
