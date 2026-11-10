// T-621 REQ-INT-011 (ADR-072) — the YAML emitter: block mappings and sequences, empty collections inline, every string
// double-quoted with the characters YAML 1.1 readers refuse raw escaped, keys plain only when they cannot be misread.
// Real YAML readers (PyYAML through Salt, Psych through Puppet) parse its output in the tools check (T-625).
import { describe, expect, it } from 'vitest';
import { toYaml, yamlString } from './yaml.js';

describe('toYaml', () => {
  it('writes nested mappings and sequences in block style', () => {
    expect(
      toYaml({
        web: { host: '192.0.2.1', port: 22, sudo: true, tags: ['a', 'b'], none: null, empty: [], map: {} },
      }),
    ).toBe(
      [
        '---',
        'web:',
        '  host: "192.0.2.1"',
        '  port: 22',
        '  sudo: true',
        '  tags:',
        '    - "a"',
        '    - "b"',
        '  none: null',
        '  empty: []',
        '  map: {}',
        '',
      ].join('\n'),
    );
  });

  it('writes mappings inside sequences and sequences inside sequences', () => {
    expect(toYaml({ s: [{ id: 'x', code: 'BS-1' }, ['n']] })).toBe(
      ['---', 's:', '  -', '    id: "x"', '    code: "BS-1"', '  -', '    - "n"', ''].join('\n'),
    );
  });

  it('quotes keys a YAML 1.1 reader could take for a boolean, null or anything but a plain word', () => {
    expect(toYaml({ yes: 1, On: 2, 'role::web': {}, 'a b': 3, plain_key: 4 })).toBe(
      ['---', '"yes": 1', '"On": 2', '"role::web": {}', '"a b": 3', 'plain_key: 4', ''].join('\n'),
    );
  });

  it('escapes line separators, controls and the byte-order mark, and keeps other text', () => {
    expect(yamlString('a\u2028b\u0085c\u007fd\ufeff')).toBe('"a\\u2028b\\u0085c\\u007fd\\ufeff"');
    expect(yamlString('خادم "رئيسي"\n')).toBe('"خادم \\"رئيسي\\"\\n"');
  });

  it('writes an empty document as an empty mapping, drops undefined members and nulls non-finite numbers', () => {
    expect(toYaml({})).toBe('---\n{}\n');
    expect(toYaml({ a: undefined, b: Number.NaN })).toBe('---\nb: null\n');
  });
});
