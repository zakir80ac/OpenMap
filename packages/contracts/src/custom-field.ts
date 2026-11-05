// REQ-CMDB-015 — the custom-field contract (0.1.0): a tenant defines fields (key, labels in both locales, type, options
// for a select, the CI types they apply to, whether required) and every CI carries values for the fields that apply
// to its type. One validator serves the API (which refuses a bad write) and the console (which says why before
// sending), so both read a value the same way: text trimmed, numbers finite, dates as YYYY-MM-DD, a select's value one
// of its options, null to clear.
import { z } from 'zod';
import { CUSTOM_FIELDS } from '@openmap/constants';
import { ciTypeSchema, type CiType } from './ci.js';

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

const label = z.string().trim().min(1).max(CUSTOM_FIELDS.maxLabelLength);

export const customFieldDefinitionInputSchema = z
  .object({
    key: z.string().regex(new RegExp(CUSTOM_FIELDS.keyPattern)),
    labelEn: label,
    labelAr: label,
    description: z.string().trim().max(CUSTOM_FIELDS.maxDescriptionLength).default(''),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: z.array(label).max(CUSTOM_FIELDS.maxOptions).default([]),
    appliesTo: z.array(ciTypeSchema).default([]),
    required: z.boolean().default(false),
  })
  .refine((d) => d.type !== 'select' || d.options.length > 0, { message: 'a select field needs at least one option', path: ['options'] })
  .refine((d) => new Set(d.options).size === d.options.length, { message: 'options must be distinct', path: ['options'] });
export type CustomFieldDefinitionInput = z.infer<typeof customFieldDefinitionInputSchema>;

export interface CustomFieldDefinition extends CustomFieldDefinitionInput {
  id: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

export type CustomFieldValue = string | number | boolean;
export type CustomFieldValues = Record<string, CustomFieldValue>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a definition applies to a CI type (an empty list applies to every type). */
export function appliesToType(def: Pick<CustomFieldDefinition, 'appliesTo'>, type: CiType): boolean {
  return def.appliesTo.length === 0 || def.appliesTo.includes(type);
}

/** One value read against its definition: the normalised value, or why it was refused. */
export function readCustomFieldValue(def: Pick<CustomFieldDefinition, 'type' | 'options'>, raw: unknown): { value: CustomFieldValue } | { error: string } {
  switch (def.type) {
    case 'text': {
      if (typeof raw !== 'string') return { error: 'expects text' };
      const text = raw.trim();
      if (text === '') return { error: 'expects text' };
      return text.length > CUSTOM_FIELDS.maxTextLength ? { error: 'is too long' } : { value: text };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
      return Number.isFinite(n) ? { value: n } : { error: 'expects a number' };
    }
    case 'date': {
      // A calendar date that round-trips: Date would roll 2027-02-30 over to 2 March rather than refuse it.
      const text = typeof raw === 'string' && DATE.test(raw) ? raw : null;
      const parsed = text === null ? null : new Date(text + 'T00:00:00Z');
      if (text === null || parsed === null || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, text.length) !== text) return { error: 'expects a date (YYYY-MM-DD)' };
      return { value: text };
    }
    case 'boolean':
      return typeof raw === 'boolean' ? { value: raw } : raw === 'true' || raw === 'false' ? { value: raw === 'true' } : { error: 'expects true or false' };
    case 'select':
      return typeof raw === 'string' && def.options.includes(raw) ? { value: raw } : { error: 'expects one of ' + def.options.join(', ') };
  }
}

/**
 * Applies a change to a CI's values: keys set to null are cleared, the others read against their definitions. A key
 * with no definition for the CI's type, a bad value, or a required field left empty is refused with its reason.
 */
export function applyCustomFieldChange(
  defs: readonly CustomFieldDefinition[],
  type: CiType,
  current: CustomFieldValues,
  change: Readonly<Record<string, unknown>>,
): { ok: true; values: CustomFieldValues } | { ok: false; errors: string[] } {
  const applicable = new Map(defs.filter((d) => appliesToType(d, type)).map((d) => [d.key, d]));
  const errors: string[] = [];
  const next: CustomFieldValues = {};
  for (const [key, value] of Object.entries(current)) if (applicable.has(key)) next[key] = value;
  for (const [key, raw] of Object.entries(change)) {
    const def = applicable.get(key);
    if (def === undefined) {
      errors.push(key + ': no custom field of that key applies to ' + type);
      continue;
    }
    if (raw === null || raw === '') {
      delete next[key];
      continue;
    }
    const read = readCustomFieldValue(def, raw);
    if ('error' in read) errors.push(key + ' ' + read.error);
    else next[key] = read.value;
  }
  for (const def of applicable.values()) if (def.required && next[def.key] === undefined && Object.hasOwn(change, def.key)) errors.push(def.key + ' is required');
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values: next };
}
