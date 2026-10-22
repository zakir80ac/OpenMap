// REQ-BSM-002 REQ-BSM-003 REQ-INT-005 REQ-INT-007 — bsm-engine package entry point: health
// propagation, SLA budgets, impact simulation and the ITSM/SIEM payload builders and delivery engine.
export * from './core/propagate.js';
export * from './core/sla.js';
export * from './core/simulate.js';
export * from './integrations/payloads.js';
export * from './integrations/delivery.js';
export * from './integrations/routes.js';
export * from './service/health-rules.js';
export * from './service/incidents.js';
export { createEngine, type Engine, type EngineDeps, type ApplyReport, type RecomputeReport, type SecretsReader, HEALTH_CHANGED, INCIDENT_OPENED, INCIDENT_RESOLVED, INCIDENT_UPDATED } from './service/engine.js';
