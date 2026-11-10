// REQ-BSM-002 REQ-BSM-003 REQ-BSM-006 REQ-BSM-008 REQ-INT-005 REQ-INT-007 REQ-INT-012 — bsm-engine package entry point: health
// propagation, SLA budgets and availability, impact simulation and the ITSM/SIEM payload builders and delivery engine.
// REQ-IPAM-007: the network circuit rules (shared risks, path diversity, lost redundancy, health from circuits).
export * from './core/propagate.js';
export * from './core/sla.js';
export * from './core/availability.js';
export * from './core/history.js';
export * from './core/simulate.js';
export * from './core/readiness.js';
export * from './core/circuits.js';
export * from './integrations/payloads.js';
export * from './integrations/delivery.js';
export * from './integrations/routes.js';
export * from './service/health-rules.js';
export * from './service/incidents.js';
export * from './service/sla.js';
export * from './service/monitoring.js';
export {
  createEngine,
  slaDefinitionOf,
  type Engine,
  type EngineDeps,
  type ApplyReport,
  type RecomputeReport,
  type SlaReport,
  type SecretsReader,
  HEALTH_CHANGED,
  INCIDENT_OPENED,
  INCIDENT_RESOLVED,
  INCIDENT_UPDATED,
  SLA_BREACHED,
  SLA_AT_RISK,
} from './service/engine.js';
