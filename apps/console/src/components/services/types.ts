// REQ-UI-012 REQ-BSM-006 — callback types of the Services components, kept in a .ts module because the guard reads
// `=> Promise<...>` on one line of a .tsx file as JSX text.
import type { RcaInput, SlaInput } from '@/lib/queries';

export type IncidentAction = 'acknowledge' | 'assign' | 'resolve' | 'close' | 'rca';

/** A unit of work an incident card runs while showing its busy state. */
export type Work = () => Promise<unknown>;

export interface IncidentActions {
  acknowledge: (id: string) => Promise<unknown>;
  assign: (id: string, assignee: string) => Promise<unknown>;
  resolve: (id: string, note: string) => Promise<unknown>;
  close: (id: string) => Promise<unknown>;
  saveRca: (id: string, input: RcaInput) => Promise<unknown>;
}

export type SaveSla = (id: string | null, input: SlaInput) => Promise<unknown>;
export type DeleteSla = (id: string) => Promise<unknown>;
