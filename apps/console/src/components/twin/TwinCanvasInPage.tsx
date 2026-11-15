'use client';
// REQ-UI-029 REQ-PERF-007 (ADR-077) — the twin's scene on a canvas in the page, for a browser that cannot transfer a
// canvas to a worker (or whose worker failed to start). Same scene, same labels; only the thread differs.
import { Canvas } from '@react-three/fiber';
import { TWIN } from '@openmap/constants';
import { useCallback, useState, type ReactNode } from 'react';
import { TwinSceneContent, type TwinSceneContentProps } from './TwinSceneContent';

export type TwinCanvasInPageProps = Omit<TwinSceneContentProps, 'onCompiled'> & { label: string };

export function TwinCanvasInPage({ label, ...content }: TwinCanvasInPageProps): ReactNode {
  // Nothing is drawn until the shaders are compiled; after that the canvas draws on demand.
  const [compiled, setCompiled] = useState(false);
  const onCompiled = useCallback(() => {
    setCompiled(true);
  }, []);
  return (
    <Canvas
      aria-label={label}
      role="img"
      dpr={[1, TWIN.dprMax]}
      frameloop={compiled ? 'demand' : 'never'}
      camera={{ fov: TWIN.cameraFov, near: TWIN.cameraNearM, far: TWIN.cameraFarM }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onPointerMissed={() => {
        content.onSelect(null);
      }}
    >
      <TwinSceneContent {...content} onCompiled={onCompiled} />
    </Canvas>
  );
}
