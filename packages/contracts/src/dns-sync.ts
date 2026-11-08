// REQ-IPAM-003 (ADR-055) — two-way DNS sync: the record changes OpenMap can push to an authoritative server, their
// validation, and how a change is confirmed from the zone transfer that follows it.
import { z } from 'zod';

export const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'PTR', 'MX', 'SRV', 'NS'] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];
export const DNS_CHANGE_OPS = ['add', 'delete'] as const;
export type DnsChangeOp = (typeof DNS_CHANGE_OPS)[number];
/** pending (not sent yet), sent (with the zone's job), applied (the transfer shows it), failed. */
export const DNS_CHANGE_STATES = ['pending', 'sent', 'applied', 'failed'] as const;
export type DnsChangeState = (typeof DNS_CHANGE_STATES)[number];

/** A DNS name or a label of one: letters, digits, hyphens and underscores (SRV), dot-separated; "@" is the apex. */
const NAME = /^(@|(\*\.)?[A-Za-z0-9_]([A-Za-z0-9_-]{0,62})(\.[A-Za-z0-9_]([A-Za-z0-9_-]{0,62}))*\.?)$/u;
const MAX_TTL = 2_147_483_647;

export const dnsChangeInputSchema = z
  .object({
    zone: z.string().trim().min(1).regex(NAME),
    op: z.enum(DNS_CHANGE_OPS),
    name: z.string().trim().min(1).regex(NAME),
    recordType: z.enum(DNS_RECORD_TYPES),
    value: z.string().trim().min(1),
    ttl: z.number().int().positive().max(MAX_TTL),
  })
  .superRefine((c, ctx) => {
    if (c.recordType === 'A' && !z.ipv4().safeParse(c.value).success) ctx.addIssue({ code: 'custom', path: ['value'], message: 'an A record holds an IPv4 address' });
    if (c.recordType === 'AAAA' && !z.ipv6().safeParse(c.value).success) ctx.addIssue({ code: 'custom', path: ['value'], message: 'an AAAA record holds an IPv6 address' });
    if ((c.recordType === 'CNAME' || c.recordType === 'PTR' || c.recordType === 'NS') && !NAME.test(c.value))
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'a ' + c.recordType + ' record holds a DNS name' });
  });
export type DnsChangeInput = z.infer<typeof dnsChangeInputSchema>;

function bare(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/u, '');
}

/** A record name made absolute within its zone, without the trailing dot, as the transfer reports it. */
export function dnsNameIn(name: string, zone: string): string {
  const n = bare(name);
  const z = bare(zone);
  if (n === '@' || n === z) return z;
  return n.endsWith('.' + z) ? n : n + '.' + z;
}

/** A record value compared as the transfer reports it: names lower-cased without the trailing dot, text unquoted. */
export function dnsValueKey(recordType: string, value: string): string {
  const v = value.trim();
  if (recordType === 'TXT') return v.replace(/^"(.*)"$/u, '$1');
  return bare(v);
}

export interface ObservedRecord {
  name: string;
  recordType: string;
  value: string;
}

/** Whether a transfer holds the record a change names. */
export function transferHolds(records: readonly ObservedRecord[], change: { zone: string; name: string; recordType: string; value: string }): boolean {
  const name = dnsNameIn(change.name, change.zone);
  const value = dnsValueKey(change.recordType, change.value);
  return records.some((r) => bare(r.name) === name && r.recordType.toUpperCase() === change.recordType && dnsValueKey(r.recordType, r.value) === value);
}

/** applied when the transfer shows the change (an added record present, a deleted one absent), failed otherwise. */
export function settleDnsChange(records: readonly ObservedRecord[], change: { zone: string; op: string; name: string; recordType: string; value: string }): 'applied' | 'failed' {
  const holds = transferHolds(records, change);
  return (change.op === 'add') === holds ? 'applied' : 'failed';
}
