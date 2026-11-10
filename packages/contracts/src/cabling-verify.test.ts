// T-550 REQ-DCIM-008 (ADR-062) — cable verification arithmetic: verified, mismatch, unobserved and unverifiable paths,
// port matching with and without a port name, observed links deduplicated whichever way round, undocumented links,
// the summary and the suggested label.
import { describe, expect, it } from 'vitest';
import { CABLING } from '@openmap/constants';
import {
  linkKey,
  samePort,
  suggestedCableLabel,
  summariseVerdicts,
  verifyCabling,
  type ObservedLink,
  type RecordedPath,
} from './cabling-verify.js';

const link = (a: [string, string | null], b: [string, string | null], protocol = 'lldp'): ObservedLink => ({
  a: { ciId: a[0], port: a[1] },
  b: { ciId: b[0], port: b[1] },
  protocol,
  media: null,
  speedMbps: null,
});
const path = (
  cableId: string,
  a: [string, string | null] | null,
  b: [string, string | null] | null,
  complete = true,
): RecordedPath => ({
  cableId,
  a: a === null ? null : { ciId: a[0], port: a[1] },
  b: b === null ? null : { ciId: b[0], port: b[1] },
  complete,
});

describe('cable verification', () => {
  it('matches ports case-insensitively and lets a device-only reference match any of its ports', () => {
    expect(samePort({ ciId: 'sw1', port: 'Ethernet1' }, { ciId: 'sw1', port: 'ethernet1 ' })).toBe(true);
    expect(samePort({ ciId: 'sw1', port: 'Ethernet1' }, { ciId: 'sw1', port: 'Ethernet2' })).toBe(false);
    expect(samePort({ ciId: 'sw1', port: null }, { ciId: 'sw1', port: 'Ethernet2' })).toBe(true);
    expect(samePort({ ciId: 'sw1', port: 'Ethernet1' }, { ciId: 'sw2', port: 'Ethernet1' })).toBe(false);
    expect(linkKey(link(['sw1', 'e1'], ['sw2', 'e5']))).toBe(linkKey(link(['sw2', 'E5'], ['sw1', 'E1'])));
  });
  it('gives each recorded path its verdict and lists the observed links nothing explains', () => {
    const observed = [
      link(['sw1', 'Ethernet1'], ['sw2', 'Ethernet5']),
      link(['sw2', 'Ethernet5'], ['sw1', 'Ethernet1']),
      link(['sw1', 'Ethernet2'], ['sw3', 'Ethernet9']),
      link(['srv1', 'eno1'], ['sw1', 'Ethernet7']),
    ];
    const result = verifyCabling(
      [
        path('c-ok', ['sw1', 'Ethernet1'], ['sw2', 'Ethernet5']),
        path('c-wrong', ['sw1', 'Ethernet2'], ['sw4', 'Ethernet1']),
        path('c-quiet', ['sw5', 'Ethernet1'], ['sw6', 'Ethernet1']),
        path('c-panel', ['sw1', 'Ethernet3'], null),
        path('c-open', ['sw1', 'Ethernet4'], ['sw2', 'Ethernet8'], false),
        path('c-device', ['srv1', null], ['sw1', 'Ethernet7']),
      ],
      observed,
    );
    expect(result.verdicts.map((v) => [v.cableId, v.status, v.reason])).toEqual([
      ['c-ok', 'verified', 'observed'],
      ['c-wrong', 'mismatch', 'far_end_differs'],
      ['c-quiet', 'unobserved', 'no_observation'],
      ['c-panel', 'unverifiable', 'end_not_a_port'],
      ['c-open', 'unverifiable', 'path_incomplete'],
      ['c-device', 'verified', 'observed'],
    ]);
    expect(result.verdicts[1]?.observed?.b).toEqual({ ciId: 'sw3', port: 'Ethernet9' });
    expect(result.undocumented.map(linkKey)).toEqual([
      linkKey(link(['sw1', 'Ethernet2'], ['sw3', 'Ethernet9'])),
    ]);
    expect(summariseVerdicts(result)).toEqual({
      cables: 6,
      verified: 2,
      mismatch: 1,
      unobserved: 1,
      unverifiable: 2,
      undocumented: 1,
    });
  });
  it('suggests a label from both ends within the label length', () => {
    expect(suggestedCableLabel('tor-a', 'Ethernet1/1', 'esx-01', 'eno1')).toBe(
      'tor-a:Ethernet1/1 - esx-01:eno1',
    );
    expect(suggestedCableLabel('core', null, 'dist', 'Ethernet47')).toBe('core - dist:Ethernet47');
    expect(suggestedCableLabel('x'.repeat(CABLING.labelMaxChars), 'p', 'y', 'q')).toHaveLength(
      CABLING.labelMaxChars,
    );
  });
});
