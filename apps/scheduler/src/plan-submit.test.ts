// T-358 REQ-QA-005 — plan submission: credential paths are safe vault references built from the simulator and run,
// and each plan entry becomes a valid collector job carrying its targets, options and credential type.
import { CONTRACT_VERSIONS } from '@openmap/constants';
import { describe, expect, it } from 'vitest';
import { credentialPath, jobFor } from './plan-submit.js';

describe('plan submission', () => {
  it('builds vault references the scheduler accepts', () => {
    expect(credentialPath('simulated', { simulator: 'pure-flasharray', run: 'ryd-pure-01' })).toBe('simulated/pure-flasharray/ryd-pure-01');
    expect(credentialPath('simulated', { simulator: 'vendor warranty', run: '' })).toBe('simulated/vendor-warranty/default');
    expect(credentialPath('simulated', { simulator: '../etc', run: 'a b' })).toBe('simulated/etc/a-b');
  });

  it('turns an entry into a collector job', () => {
    const job = jobFor(
      {
        simulator: 'vendor-warranty',
        run: 'dell',
        collector: 'warranty',
        targets: [{ kind: 'account', value: 'https://simulator:4443' }],
        options: { vendor: 'dell', verifyTls: true },
        credentialType: 'oauth_client',
        credential: { type: 'oauth_client', fields: { clientId: 'openmap-sim', clientSecret: 's' } },
      },
      '00000000-0000-4000-8000-000000000001',
      'node-compose-01',
      'simulated/vendor-warranty/dell',
      '2026-11-07T08:00:00.000Z',
    );
    expect(job).toMatchObject({ collectorId: 'warranty', nodeId: 'node-compose-01', credentialRef: 'simulated/vendor-warranty/dell', credentialType: 'oauth_client', contractVersion: CONTRACT_VERSIONS.collector });
    expect(job.options).toEqual({ vendor: 'dell', verifyTls: true });
  });
});
