// T-001 REQ-CORE-003
import { describe, expect, it } from 'vitest';
import { ConfigError, describeEnv, loadEnv, parseTenantSettings } from './index.js';

describe('loadEnv', () => {
  it('applies documented defaults when nothing is set', () => {
    const env = loadEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.FEATURE_OUTBOUND_INTEGRATIONS).toBe(false);
  });
  it('coerces ports and booleans from strings', () => {
    const env = loadEnv({ API_PORT: '5001', FEATURE_ASSISTANT: 'false' });
    expect(env.API_PORT).toBe(5001);
    expect(env.FEATURE_ASSISTANT).toBe(false);
  });
  it('rejects invalid values with a ConfigError naming the variable', () => {
    expect(() => loadEnv({ API_PORT: '99999' })).toThrowError(ConfigError);
    expect(() => loadEnv({ POSTGRES_URL: 'not a url' })).toThrowError(/POSTGRES_URL/);
  });
  it('describes every variable with its default', () => {
    const rows = describeEnv();
    expect(rows.find((r) => r.name === 'DEFAULT_LOCALE')?.defaultValue).toBe('en');
    expect(rows.length).toBeGreaterThan(30);
  });
});

describe('parseTenantSettings', () => {
  it('fills defaults and validates overrides', () => {
    expect(parseTenantSettings({ locale: 'ar' }).locale).toBe('ar');
    expect(() => parseTenantSettings({ locale: 'fr' })).toThrow();
  });
});
