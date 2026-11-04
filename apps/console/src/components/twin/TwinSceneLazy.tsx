'use client';
// REQ-UI-029 — the scene is browser-only (WebGL) and heavy, so it is loaded on the client after the page paints.
import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import type { TwinSceneProps } from './TwinScene';

export const TwinSceneLazy = dynamic<TwinSceneProps>(() => import('./TwinScene').then((m) => ({ default: m.TwinScene })), {
  ssr: false,
  loading: (): ReactNode => <QueryState status="pending" className="m-om-12" />,
});
