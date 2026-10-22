// REQ-INT-005 — view types for the Integration GraphQL type.
export type IntegrationHealth = 'healthy' | 'warning' | 'failing' | 'disabled';

export interface IntegrationView {
  id: string;
  category: string;
  vendor: string;
  name: string;
  enabled: boolean;
  direction: string;
  health: IntegrationHealth;
  lastSuccessAt: string | null;
  lastError: string | null;
  deliveredLastHour: number;
  failedLastHour: number;
}

/** REQ-UI-014 — full configuration of one integration (ADR-012). */
export interface IntegrationDetailView extends IntegrationView {
  endpoint: string;
  credentialRef: string;
  settings: Record<string, unknown>;
  fieldMappings: unknown[];
  classMappings: unknown[];
  subscribedEvents: string[];
  createdAt: string;
  updatedAt: string;
}

/** REQ-UI-014 — one delivery attempt (outbound message or inbound event) recorded for an integration. */
export interface IntegrationDeliveryView {
  id: string;
  direction: string;
  eventId: string | null;
  remoteId: string | null;
  state: string;
  attempts: number;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}
