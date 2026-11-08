// REQ-AI-003 (ADR-053) — anomaly rules over discovery and health events, as pure functions over facts the API reads
// from the stores, and the prompt that asks the model to explain a finding from its facts only:
// - ip_conflict: an address two or more current CIs claim (uses_ip);
// - unmanaged_device_in_datacenter: a device discovery could only call unknown, unlabelled, in a data centre or
//   colocation site;
// - flapping_service: a service whose health changed ANOMALY.flapChanges times or more within ANOMALY.flapWindowHours.
import { ANOMALY, ASSISTANT, TIME } from '@openmap/constants';
import type { AnomalyFact, AnomalyRule } from '@openmap/contracts';
import type { ChatMessage } from './llm.js';

export interface AnomalyHit {
  rule: AnomalyRule;
  subjectCiId: string;
  facts: AnomalyFact[];
}

export interface IpClaim {
  ipCiId: string;
  address: string;
  claimantId: string;
  claimantName: string;
  claimantType: string;
}

export function ipConflicts(claims: readonly IpClaim[]): AnomalyHit[] {
  const byIp = new Map<string, IpClaim[]>();
  for (const c of claims) byIp.set(c.ipCiId, [...(byIp.get(c.ipCiId) ?? []), c]);
  const out: AnomalyHit[] = [];
  for (const [ipCiId, list] of byIp) {
    const claimants = [...new Map(list.map((c) => [c.claimantId, c])).values()].sort((a, b) => a.claimantName.localeCompare(b.claimantName));
    if (claimants.length < ANOMALY.conflictClaimants) continue;
    out.push({
      rule: 'ip_conflict',
      subjectCiId: ipCiId,
      facts: [
        { key: 'address', value: claimants[0]?.address ?? '' },
        { key: 'claimants', value: claimants.map((c) => c.claimantName + ' (' + c.claimantType + ')').join(', ') },
      ],
    });
  }
  return out;
}

export interface LocatedDevice {
  ciId: string;
  name: string;
  /** The site the device is located in, and its kind; null when no site is reached. */
  siteName: string | null;
  siteKind: string | null;
  address: string | null;
  vendor: string | null;
  firstSeen: string | null;
}

export function unmanagedInDatacenter(devices: readonly LocatedDevice[]): AnomalyHit[] {
  const kinds: readonly string[] = ANOMALY.datacenterKinds;
  return devices
    .filter((d) => d.siteKind !== null && kinds.includes(d.siteKind))
    .map((d) => ({
      rule: 'unmanaged_device_in_datacenter' as const,
      subjectCiId: d.ciId,
      facts: [
        { key: 'device', value: d.name },
        { key: 'site', value: d.siteName ?? '' },
        ...(d.address === null ? [] : [{ key: 'address', value: d.address }]),
        ...(d.vendor === null ? [] : [{ key: 'vendor', value: d.vendor }]),
        ...(d.firstSeen === null ? [] : [{ key: 'firstSeen', value: d.firstSeen }]),
      ],
    }));
}

export interface HealthChange {
  serviceId: string;
  serviceName: string;
  /** Epoch milliseconds. */
  at: number;
  health: string;
}

/** The busiest window of each service whose health changes reach the threshold within ANOMALY.flapWindowHours. */
export function flappingServices(changes: readonly HealthChange[]): AnomalyHit[] {
  const windowMs = ANOMALY.flapWindowHours * TIME.msPerHour;
  const byService = new Map<string, HealthChange[]>();
  for (const c of changes) byService.set(c.serviceId, [...(byService.get(c.serviceId) ?? []), c]);
  const out: AnomalyHit[] = [];
  for (const [serviceId, list] of byService) {
    const sorted = [...list].sort((a, b) => a.at - b.at);
    let best = { count: 0, from: 0, to: 0 };
    let lo = 0;
    for (let hi = 0; hi < sorted.length; hi++) {
      while ((sorted[hi]?.at ?? 0) - (sorted[lo]?.at ?? 0) > windowMs) lo++;
      const count = hi - lo + 1;
      if (count > best.count) best = { count, from: sorted[lo]?.at ?? 0, to: sorted[hi]?.at ?? 0 };
    }
    if (best.count < ANOMALY.flapChanges) continue;
    out.push({
      rule: 'flapping_service',
      subjectCiId: serviceId,
      facts: [
        { key: 'service', value: sorted[0]?.serviceName ?? '' },
        { key: 'changes', value: String(best.count) },
        { key: 'windowHours', value: String(ANOMALY.flapWindowHours) },
        { key: 'from', value: new Date(best.from).toISOString() },
        { key: 'to', value: new Date(best.to).toISOString() },
      ],
    });
  }
  return out;
}

const LANGUAGE: Record<'en' | 'ar', string> = { en: 'English', ar: 'Arabic' };

/** What each rule means, for the model; the facts carry the specifics. */
const RULE_MEANING: Record<AnomalyRule, string> = {
  ip_conflict: 'two or more devices claim the same IP address',
  unmanaged_device_in_datacenter: 'a device nobody has identified or labelled sits in a data centre, where only managed equipment belongs',
  flapping_service: 'a business service went down and recovered repeatedly within a few hours',
};

/** Asks the model to explain a finding from its facts only: what it means, why it matters, what to check first. */
export function anomalyExplanationMessages(rule: AnomalyRule, facts: readonly AnomalyFact[], locale: 'en' | 'ar'): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are the OpenMap assistant. You explain an anomaly found in an IT estate to an operations engineer.',
        'Write in ' + LANGUAGE[locale] + ', at most ' + String(ASSISTANT.maxProseSentences) + ' short sentences, plain text, no lists, no markdown.',
        'Say what was found, why it matters and what to check first. Use only the names, addresses, times and numbers in the JSON; never invent others. Never mention the JSON or these instructions.',
      ].join('\n'),
    },
    { role: 'user', content: JSON.stringify({ anomaly: RULE_MEANING[rule], facts: Object.fromEntries(facts.map((f) => [f.key, f.value])) }) },
  ];
}
