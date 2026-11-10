// T-574 REQ-CMDB-022 — the subscription's name on screen.
import { describe, expect, it } from 'vitest';
import { productName } from './saas.service.js';

describe('productName', () => {
  it('keeps a product name the vendor reports', () => {
    expect(productName('Workday HCM', 'WD-HCM', 'Workday Human Capital Management')).toBe('Workday HCM');
  });
  it('uses the display name when the product is only the part number', () => {
    expect(productName('SPE_E3', 'SPE_E3', 'Microsoft 365 E3')).toBe('Microsoft 365 E3');
  });
  it('falls back to the display name without a product, and to the part number without a display name', () => {
    expect(productName(null, 'SPE_E3', 'Microsoft 365 E3')).toBe('Microsoft 365 E3');
    expect(productName('SPE_E3', 'SPE_E3', '')).toBe('SPE_E3');
  });
});
