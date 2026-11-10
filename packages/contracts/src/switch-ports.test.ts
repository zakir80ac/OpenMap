// T-555 REQ-IPAM-004 (ADR-063) — switch port arithmetic: MAC spellings to one form, a port's state and speed from either
// attribute shape (IF-MIB names or the SNMP collector's booleans), learned MACs canonical and counted, the changes
// between a port's versions, and how long a port has not been up.
import { describe, expect, it } from 'vitest';
import { SWITCH_PORTS, TIME } from '@openmap/constants';
import {
  daysNotUp,
  isUnused,
  learnedMacs,
  normaliseMac,
  portChanges,
  portFacts,
  portSpeedMbps,
  portState,
} from './switch-ports.js';

describe('switch ports', () => {
  it('reads every common MAC spelling as one form and refuses anything else', () => {
    for (const m of [
      '00:50:56:AB:CD:EF',
      '00-50-56-ab-cd-ef',
      '0050.56ab.cdef',
      '005056abcdef',
      ' 00:50:56:ab:cd:ef ',
    ])
      expect(normaliseMac(m), m).toBe('00:50:56:ab:cd:ef');
    for (const m of ['00:50:56:ab:cd', '00:50:56:ab:cd:eg', '', null, undefined])
      expect(normaliseMac(m)).toBeNull();
  });
  it('reads state and speed from IF-MIB names and from the SNMP collector booleans', () => {
    expect(portState({ ifAdminStatus: 'up', ifOperStatus: 'up' })).toBe('up');
    expect(portState({ ifAdminStatus: 'up', ifOperStatus: 'lowerLayerDown' })).toBe('down');
    expect(portState({ ifAdminStatus: 'down', ifOperStatus: 'down' })).toBe('admin_down');
    expect(portState({ adminUp: true, operUp: false })).toBe('down');
    expect(portState({ adminUp: false, operUp: false })).toBe('admin_down');
    expect(portState({})).toBe('unknown');
    expect(portSpeedMbps({ ifSpeedMbps: 25_000 })).toBe(25_000);
    expect(portSpeedMbps({ speedBps: 10_000_000_000 })).toBe(10_000);
    expect(portSpeedMbps({ speedBps: 0 })).toBeNull();
  });
  it('keeps learned MACs canonical and unique, with the full count when the list was capped', () => {
    expect(
      learnedMacs({ learnedMacs: ['00:50:56:01:02:03', '0050.5601.0203', 'bad'], learnedMacCount: 70 }),
    ).toEqual({ macs: ['00:50:56:01:02:03'], count: 70 });
    expect(learnedMacs({ learnedMacs: ['aa:bb:cc:dd:ee:ff'] })).toEqual({
      macs: ['aa:bb:cc:dd:ee:ff'],
      count: 1,
    });
    expect(learnedMacs({})).toEqual({ macs: [], count: 0 });
  });
  it('lists the changes between consecutive versions and ignores what did not change', () => {
    const day = TIME.msPerDay;
    const v = (at: number, attributes: Record<string, unknown>) => ({ at: at * day, attributes });
    const changes = portChanges([
      v(2, {
        ifAdminStatus: 'up',
        ifOperStatus: 'down',
        ifSpeedMbps: 10_000,
        ifAlias: 'srv-01',
        learnedMacs: [],
      }),
      v(1, {
        ifAdminStatus: 'up',
        ifOperStatus: 'up',
        ifSpeedMbps: 10_000,
        ifAlias: 'srv-01',
        learnedMacs: ['00:50:56:01:02:03'],
      }),
      v(3, {
        ifAdminStatus: 'up',
        ifOperStatus: 'up',
        ifSpeedMbps: 1_000,
        ifAlias: 'srv-02',
        learnedMacs: ['00:50:56:09:09:09'],
      }),
      v(4, {
        ifAdminStatus: 'up',
        ifOperStatus: 'up',
        ifSpeedMbps: 1_000,
        ifAlias: 'srv-02',
        learnedMacs: ['00:50:56:09:09:09'],
      }),
    ]);
    expect(changes.map((c) => [c.at / day, c.key, c.from, c.to])).toEqual([
      [2, 'state', 'up', 'down'],
      [2, 'learnedMacs', '00:50:56:01:02:03', null],
      [3, 'state', 'down', 'up'],
      [3, 'speedMbps', '10000', '1000'],
      [3, 'alias', 'srv-01', 'srv-02'],
      [3, 'learnedMacs', null, '00:50:56:09:09:09'],
    ]);
    expect(portFacts({ pvid: 0 }).pvid).toBeNull();
  });
  it('counts the days a port has not been up and calls it unused past the line', () => {
    const day = TIME.msPerDay;
    const now = 100 * day;
    expect(daysNotUp([{ at: 10 * day, attributes: { ifOperStatus: 'up' } }], now)).toBeNull();
    // Up at day 10, seen down from day 20: down since day 20.
    expect(
      daysNotUp(
        [
          { at: 10 * day, attributes: { ifOperStatus: 'up' } },
          { at: 20 * day, attributes: { ifOperStatus: 'down' } },
        ],
        now,
      ),
    ).toBe(80);
    // Never up: since its first version.
    expect(daysNotUp([{ at: 90 * day, attributes: { ifOperStatus: 'down' } }], now)).toBe(10);
    expect(daysNotUp([], now)).toBeNull();
    expect(isUnused(SWITCH_PORTS.unusedDays)).toBe(true);
    expect(isUnused(SWITCH_PORTS.unusedDays - 1)).toBe(false);
    expect(isUnused(null)).toBe(false);
  });
});
