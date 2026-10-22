// REQ-CORE-008 — guard rules (CLAUDE.md §7). Pure functions over file text so each rule is unit-testable.
import { GUARD_ALLOWED_IPV4, GUARD_ALLOWED_NUMERIC_LITERALS, GUARD_CONFIG_BOUNDARIES, GUARD_FORBIDDEN_TOKENS, GUARD_HEADER_LINES } from '@openmap/constants';

export interface Finding {
  rule: string;
  file: string;
  line: number;
  message: string;
}

export interface FileInput {
  /** Repo-relative path with forward slashes. */
  path: string;
  text: string;
}

export const TEST_PATH = /(\/__tests__\/|\.test\.[a-z]+$|\.spec\.[a-z]+$|_test\.go$|\/fixtures\/)/;
function isConfigBoundary(path: string): boolean {
  return GUARD_CONFIG_BOUNDARIES.some((prefix) => path.startsWith(prefix));
}
const CONSTANTS_PKG = /^packages\/constants\//;
const I18N_LOCALES = /^packages\/i18n\/locales\//;
const CONSOLE_APP = /^apps\/console\/.*\.tsx$/;
const APPS = /^apps\//;
const SOURCE = /\.(ts|tsx|go|py|js|mjs)$/;

export function isSourceFile(path: string): boolean {
  return SOURCE.test(path) && !TEST_PATH.test(path);
}

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

const forbiddenRegex = new RegExp('\\b(' + GUARD_FORBIDDEN_TOKENS.map((t) => t.replace(/\s+/g, '\\s+')).join('|') + ')\\b', 'i');

export function forbiddenTokens(file: FileInput): Finding[] {
  if (CONSTANTS_PKG.test(file.path) && file.path.endsWith('index.ts')) return [];
  if (I18N_LOCALES.test(file.path)) return [];
  const out: Finding[] = [];
  lines(file.text).forEach((l, i) => {
    const m = forbiddenRegex.exec(l);
    if (m) out.push({ rule: 'forbidden-token', file: file.path, line: i + 1, message: 'forbidden token "' + (m[1] ?? '') + '"' });
  });
  return out;
}

const ANY_PATTERNS: Array<[RegExp, string]> = [
  [/:\s*any\b/, '": any"'],
  [/\bas\s+any\b/, '"as any"'],
  [/@ts-ignore/, '@ts-ignore'],
  [/@ts-expect-error(?!.*ADR-\d{3})/, '@ts-expect-error without an ADR reference'],
  [/eslint-disable(?!.*ADR-\d{3})/, 'eslint-disable without an ADR reference'],
];

export function unsafeTypes(file: FileInput): Finding[] {
  if (!/\.(ts|tsx)$/.test(file.path)) return [];
  const out: Finding[] = [];
  lines(file.text).forEach((l, i) => {
    for (const [re, label] of ANY_PATTERNS) if (re.test(l)) out.push({ rule: 'unsafe-type', file: file.path, line: i + 1, message: label });
  });
  return out;
}

/** A dotted quad not embedded in a longer dotted sequence (SNMP OIDs and version strings are not addresses). */
const IPV4 = /(?<![\w.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\w.])/g;
const ALLOWED_IPV4 = new Set<string>(GUARD_ALLOWED_IPV4);

function hasForeignIpv4(line: string): boolean {
  for (const m of line.matchAll(IPV4)) if (!ALLOWED_IPV4.has(m[0])) return true;
  return false;
}
const URL = /\bhttps?:\/\/[^\s'"`)]+/;
const PORT_ASSIGN = /\b(port|PORT)\s*[:=]\s*\d{2,5}\b/;
const SECRET = /\b(password|secret|token|apikey|api_key)\s*[:=]\s*['"][^'"]{4,}['"]/i;
const ABS_PATH = /(['"`])(\/(etc|usr|var|opt|home)\/[^'"`]*|[A-Z]:\\[^'"`]*)\1/;

export function literals(file: FileInput): Finding[] {
  if (isConfigBoundary(file.path)) return [];
  const out: Finding[] = [];
  lines(file.text).forEach((l, i) => {
    if (l.trim().startsWith('//') || l.trim().startsWith('*') || l.trim().startsWith('#')) return;
    if (hasForeignIpv4(l)) out.push({ rule: 'literal', file: file.path, line: i + 1, message: 'literal IPv4 address' });
    if (URL.test(l) && !/schema\.org|w3\.org|json-schema\.org|openmap\.dev\/contracts/.test(l)) out.push({ rule: 'literal', file: file.path, line: i + 1, message: 'literal URL' });
    if (PORT_ASSIGN.test(l)) out.push({ rule: 'literal', file: file.path, line: i + 1, message: 'literal port' });
    if (SECRET.test(l)) out.push({ rule: 'literal', file: file.path, line: i + 1, message: 'literal credential' });
    if (ABS_PATH.test(l)) out.push({ rule: 'literal', file: file.path, line: i + 1, message: 'literal file path' });
  });
  return out;
}

const NUMBER = /(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g;

export function magicNumbers(file: FileInput): Finding[] {
  if (!APPS.test(file.path) || !/\.(ts|tsx)$/.test(file.path)) return [];
  const allowed = new Set<number>(GUARD_ALLOWED_NUMERIC_LITERALS);
  const out: Finding[] = [];
  lines(file.text).forEach((l, i) => {
    const code = l.replace(/\/\/.*$/, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    if (/^\s*(\*|\/\*)/.test(code)) return;
    if (/\bimport\b/.test(code)) return;
    for (const m of code.matchAll(NUMBER)) {
      const n = Number(m[0]);
      if (!allowed.has(n)) out.push({ rule: 'magic-number', file: file.path, line: i + 1, message: 'numeric literal ' + m[0] + ' (move to @openmap/constants or config)' });
    }
  });
  return out;
}

const JSX_TEXT = />\s*([A-Za-z][^<>{}]{2,})\s*</;
const JSX_ATTR_TEXT = /\b(placeholder|title|aria-label|alt|label)=["']([A-Za-z][^"']{2,})["']/;

export function userFacingStrings(file: FileInput): Finding[] {
  if (!CONSOLE_APP.test(file.path)) return [];
  const out: Finding[] = [];
  lines(file.text).forEach((l, i) => {
    const t = JSX_TEXT.exec(l);
    if (t && !/\{t\(/.test(l) && !/^[\d\s.,:%/-]+$/.test(t[1] ?? '')) out.push({ rule: 'user-facing-string', file: file.path, line: i + 1, message: 'JSX text "' + (t[1] ?? '').trim() + '" must use t(key)' });
    const a = JSX_ATTR_TEXT.exec(l);
    if (a) out.push({ rule: 'user-facing-string', file: file.path, line: i + 1, message: a[1] + ' attribute must use t(key)' });
  });
  return out;
}

export function reqHeader(file: FileInput): Finding[] {
  if (!APPS.test(file.path)) return [];
  const head = lines(file.text).slice(0, GUARD_HEADER_LINES).join('\n');
  if (!/REQ-[A-Z]+-\d{3}/.test(head)) return [{ rule: 'req-header', file: file.path, line: 1, message: 'no REQ- id in the first ' + String(GUARD_HEADER_LINES) + ' lines' }];
  return [];
}

export const ALL_RULES = [forbiddenTokens, unsafeTypes, literals, magicNumbers, userFacingStrings, reqHeader];

export function runRules(file: FileInput): Finding[] {
  if (!isSourceFile(file.path)) return [];
  return ALL_RULES.flatMap((rule) => rule(file));
}
