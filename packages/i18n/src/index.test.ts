// T-002 REQ-UI-001
import { describe, expect, it } from 'vitest';
import { catalogues, createTranslator, direction, format, isLocale, translate } from './index.js';

describe('i18n', () => {
  it('has identical key sets in en and ar', () => {
    expect(Object.keys(catalogues.ar).sort()).toEqual(Object.keys(catalogues.en).sort());
  });
  it('translates and interpolates in both locales', () => {
    expect(translate('en', 'common.count', { count: 3 })).toBe('3 items');
    expect(translate('ar', 'common.count', { count: 3 })).toContain('3');
  });
  it('leaves unknown placeholders visible', () => {
    expect(format('{a} and {b}', { a: 'x' })).toBe('x and {b}');
  });
  it('reports direction per locale', () => {
    expect(direction('ar')).toBe('rtl');
    expect(direction('en')).toBe('ltr');
  });
  it('binds a translator', () => {
    expect(createTranslator('ar')('action.save')).toBe(catalogues.ar['action.save']);
  });
  it('validates locale strings', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });
});
