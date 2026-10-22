// REQ-BSM-001 REQ-BSM-002 — derives a CI's health from what collectors observed. Pure: the same CI
// snapshot and clock always give the same answer, so every rule is unit-tested. Liveness-bearing
// types are healthy when observed with no negative signal and unknown once stale; passive records
// (subnets, software, contracts) stay unknown because nothing observes them being "up".
import { BSM, TIME } from '@openmap/constants';
import type { Ci, CiType } from '@openmap/contracts';
import type { Health } from '../core/propagate.js';

/** Types whose presence in a fresh observation means the thing is running. */
export const LIVENESS_TYPES: ReadonlySet<CiType> = new Set<CiType>([
  'host', 'chassis', 'blade', 'bmc', 'hypervisor', 'vm_cluster', 'vm', 'operating_system', 'container', 'k8s_cluster', 'k8s_namespace', 'k8s_workload', 'k8s_service',
  'network_device', 'interface', 'port', 'load_balancer', 'storage_array', 'lun', 'fc_switch', 'fc_fabric', 'nas_share', 'object_bucket', 'database', 'database_cluster',
  'application', 'application_component', 'listening_service', 'pdu', 'ups', 'cooling_unit', 'cloud_account', 'cloud_resource', 'saas_application', 'site_link',
]);

const DOWN_POWER = new Set(['off', 'powered_off', 'stopped', 'shut off', 'shutoff', 'poweredoff', 'deallocated']);
const DOWN_LINK = new Set(['down', 'lowerlayerdown', 'notpresent', 'offline', 'no_light', 'no_sync', 'disconnected', 'not_responding', 'failed', 'faulted', 'critical', 'error']);
const DEGRADED_WORDS = new Set(['degraded', 'warning', 'warn', 'paused', 'suspended', 'maintenance', 'standby_down', 'partial']);
const HEALTHY_WORDS = new Set(['ok', 'healthy', 'up', 'online', 'running', 'connected', 'ready', 'active', 'enabled', 'normal', 'good', 'succeeded', 'powered_on', 'on']);

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function wordHealth(word: string): Health | null {
  if (word === '') return null;
  if (DOWN_LINK.has(word) || DOWN_POWER.has(word)) return 'down';
  if (DEGRADED_WORDS.has(word)) return 'degraded';
  if (HEALTHY_WORDS.has(word)) return 'healthy';
  return null;
}

/** Health from the generic status-like attributes most collectors emit. */
function statusAttributes(a: Readonly<Record<string, unknown>>): Health | null {
  for (const key of ['health', 'state', 'status', 'connectionState', 'operStatus', 'linkStatus', 'provisioningState']) {
    const h = wordHealth(str(a[key]));
    if (h !== null) return h;
  }
  return null;
}

export interface HealthVerdict {
  health: Health;
  /** The attribute and value that decided the verdict, for the console's "why" tooltip. */
  reason: string;
}

/** Decides health for one CI as of `now` (ISO timestamp). */
export function deriveHealth(ci: Pick<Ci, 'type' | 'attributes' | 'observedAt' | 'lifecycle'>, now: string): HealthVerdict {
  const a = ci.attributes;
  if (ci.lifecycle === 'retired' || ci.lifecycle === 'planned') return { health: 'unknown', reason: 'lifecycle ' + ci.lifecycle };
  switch (ci.type) {
    case 'certificate': {
      const days = num(a['daysToExpiry']);
      if (bool(a['expired']) === true || (days !== null && days < 0)) return { health: 'down', reason: 'certificate expired' };
      if (days !== null && days <= BSM.certificateWarnDays) return { health: 'degraded', reason: 'certificate expires in ' + String(days) + ' days' };
      return { health: 'healthy', reason: 'certificate valid' };
    }
    case 'k8s_workload': {
      const desired = num(a['replicasDesired']);
      const ready = num(a['replicasReady']);
      if (desired !== null && ready !== null && desired > 0) {
        if (ready === 0) return { health: 'down', reason: 'no ready replicas' };
        if (ready < desired * BSM.workloadHealthyRatio) return { health: 'degraded', reason: String(ready) + '/' + String(desired) + ' replicas ready' };
      }
      return { health: 'healthy', reason: 'replicas ready' };
    }
    case 'container': {
      if (bool(a['ready']) === false) return { health: 'degraded', reason: 'container not ready' };
      const phase = str(a['phase']);
      if (phase === 'failed' || phase === 'unknown') return { health: 'down', reason: 'pod ' + phase };
      return { health: 'healthy', reason: 'container ready' };
    }
    case 'interface':
    case 'port': {
      const admin = str(a['adminStatus']);
      if (admin === 'down' || admin === 'disabled') return { health: 'unknown', reason: 'administratively down' };
      const oper = wordHealth(str(a['operStatus'] ?? a['status'] ?? a['state'] ?? a['linkStatus']));
      if (oper === 'down') return { health: 'down', reason: 'link down' };
      if (oper === 'degraded') return { health: 'degraded', reason: 'link degraded' };
      if (oper === 'healthy') return { health: 'healthy', reason: 'link up' };
      break;
    }
    case 'host':
    case 'vm':
    case 'hypervisor': {
      const power = str(a['powerState']);
      if (DOWN_POWER.has(power)) return { health: 'down', reason: 'power ' + power };
      const h = statusAttributes(a);
      if (h !== null) return { health: h, reason: 'status attribute' };
      const psus = num(a['powerSupplies']);
      const healthyPsus = num(a['powerSuppliesHealthy']);
      if (psus !== null && healthyPsus !== null && healthyPsus < psus) return { health: 'degraded', reason: String(healthyPsus) + '/' + String(psus) + ' power supplies healthy' };
      break;
    }
    case 'vm_cluster':
    case 'k8s_cluster': {
      const nodes = num(a['nodeCount']);
      const ready = num(a['nodesReady']);
      if (nodes !== null && ready !== null && nodes > 0 && ready < nodes) return { health: ready === 0 ? 'down' : 'degraded', reason: String(ready) + '/' + String(nodes) + ' nodes ready' };
      break;
    }
    default: {
      const h = statusAttributes(a);
      if (h !== null) return { health: h, reason: 'status attribute' };
    }
  }
  if (!LIVENESS_TYPES.has(ci.type)) return { health: 'unknown', reason: 'passive record' };
  const observed = Date.parse(ci.observedAt);
  const ageMinutes = (Date.parse(now) - observed) / TIME.msPerSecond / TIME.secondsPerMinute;
  if (Number.isFinite(ageMinutes) && ageMinutes > BSM.staleAfterMinutes) return { health: 'unknown', reason: 'not observed for ' + String(Math.round(ageMinutes)) + ' minutes' };
  return { health: 'healthy', reason: 'observed' };
}
