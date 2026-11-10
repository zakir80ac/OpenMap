// REQ-INT-011 (ADR-072) — a YAML emitter for the inventory documents (salt-ssh roster, Puppet ENC). The documents are
// JSON values, so the emitter needs only block mappings, block sequences and scalars: every string is a double-quoted
// scalar (JSON's string escapes are a subset of YAML's, plus the line and paragraph separators and the non-printable
// characters YAML 1.1 readers such as PyYAML and Psych refuse raw), and a key is written plain only when no YAML 1.1
// reader could take it for anything but a string.
import { INVENTORY } from '@openmap/constants';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Characters JSON.stringify leaves raw that a YAML reader treats as a line break or refuses as non-printable. */
const YAML_UNSAFE = /[\u007f-\u009f\u2028\u2029\ufeff]/gu;

/** YAML 1.1 plain scalars that are not strings (booleans, null), which a plain key must never be. */
const YAML11_RESERVED = new Set(['y', 'yes', 'n', 'no', 'true', 'false', 'on', 'off', 'null']);
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function yamlString(value: string): string {
  return JSON.stringify(value).replace(
    YAML_UNSAFE,
    (c) => '\\u' + c.charCodeAt(0).toString(INVENTORY.yamlEscape.radix).padStart(INVENTORY.yamlEscape.digits, '0'),
  );
}

function yamlKey(key: string): string {
  return PLAIN_KEY.test(key) && !YAML11_RESERVED.has(key.toLowerCase()) ? key : yamlString(key);
}

function scalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return yamlString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  return value ? 'true' : 'false';
}

function isMap(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The text after `key:` or `-`: an inline scalar or empty collection, or the nested block on the following lines. */
function after(value: Json, depth: number): string {
  if (Array.isArray(value)) return value.length === 0 ? ' []' : '\n' + block(value, depth);
  if (isMap(value)) return Object.keys(value).length === 0 ? ' {}' : '\n' + block(value, depth);
  return ' ' + scalar(value);
}

function block(value: Json[] | { [key: string]: Json }, depth: number): string {
  const pad = ' '.repeat(depth * INVENTORY.yamlIndent);
  if (Array.isArray(value)) return value.map((item) => pad + '-' + after(item, depth + 1)).join('\n');
  return Object.entries(value)
    .map(([k, v]) => pad + yamlKey(k) + ':' + after(v, depth + 1))
    .join('\n');
}

/** One YAML document (`---` first, a newline last) of a JSON value; `undefined` members are dropped, as JSON drops them. */
export function toYaml(value: unknown): string {
  if (value === undefined) return '---\nnull\n';
  const json = JSON.parse(JSON.stringify(value)) as Json;
  const body = Array.isArray(json) || isMap(json) ? after(json, 0).replace(/^[ \n]/u, '') : scalar(json);
  return '---\n' + body + '\n';
}
