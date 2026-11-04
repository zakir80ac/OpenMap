// T-064 REQ-UI-013 REQ-BSM-003 — condition applicability by type and layer, ordering by severity, name summaries.
import { CI_TYPES, CI_TYPE_LAYER, SCENARIO_KIND_SEVERITY, scenarioKindSchema } from '@openmap/contracts';
import { describe, expect, it } from 'vitest';
import { CONDITION_SPECS, IMPACT_CONDITIONS, applicableConditions, conditionApplies, isImpactCondition, summariseNames } from './impact-conditions';

describe('conditions and the scenario contract', () => {
  it('offers only conditions the API accepts as a scenario kind, at the severity the engine applies', () => {
    // The picker once sent its own ids as the kind and every save came back "invalid ScenarioInput" (ADR-019).
    for (const condition of IMPACT_CONDITIONS) {
      expect(scenarioKindSchema.safeParse(condition).success).toBe(true);
      expect(CONDITION_SPECS[condition].severity).toBe(SCENARIO_KIND_SEVERITY[condition]);
    }
  });
  it('applies a maintenance window to every component as degraded', () => {
    expect(conditionApplies('maintenance', { type: 'something-new', layer: 'unknown' })).toBe(true);
    expect(CONDITION_SPECS.maintenance.severity).toBe('degraded');
  });
});

const component = (type: (typeof CI_TYPES)[number]) => ({ type, layer: CI_TYPE_LAYER[type] });

describe('conditionApplies', () => {
  it('applies degraded and failed to every component, including unknown types', () => {
    for (const type of CI_TYPES) {
      expect(conditionApplies('degraded', component(type))).toBe(true);
      expect(conditionApplies('failed', component(type))).toBe(true);
    }
    expect(conditionApplies('failed', { type: 'something-new', layer: 'unknown' })).toBe(true);
    expect(conditionApplies('power_loss', { type: 'something-new', layer: 'unknown' })).toBe(false);
  });
  it('matches physical conditions to physical components only', () => {
    expect(conditionApplies('power_loss', component('host'))).toBe(true);
    expect(conditionApplies('power_loss', component('pdu'))).toBe(true);
    expect(conditionApplies('power_loss', component('network_device'))).toBe(true);
    expect(conditionApplies('power_loss', component('application'))).toBe(false);
    expect(conditionApplies('power_loss', component('vm'))).toBe(false);
    expect(conditionApplies('warranty_expired', component('host'))).toBe(true);
    expect(conditionApplies('warranty_expired', component('saas_application'))).toBe(false);
  });
  it('matches software and commercial conditions by type or layer', () => {
    expect(conditionApplies('certificate_expired', component('certificate'))).toBe(true);
    expect(conditionApplies('certificate_expired', component('load_balancer'))).toBe(true);
    expect(conditionApplies('certificate_expired', component('rack'))).toBe(false);
    expect(conditionApplies('subscription_expired', component('saas_tenant'))).toBe(true);
    expect(conditionApplies('subscription_expired', component('cloud_resource'))).toBe(true);
    expect(conditionApplies('subscription_expired', component('host'))).toBe(false);
    expect(conditionApplies('end_of_life', component('operating_system'))).toBe(true);
    expect(conditionApplies('vulnerability_exploited', component('database'))).toBe(true);
    expect(conditionApplies('vulnerability_exploited', component('pdu'))).toBe(false);
    expect(conditionApplies('capacity_exhausted', component('subnet'))).toBe(true);
    expect(conditionApplies('capacity_exhausted', component('lun'))).toBe(true);
    expect(conditionApplies('link_down', component('interface'))).toBe(true);
    expect(conditionApplies('link_down', component('database'))).toBe(false);
  });
});

describe('applicableConditions', () => {
  it('returns the intersection over several components, worst severity first', () => {
    const only = applicableConditions([component('host'), component('application')]);
    expect(only.map((c) => c.id)).toEqual(['failed', 'degraded', 'vulnerability_exploited', 'maintenance']);
    expect(only[0]?.severity).toBe('down');
  });
  it('lists every condition for a host in severity order and nothing for no selection', () => {
    const host = applicableConditions([component('host')]);
    expect(host.map((c) => c.id)).toEqual(['failed', 'power_loss', 'degraded', 'vulnerability_exploited', 'capacity_exhausted', 'maintenance', 'warranty_expired', 'end_of_life']);
    expect(applicableConditions([])).toEqual([]);
  });
  it('covers every declared condition with a spec and a type guard', () => {
    for (const condition of IMPACT_CONDITIONS) {
      expect(CONDITION_SPECS[condition].id).toBe(condition);
      expect(isImpactCondition(condition)).toBe(true);
    }
    expect(isImpactCondition('meteor_strike')).toBe(false);
  });
});

describe('summariseNames', () => {
  it('lists the first names and counts the rest', () => {
    expect(summariseNames(['a', 'b', 'c', 'd'], 2)).toEqual({ listed: ['a', 'b'], more: 2 });
    expect(summariseNames(['a'], 3)).toEqual({ listed: ['a'], more: 0 });
  });
});
