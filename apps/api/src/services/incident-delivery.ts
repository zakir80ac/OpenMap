// REQ-BSM-002 REQ-INT-005 — vendor routing for incidents lives in the BSM engine package so the API
// (on-demand "report incident") and the engine service (automatic delivery) send identical requests.
export { incidentRequest, remoteUrlFor, type OutboundRequest } from '@openmap/bsm-engine';
