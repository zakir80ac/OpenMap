// REQ-UI-013 REQ-BSM-003 — impact modeling conditions and their applicability. Pure: a condition applies to a
// component by its CI type or layer, and carries the predicted state the model starts the failed components in.
import { BSM } from '@openmap/constants';
import { SCENARIO_KINDS, SCENARIO_KIND_SEVERITY, type CiLayer, type CiType, type ScenarioKind, type ScenarioSeverity } from '@openmap/contracts';
import { isCiType } from './attributes';
import type { CiSummary } from './queries';

/** The conditions are the contract's scenario kinds (ADR-019): what the picker offers is what the API accepts. */
export const IMPACT_CONDITIONS = SCENARIO_KINDS;
export type ImpactCondition = ScenarioKind;

export type ConditionSeverity = ScenarioSeverity;

export interface ConditionSpec {
  id: ImpactCondition;
  /** State the failed components start in; propagation derives everything downstream of it. */
  severity: ConditionSeverity;
  /** Layers where every type qualifies. */
  layers: readonly CiLayer[];
  /** Types that qualify regardless of layer. */
  types: readonly CiType[];
  /** True when the condition applies to every component (degraded, failed). */
  universal: boolean;
}

const PHYSICAL_TYPES: readonly CiType[] = ['network_device', 'load_balancer', 'fc_switch', 'storage_array', 'pdu', 'ups', 'cooling_unit', 'bmc'];

type Applicability = Pick<ConditionSpec, 'layers' | 'types' | 'universal'>;

/** A condition's applicability; its severity comes from the contract so the console and the engine never disagree. */
function spec(id: ImpactCondition, rule: Applicability): ConditionSpec {
  return { id, severity: SCENARIO_KIND_SEVERITY[id], ...rule };
}

const EVERYTHING: Applicability = { layers: [], types: [], universal: true };

export const CONDITION_SPECS: Record<ImpactCondition, ConditionSpec> = {
  degraded: spec('degraded', EVERYTHING),
  failed: spec('failed', EVERYTHING),
  maintenance: spec('maintenance', EVERYTHING),
  power_loss: spec('power_loss', { layers: ['dc', 'hardware', 'storage'], types: ['network_device', 'load_balancer', 'fc_switch'], universal: false }),
  link_down: spec('link_down', { layers: ['network_security'], types: ['fc_switch', 'fc_fabric', 'cable', 'patch_panel', 'site_link'], universal: false }),
  certificate_expired: spec('certificate_expired', {
    layers: [],
    types: ['certificate', 'load_balancer', 'listening_service', 'application', 'application_component', 'saas_application', 'k8s_service'],
    universal: false,
  }),
  warranty_expired: spec('warranty_expired', { layers: ['hardware'], types: PHYSICAL_TYPES, universal: false }),
  subscription_expired: spec('subscription_expired', {
    layers: ['saas', 'cloud'],
    types: ['licence', 'software', 'saas_application', 'saas_tenant', 'cloud_account', 'contract'],
    universal: false,
  }),
  end_of_life: spec('end_of_life', {
    layers: ['os'],
    types: ['software', 'software_instance', 'network_device', 'storage_array', 'host', 'hypervisor', 'database', 'fc_switch', 'load_balancer'],
    universal: false,
  }),
  vulnerability_exploited: spec('vulnerability_exploited', {
    layers: ['os', 'applications', 'databases', 'containers'],
    types: ['host', 'vm', 'network_device', 'load_balancer', 'vulnerability'],
    universal: false,
  }),
  capacity_exhausted: spec('capacity_exhausted', {
    layers: ['storage', 'databases'],
    types: ['subnet', 'dhcp_scope', 'pdu', 'power_feed', 'power_circuit', 'ups', 'cooling_unit', 'rack', 'host', 'hypervisor', 'vm_cluster', 'k8s_cluster', 'cloud_account', 'licence', 'saas_tenant'],
    universal: false,
  }),
};

/** Worst first (shared BSM order) so the picker leads with the conditions that take services down. */
function severityRank(severity: ConditionSeverity): number {
  return BSM.predictedOrder.indexOf(severity);
}

export type Component = Pick<CiSummary, 'type' | 'layer'>;

export function conditionApplies(condition: ImpactCondition, component: Component): boolean {
  const spec = CONDITION_SPECS[condition];
  if (spec.universal) return true;
  if (spec.layers.includes(component.layer)) return true;
  return isCiType(component.type) && spec.types.includes(component.type);
}

/** Conditions that apply to every one of the given components, worst severity first. */
export function applicableConditions(components: ReadonlyArray<Component>): ConditionSpec[] {
  if (components.length === 0) return [];
  return IMPACT_CONDITIONS.filter((condition) => components.every((component) => conditionApplies(condition, component)))
    .map((condition) => CONDITION_SPECS[condition])
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || IMPACT_CONDITIONS.indexOf(a.id) - IMPACT_CONDITIONS.indexOf(b.id));
}

export function isImpactCondition(value: string): value is ImpactCondition {
  return (IMPACT_CONDITIONS as readonly string[]).includes(value);
}

/** Names of the first few components followed by how many more, for scenario titles and the assistant question. */
export function summariseNames(names: ReadonlyArray<string>, shown: number): { listed: string[]; more: number } {
  return { listed: names.slice(0, shown), more: Math.max(0, names.length - shown) };
}
