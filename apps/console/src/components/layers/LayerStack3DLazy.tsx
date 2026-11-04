'use client';
// REQ-UI-033 — the 3D stack is browser-only (WebGL); it loads on the client after the page paints.
import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import type { LayerStack3DProps } from './LayerStack3D';

export const LayerStack3DLazy = dynamic<LayerStack3DProps>(() => import('./LayerStack3D').then((m) => ({ default: m.LayerStack3D })), {
  ssr: false,
  loading: (): ReactNode => <QueryState status="pending" className="m-om-12" />,
});
