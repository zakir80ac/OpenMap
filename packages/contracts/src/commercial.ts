// REQ-CMDB-026 REQ-CMDB-027 REQ-CMDB-028 REQ-CMDB-029 (ADR-035) — the commercial register: vendors, contracts and cost
// centres are CIs; this module names their kinds, the attributes a person enters for them, and the dates a contract's
// renewal turns on. Shared by the API (which writes and reads the CIs) and the console (which shows and edits them).
import { z } from 'zod';
import { SUPPORT_LEVELS } from './asset.js';

/** What a contract is for. A support contract is the kind an asset's support cover points at. */
export const CONTRACT_KINDS = [
  'support',
  'maintenance',
  'warranty_extension',
  'licence',
  'saas',
  'lease',
  'service',
  'other',
] as const;
export const contractKindSchema = z.enum(CONTRACT_KINDS);
export type ContractKind = z.infer<typeof contractKindSchema>;

/** A cost centre, a department that owns systems, or a customer the organisation runs systems for. */
export const COST_CENTRE_KINDS = ['cost_centre', 'department', 'customer'] as const;
export const costCentreKindSchema = z.enum(COST_CENTRE_KINDS);
export type CostCentreKind = z.infer<typeof costCentreKindSchema>;

/**
 * A contract document by reference: its title and where it lives (a document system URL or a file-share path).
 * OpenMap keeps the reference, never the file.
 */
export const contractDocumentSchema = z.object({
  title: z.string().trim().min(1),
  location: z.string().trim().min(1),
});
export type ContractDocument = z.infer<typeof contractDocumentSchema>;

/** Attribute names of a contract CI (the synthetic estate and the import presets write the same names). */
export const CONTRACT_ATTRIBUTES = {
  contractNumber: 'contractNumber',
  vendorRef: 'vendorRef',
  kind: 'kind',
  title: 'title',
  level: 'level',
  responseMinutes: 'responseMinutes',
  startsAt: 'startsAt',
  endsAt: 'endsAt',
  autoRenews: 'autoRenews',
  noticeDays: 'noticeDays',
  annualCost: 'annualCost',
  currency: 'currency',
  documents: 'documents',
} as const;

export const contractInputSchema = z
  .object({
    /** The vendor CI; its name joins the contract number as the contract's identity. */
    vendorId: z.uuid(),
    /** The cost_centre CI the contract is billed to, if any. */
    costCentreId: z.uuid().nullable(),
    contractNumber: z.string().trim().min(1),
    kind: contractKindSchema,
    title: z.string().trim().min(1),
    level: z.enum(SUPPORT_LEVELS).nullable(),
    responseMinutes: z.number().int().positive().nullable(),
    startsAt: z.iso.date(),
    endsAt: z.iso.date(),
    autoRenews: z.boolean(),
    noticeDays: z.number().int().min(0).nullable(),
    annualCost: z.number().min(0).nullable(),
    currency: z.string().length(3).nullable(),
    documents: z.array(contractDocumentSchema),
  })
  .refine((c) => c.startsAt <= c.endsAt, { message: 'a contract ends on or after it starts', path: ['endsAt'] })
  .refine((c) => c.annualCost === null || c.currency !== null, { message: 'a cost needs its currency', path: ['currency'] });
export type ContractInput = z.infer<typeof contractInputSchema>;

/** The documents a contract CI's attribute holds; malformed entries are dropped rather than failing the read. */
export function contractDocuments(value: unknown): ContractDocument[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = contractDocumentSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

const MS_PER_DAY = 86_400_000;
const DAY_LENGTH = 'YYYY-MM-DD'.length;

/** Whole days from a day to a contract's end (negative once ended); the end day itself counts as covered. */
export function daysToEnd(endsAt: string, today: string): number {
  const end = Date.parse(endsAt.slice(0, DAY_LENGTH) + 'T00:00:00Z');
  const now = Date.parse(today.slice(0, DAY_LENGTH) + 'T00:00:00Z');
  return Math.round((end - now) / MS_PER_DAY);
}

/** The last day to give notice before a contract renews or lapses: its end less the notice period; null without one. */
export function noticeBy(endsAt: string, noticeDays: number | null): string | null {
  if (noticeDays === null) return null;
  const end = Date.parse(endsAt.slice(0, DAY_LENGTH) + 'T00:00:00Z');
  return new Date(end - noticeDays * MS_PER_DAY).toISOString().slice(0, DAY_LENGTH);
}

/** The kind of a contract CI: the stated kind, else support when it states a support level, else other. */
export function contractKindOf(attributes: Record<string, unknown>): ContractKind {
  const parsed = contractKindSchema.safeParse(attributes[CONTRACT_ATTRIBUTES.kind]);
  if (parsed.success) return parsed.data;
  return typeof attributes[CONTRACT_ATTRIBUTES.level] === 'string' ? 'support' : 'other';
}

export const vendorInputSchema = z.object({
  name: z.string().trim().min(1),
  category: z.string().trim().min(1).nullable(),
  supportPortal: z.string().trim().min(1).nullable(),
  accountManager: z.string().trim().min(1).nullable(),
});
export type VendorInput = z.infer<typeof vendorInputSchema>;

export const costCentreInputSchema = z
  .object({
    code: z.string().trim().min(1),
    name: z.string().trim().min(1),
    kind: costCentreKindSchema,
    owner: z.string().trim().min(1).nullable(),
    annualBudget: z.number().min(0).nullable(),
    currency: z.string().length(3).nullable(),
  })
  .refine((c) => c.annualBudget === null || c.currency !== null, { message: 'a budget needs its currency', path: ['currency'] });
export type CostCentreInput = z.infer<typeof costCentreInputSchema>;
