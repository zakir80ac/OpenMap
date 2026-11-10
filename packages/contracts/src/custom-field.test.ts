// T-164 REQ-CMDB-015 — the custom-field contract offline: a definition input is checked (key pattern, a select needs
// distinct options); values are read per type (text trimmed, numbers finite, dates YYYY-MM-DD, booleans from text,
// a select's value one of its options); a change keeps values of applicable fields, clears with null, refuses a key
// that does not apply to the CI's type and a required field left empty.
import { describe, expect, it } from 'vitest';
import { applyCustomFieldChange, customFieldDefinitionInputSchema, readCustomFieldValue, sensitiveKeys, type CustomFieldDefinition } from './custom-field.js';

const base = { tenantId: 't', description: '', createdAt: '', updatedAt: '', appliesTo: [], required: false, sensitive: false, options: [] };
const owner: CustomFieldDefinition = { ...base, id: '1', key: 'owner', labelEn: 'Owner', labelAr: 'المالك', type: 'text' };
const rackU: CustomFieldDefinition = { ...base, id: '2', key: 'rackU', labelEn: 'Rack units', labelAr: 'وحدات', type: 'number', appliesTo: ['host'] };
const tier: CustomFieldDefinition = { ...base, id: '3', key: 'dataTier', labelEn: 'Data tier', labelAr: 'فئة البيانات', type: 'select', options: ['gold', 'silver'], required: true };

describe('custom field contract', () => {
  it('checks a definition input', () => {
    expect(customFieldDefinitionInputSchema.safeParse({ key: 'costCode', labelEn: 'Cost code', labelAr: 'رمز التكلفة', type: 'text' }).success).toBe(true);
    expect(customFieldDefinitionInputSchema.safeParse({ key: 'Bad Key', labelEn: 'x', labelAr: 'x', type: 'text' }).success).toBe(false);
    expect(customFieldDefinitionInputSchema.safeParse({ key: 'tier', labelEn: 'x', labelAr: 'x', type: 'select' }).success).toBe(false);
    expect(customFieldDefinitionInputSchema.safeParse({ key: 'tier', labelEn: 'x', labelAr: 'x', type: 'select', options: ['a', 'a'] }).success).toBe(false);
  });

  it('allows only a text field to be sensitive, and keeps ciphertext-like text out (T-576)', () => {
    const parsed = customFieldDefinitionInputSchema.parse({ key: 'nationalId', labelEn: 'National ID', labelAr: 'رقم الهوية', type: 'text', sensitive: true });
    expect(parsed.sensitive).toBe(true);
    expect(customFieldDefinitionInputSchema.parse({ key: 'costCode', labelEn: 'Cost code', labelAr: 'رمز', type: 'text' }).sensitive).toBe(false);
    expect(customFieldDefinitionInputSchema.safeParse({ key: 'rackU', labelEn: 'x', labelAr: 'x', type: 'number', sensitive: true }).success).toBe(false);
    expect(readCustomFieldValue(owner, 'vault:v1:abc')).toEqual({ error: 'cannot start with vault:v' });
    expect([...sensitiveKeys([owner, { ...owner, key: 'nationalId', sensitive: true }])]).toEqual(['nationalId']);
  });

  it('reads values per type', () => {
    expect(readCustomFieldValue(owner, '  Treasury ')).toEqual({ value: 'Treasury' });
    expect(readCustomFieldValue(rackU, '2')).toEqual({ value: 2 });
    expect(readCustomFieldValue(rackU, 'two')).toHaveProperty('error');
    expect(readCustomFieldValue({ type: 'date', options: [] }, '2027-02-28')).toEqual({ value: '2027-02-28' });
    expect(readCustomFieldValue({ type: 'date', options: [] }, '2027-02-30')).toHaveProperty('error');
    expect(readCustomFieldValue({ type: 'date', options: [] }, '27/02/2027')).toHaveProperty('error');
    expect(readCustomFieldValue({ type: 'boolean', options: [] }, 'true')).toEqual({ value: true });
    expect(readCustomFieldValue(tier, 'bronze')).toHaveProperty('error');
  });

  it('applies a change against the definitions that apply to the CI type', () => {
    const defs = [owner, rackU, tier];
    expect(applyCustomFieldChange(defs, 'host', {}, { owner: 'Treasury', rackU: 2, dataTier: 'gold' })).toEqual({ ok: true, values: { owner: 'Treasury', rackU: 2, dataTier: 'gold' } });
    expect(applyCustomFieldChange(defs, 'host', { owner: 'Treasury', dataTier: 'gold' }, { owner: null })).toEqual({ ok: true, values: { dataTier: 'gold' } });
    const vm = applyCustomFieldChange(defs, 'vm', {}, { rackU: 2 });
    expect(vm.ok).toBe(false);
    expect(!vm.ok && vm.errors[0]).toContain('rackU');
    const cleared = applyCustomFieldChange(defs, 'host', { dataTier: 'gold' }, { dataTier: null });
    expect(!cleared.ok && cleared.errors).toEqual(['dataTier is required']);
    // A value of a field that no longer applies is dropped on the next write rather than kept as a stranger.
    expect(applyCustomFieldChange(defs, 'vm', { rackU: 2 }, { owner: 'Ops' })).toEqual({ ok: true, values: { owner: 'Ops' } });
  });
});
