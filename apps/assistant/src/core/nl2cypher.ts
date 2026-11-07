// REQ-AI-001 — question → validated read-only Cypher → rows → answer. The generated Cypher is always
// shown to the user and validated before it reaches the engine; writes are impossible by construction.
// Tenant isolation is not left to the model either: every node variable the query binds is scoped to
// $tenantId here, deterministically, before the engine sees the query.
import { ASSISTANT } from '@openmap/constants';
import { CI_TYPES, HEALTH_STATES, RELATIONSHIP_TYPES } from '@openmap/contracts';
import { assertReadOnly, typeLabel, type GraphRepository } from '@openmap/graph';
import type { ChatMessage, LlmClient } from './llm.js';
import { KNOWN_DIRECTIONS, NODE_PROPERTIES, systemPrompt } from './grounding.js';

export interface AssistantAnswer {
  question: string;
  cypher: string;
  rows: Array<Record<string, unknown>>;
  text: string;
  truncated: boolean;
}

export class AssistantError extends Error {
  constructor(message: string, public readonly cypher: string | null) {
    super(message);
    this.name = 'AssistantError';
  }
}

/** Strips code fences and trailing prose the model may add despite instructions. */
export function extractCypher(text: string): string {
  const fenced = /```(?:cypher)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text) ?? '';
  const firstKeyword = body.search(/\b(MATCH|OPTIONAL MATCH|WITH|UNWIND|RETURN|CALL)\b/i);
  const cut = firstKeyword >= 0 ? body.slice(firstKeyword) : body;
  return cut.trim().replace(/;\s*$/, '');
}

/** Replaces the contents of quoted strings with spaces so keyword and variable scans ignore them; offsets are kept. */
export function maskStrings(cypher: string): string {
  return cypher.replace(/(['"])((?:(?!\1)[^\\]|\\.)*)\1/g, (_match, quote: string, body: string) => quote + ' '.repeat(body.length) + quote);
}

const CLAUSE_KEYWORD = /\b(OPTIONAL\s+MATCH|MATCH|WITH|UNWIND|RETURN|CALL|WHERE|ORDER\s+BY|SKIP|LIMIT|UNION)\b/gi;
/** A node pattern opening `(alias` that is not a function call or a parenthesised expression. */
const NODE_VARIABLE = /(?<![\w\])])\(\s*([A-Za-z_]\w*)\s*(?=[:{)])/g;
/** A relationship pattern opening `[alias` with a type, length, map or closing bracket next. */
const RELATIONSHIP_VARIABLE = /\[\s*([A-Za-z_]\w*)\s*(?=[:*{\]])/g;
const ALIAS = /\bAS\s+([A-Za-z_]\w*)/gi;
/** `alias.property` where alias is neither a parameter nor itself a property. */
const PROPERTY_ACCESS = /(?<![\w$.])([A-Za-z_]\w*)\s*\.\s*[A-Za-z_]/g;

interface Clause {
  keyword: string;
  start: number;
  /** Offset of the first character after the keyword. */
  bodyStart: number;
  end: number;
}

function clauses(masked: string): Clause[] {
  const out: Clause[] = [];
  for (const m of masked.matchAll(CLAUSE_KEYWORD)) {
    const start = m.index;
    out.push({ keyword: (m[1] ?? '').replace(/\s+/g, ' ').toUpperCase(), start, bodyStart: start + m[0].length, end: masked.length });
  }
  for (let i = 0; i + 1 < out.length; i++) (out[i] as Clause).end = (out[i + 1] as Clause).start;
  return out;
}

function names(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) => m[1] ?? '').filter((n) => n.length > 0);
}

/** Variables the query introduces: node and relationship aliases in patterns, plus `AS` aliases. */
export function boundVariables(cypher: string): Set<string> {
  const masked = maskStrings(cypher);
  return new Set([...names(masked, NODE_VARIABLE), ...names(masked, RELATIONSHIP_VARIABLE), ...names(masked, ALIAS)]);
}

/** Variables the query dereferences with `.property`. */
export function referencedVariables(cypher: string): Set<string> {
  return new Set(names(maskStrings(cypher), PROPERTY_ACCESS));
}

/** Node variables bound in MATCH clauses, in order of first appearance, with the clause that binds each. */
function matchedNodeVariables(masked: string, all: Clause[] = clauses(masked)): Array<{ alias: string; clause: Clause }> {
  const out: Array<{ alias: string; clause: Clause }> = [];
  const seen = new Set<string>();
  for (const clause of all) {
    if (clause.keyword !== 'MATCH' && clause.keyword !== 'OPTIONAL MATCH') continue;
    for (const alias of names(masked.slice(clause.bodyStart, clause.end), NODE_VARIABLE)) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      out.push({ alias, clause });
    }
  }
  return out;
}

function isTenantScoped(masked: string, alias: string): boolean {
  return new RegExp('\\b' + alias + '\\s*\\.\\s*tenantId\\s*=\\s*\\$tenantId\\b').test(masked);
}

/**
 * Adds `alias.tenantId = $tenantId` (and `alias.validTo IS NULL` unless the query already reasons about
 * validity) for every node variable a MATCH binds without scoping it, so the model can only ever narrow a
 * tenant's view, never widen it. Scopes join an existing WHERE of the same clause or open a new one.
 */
export function scopeToTenant(cypher: string): string {
  const masked = maskStrings(cypher);
  const temporal = /\bvalidTo\b|\bvalidFrom\b|\$now\b/.test(masked);
  const all = clauses(masked);
  const pending = new Map<Clause, string[]>();
  for (const { alias, clause } of matchedNodeVariables(masked, all)) {
    if (isTenantScoped(masked, alias)) continue;
    const predicates = [alias + '.tenantId = $tenantId'];
    if (!temporal) predicates.push(alias + '.validTo IS NULL');
    pending.set(clause, [...(pending.get(clause) ?? []), ...predicates]);
  }
  if (pending.size === 0) return cypher;
  // Apply from the end so earlier offsets stay valid.
  const edits = [...pending.entries()].sort((a, b) => b[0].start - a[0].start);
  let out = cypher;
  for (const [clause, predicates] of edits) {
    const index = all.indexOf(clause);
    const next = all[index + 1];
    const scope = predicates.join(' AND ');
    if (next !== undefined && next.keyword === 'WHERE') {
      out = out.slice(0, next.bodyStart) + ' ' + scope + ' AND' + out.slice(next.bodyStart);
    } else {
      const patternEnd = clause.end;
      const pattern = out.slice(clause.bodyStart, patternEnd);
      const trimmedEnd = clause.bodyStart + pattern.trimEnd().length;
      out = out.slice(0, trimmedEnd) + ' WHERE ' + scope + out.slice(trimmedEnd);
    }
  }
  return out;
}

const KNOWN_LABELS: ReadonlySet<string> = new Set<string>(['Ci', ...CI_TYPES.map((t) => typeLabel(t))]);
const KNOWN_RELATIONSHIPS: ReadonlySet<string> = new Set<string>(RELATIONSHIP_TYPES.map((r) => r.toUpperCase()));
const KNOWN_PROPERTIES: ReadonlySet<string> = new Set<string>(NODE_PROPERTIES);
/** `(alias:Label:Label {map})` — the alias, the label list and the property map of a node pattern. */
const NODE_PATTERN = /(?<![\w\])])\(\s*([A-Za-z_]\w*)?\s*((?::\s*[A-Za-z_]\w*)*)\s*(\{[^}]*\})?\s*\)/g;
/** `[alias:TYPE|TYPE*1..3 {map}]` — the type list of a relationship pattern. */
const RELATIONSHIP_PATTERN = /\[\s*[A-Za-z_]?\w*\s*:\s*([A-Za-z_][\w|!\s]*?)\s*(?:\*[\d.]*)?\s*(?:\{[^}]*\})?\s*\]/g;
/** One hop with a single type between two labelled nodes, either direction. */
const DIRECTED_HOP = /\(\s*[A-Za-z_]?\w*\s*:\s*([A-Za-z_]\w*)[^()]*\)\s*(<-|-)\s*\[\s*[A-Za-z_]?\w*\s*:\s*([A-Za-z_]\w*)\s*\]\s*(->|-)\s*\(\s*[A-Za-z_]?\w*\s*:\s*([A-Za-z_]\w*)/g;
const MAP_KEY = /(?:\{|,)\s*([A-Za-z_]\w*)\s*:/g;

function labelsOf(list: string): string[] {
  return list.split(':').map((l) => l.trim()).filter((l) => l.length > 0);
}

function propertyAfter(masked: string, offset: number): string {
  return /^\s*\.\s*([A-Za-z_]\w*)/.exec(masked.slice(offset))?.[1] ?? '';
}

interface HopFix {
  rel: string;
  /** True when the hop must read left-to-right after the fix. */
  leftToRight: boolean;
}

/**
 * How a single-type hop between two known labels should read, or null when the hop is fine or the catalogue
 * cannot decide (the labels are unrelated, or several types link them).
 */
function hopFix(left: string, leftArrow: string, rel: string, rightArrow: string, right: string): HopFix | null {
  if (left === 'Ci' || right === 'Ci') return null;
  const leftToRight = leftArrow === '-' && rightArrow === '->';
  const rightToLeft = leftArrow === '<-' && rightArrow === '-';
  if (!leftToRight && !rightToLeft) return null;
  const linking = KNOWN_DIRECTIONS.filter(([f, , t]) => (f === left && t === right) || (f === right && t === left));
  if (linking.length === 0) return null;
  const sameType = linking.filter(([, r]) => r === rel);
  if (sameType.length > 0) {
    const forwards = sameType.some(([f]) => f === left) && leftToRight;
    const backwards = sameType.some(([f]) => f === right) && rightToLeft;
    return forwards || backwards ? null : { rel, leftToRight: sameType.some(([f]) => f === left) };
  }
  const types = [...new Set(linking.map(([, r]) => r))];
  const [entry] = linking;
  if (types.length !== 1 || entry === undefined) return null;
  return { rel: entry[1], leftToRight: entry[0] === left };
}

/**
 * Rewrites single-type hops between two labels the catalogue links so they read as the graph stores them: a
 * reversed PART_OF_SERVICE is turned around, HOSTED_ON between a Vm and a Hypervisor becomes RUNS_ON. The model's
 * output is only ever corrected towards the schema, never towards a different question, and the user sees the
 * corrected query.
 */
export function normaliseHops(cypher: string): string {
  const masked = maskStrings(cypher);
  const indexed = new RegExp(DIRECTED_HOP.source, 'gd');
  let out = cypher;
  for (const m of [...masked.matchAll(indexed)].reverse()) {
    const [, left = '', leftArrow = '', rel = '', rightArrow = '', right = ''] = m;
    const fix = hopFix(left, leftArrow, rel, rightArrow, right);
    const spans = m.indices;
    if (fix === null || spans === undefined) continue;
    const [, , la, type, ra] = spans;
    if (la === undefined || type === undefined || ra === undefined) continue;
    // Right-to-left offsets so each splice leaves the earlier ones valid.
    out = out.slice(0, ra[0]) + (fix.leftToRight ? '->' : '-') + out.slice(ra[1]);
    out = out.slice(0, type[0]) + fix.rel + out.slice(type[1]);
    out = out.slice(0, la[0]) + (fix.leftToRight ? '-' : '<-') + out.slice(la[1]);
  }
  return out;
}

/** Rejects labels, relationship types, properties and hop directions the contract graph does not have. */
export function checkSchema(cypher: string): void {
  const masked = maskStrings(cypher);
  const nodeAliases = new Set<string>();
  const properties = [...KNOWN_PROPERTIES].join(', ');
  for (const m of masked.matchAll(NODE_PATTERN)) {
    if (m[1] !== undefined) nodeAliases.add(m[1]);
    const [, , labelList = '', propertyMap = ''] = m;
    for (const label of labelsOf(labelList)) {
      if (!KNOWN_LABELS.has(label)) throw new AssistantError('label ' + label + ' does not exist; node labels are ' + [...KNOWN_LABELS].join(', '), cypher);
    }
    for (const key of names(propertyMap, MAP_KEY)) {
      if (!KNOWN_PROPERTIES.has(key)) throw new AssistantError('property ' + key + ' does not exist on nodes; node properties are ' + properties, cypher);
    }
  }
  for (const m of masked.matchAll(RELATIONSHIP_PATTERN)) {
    for (const type of (m[1] ?? '').split('|').map((t) => t.replace(/^!/, '').trim()).filter((t) => t.length > 0)) {
      if (!KNOWN_RELATIONSHIPS.has(type)) throw new AssistantError('relationship type ' + type + ' does not exist; relationship types are ' + [...KNOWN_RELATIONSHIPS].join(', '), cypher);
    }
  }
  const shadowed = new Set<string>([...names(masked, ALIAS), ...names(masked, RELATIONSHIP_VARIABLE)]);
  for (const m of masked.matchAll(PROPERTY_ACCESS)) {
    const alias = m[1] ?? '';
    if (!nodeAliases.has(alias) || shadowed.has(alias)) continue;
    const property = propertyAfter(masked, m.index + alias.length);
    if (!KNOWN_PROPERTIES.has(property)) throw new AssistantError('property ' + property + ' does not exist on nodes; node properties are ' + properties + '. Measurements such as utilisation or power are not in the graph', cypher);
  }
  for (const m of masked.matchAll(DIRECTED_HOP)) {
    const [, left = '', leftArrow = '', rel = '', rightArrow = '', right = ''] = m;
    if (left === 'Ci' || right === 'Ci') continue;
    const hop: [string, string] | null = leftArrow === '<-' && rightArrow === '-' ? [right, left] : leftArrow === '-' && rightArrow === '->' ? [left, right] : null;
    if (hop === null) continue;
    const [from, to] = hop;
    const forwards = KNOWN_DIRECTIONS.some(([f, r, t]) => f === from && r === rel && t === to);
    const backwards = KNOWN_DIRECTIONS.some(([f, r, t]) => f === to && r === rel && t === from);
    if (!forwards && backwards) throw new AssistantError(rel + ' goes from ' + to + ' to ' + from + ', not the reverse: write (' + to + ')-[:' + rel + ']->(' + from + ')', cypher);
    const fix = hopFix(left, leftArrow, rel, rightArrow, right);
    if (fix !== null && fix.rel !== rel) throw new AssistantError(left + ' and ' + right + ' are linked by ' + fix.rel + ', not ' + rel, cypher);
  }
}

/** Parameters `ask` passes to the engine; the grounding prompt names exactly these. */
export const ALLOWED_PARAMETERS: ReadonlySet<string> = new Set(['tenantId', 'now']);

const HEALTH_LITERAL = /\bhealth\s*(?:=|<>|:)\s*(['"])([^'"]*)\1/gi;

export function validateCypher(cypher: string): void {
  if (cypher.length === 0) throw new AssistantError('the model returned no query', null);
  if (cypher.length > ASSISTANT.maxCypherLength) throw new AssistantError('generated query is too long', cypher);
  assertReadOnly(cypher);
  if (!/\bRETURN\b/i.test(cypher)) throw new AssistantError('generated query returns nothing', cypher);
  // Only the parameters the engine is given may appear; an invented one would fail at run time with a worse message.
  const unknown = [...cypher.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] ?? '').filter((name) => !ALLOWED_PARAMETERS.has(name));
  if (unknown.length > 0) throw new AssistantError('generated query uses unknown parameter $' + String(unknown[0]) + '; only $tenantId and $now exist, write literal values inline', cypher);
  const bound = boundVariables(cypher);
  const unbound = [...referencedVariables(cypher)].filter((v) => !bound.has(v));
  if (unbound.length > 0) {
    const have = bound.size > 0 ? '; the query binds ' + [...bound].join(', ') : '; the query binds no variables';
    throw new AssistantError('variable ' + String(unbound[0]) + ' is used but never introduced in a MATCH pattern' + have, cypher);
  }
  const masked = maskStrings(cypher);
  const unscoped = matchedNodeVariables(masked).filter(({ alias }) => !isTenantScoped(masked, alias));
  if (unscoped.length > 0) throw new AssistantError('node variable ' + String(unscoped[0]?.alias) + ' is not filtered by tenantId = $tenantId', cypher);
  if (!/\$tenantId/.test(cypher)) throw new AssistantError('generated query does not scope by tenant', cypher);
  checkSchema(cypher);
  const values: ReadonlySet<string> = new Set<string>(HEALTH_STATES);
  for (const m of cypher.matchAll(HEALTH_LITERAL)) {
    const [, , value = ''] = m;
    if (!values.has(value)) throw new AssistantError("'" + value + "' is not a health value; health is one of " + HEALTH_STATES.join(', '), cypher);
  }
}

/** Adds a LIMIT when the model forgot one, so a broad question cannot flood the console. */
export function enforceLimit(cypher: string): string {
  if (/\bLIMIT\s+\d+\s*$/i.test(cypher) || /\bcount\s*\(/i.test(cypher)) return cypher;
  return cypher + '\nLIMIT ' + String(ASSISTANT.maxRowsReturned);
}

/** Everything that happens to the model's text before the engine: extraction, tenant scoping, a LIMIT. */
export function prepareCypher(text: string): string {
  return enforceLimit(scopeToTenant(normaliseHops(extractCypher(text))));
}

function summarise(question: string, rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return 'No matching items were found for: ' + question;
  const first = rows[0] ?? {};
  const columns = Object.keys(first);
  const names = rows.map((r) => r['name'] ?? r['s.name'] ?? r['c.name']).filter((v): v is string => typeof v === 'string');
  const shown = names.slice(0, ASSISTANT.summaryNames);
  const more = names.length - shown.length;
  if (names.length > 0) return String(rows.length) + ' result' + (rows.length === 1 ? '' : 's') + ': ' + shown.join(', ') + (more > 0 ? ' and ' + String(more) + ' more' : '') + '.';
  return String(rows.length) + ' row' + (rows.length === 1 ? '' : 's') + ' with columns ' + columns.join(', ') + '.';
}

const REPAIR_RULES = 'Rewrite it following the rules: read-only; every variable introduced in a MATCH pattern of this query; every node variable filtered by its own tenantId = $tenantId; no parameters other than $tenantId and $now (write names and other values inline as quoted literals); aggregations only in WITH or RETURN; end with a RETURN clause. Reply with only the Cypher query.';

/**
 * Asks the model for a query, validates it and runs it. When the validator or the graph engine rejects the query,
 * the rejection goes back to the model as the next turn so it can repair its own output (an unbound variable,
 * an invented parameter, a write, a misplaced aggregation); small models need this, large ones rarely use it. The
 * last rejection is what the user sees when every attempt fails.
 */
export async function ask(question: string, tenantId: string, llm: LlmClient, repo: GraphRepository, now: () => string = () => new Date().toISOString()): Promise<AssistantAnswer> {
  if (question.trim().length === 0 || question.length > ASSISTANT.maxQuestionLength) throw new AssistantError('question is empty or too long', null);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: question },
  ];
  let lastError: AssistantError | null = null;
  for (let attempt = 0; attempt <= ASSISTANT.repairAttempts; attempt++) {
    const completion = await llm.complete(messages);
    const cypher = prepareCypher(completion.text);
    try {
      validateCypher(cypher);
      const rows = await repo.readOnly<Record<string, unknown>>(cypher, { tenantId, now: now() });
      const truncated = rows.length >= ASSISTANT.maxRowsReturned;
      return { question, cypher, rows, text: summarise(question, rows), truncated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = err instanceof AssistantError ? err : new AssistantError('the query failed to run: ' + message, cypher);
      messages.push({ role: 'assistant', content: completion.text });
      messages.push({ role: 'user', content: 'That query was rejected: ' + message + '. ' + REPAIR_RULES });
    }
  }
  throw lastError ?? new AssistantError('the model returned no query', null);
}
