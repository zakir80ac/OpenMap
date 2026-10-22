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
