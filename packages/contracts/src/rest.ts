// REQ-CORE-019 (ADR-049) — the REST API's route table, the one source for the API's validation, the OpenAPI 3.1
// document and the SDK's types. Every route lives under /api/v1 and returns the contract's own shapes (ciSchema with
// custom fields, relationshipSchema). Version: CONTRACT_VERSIONS.rest.
import { z } from 'zod';
import { ciLayerSchema, ciSchema, ciTypeSchema, healthStateSchema, lifecycleSchema, relationshipSchema, relationshipTypeSchema } from './ci.js';
import { PREDICTED_STATES } from './impact.js';
import { READINESS_RULES, SITE_DR_ROLES } from './connectivity.js';

export const REST_BASE_PATH = '/api/v1';
/** Largest page a list route returns; the API clamps `first` to it, as GraphQL does. */
export const REST_MAX_PAGE = 500;

/** A comma-separated query list, as `?types=host,vm`. */
function list<T extends z.ZodType<string>>(item: T) {
  return z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return undefined;
      const out: Array<z.output<T>> = [];
      for (const raw of v.split(',')) {
        const parsed = item.safeParse(raw.trim());
        if (!parsed.success) {
          ctx.addIssue({ code: 'custom', message: 'unknown value ' + raw.trim() });
          return z.NEVER;
        }
        out.push(parsed.data);
      }
      return out;
    });
}

const uuidParam = z.object({ id: z.uuid() });
const pageQuery = {
  first: z.coerce.number().int().min(1).max(REST_MAX_PAGE).optional(),
  after: z.string().min(1).optional(),
};

export const restCiSchema = ciSchema.extend({
  customFields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  observedAt: z.iso.datetime(),
});
export type RestCi = z.infer<typeof restCiSchema>;

export const restPageInfoSchema = z.object({ endCursor: z.string().nullable(), hasNextPage: z.boolean() });

export const restErrorSchema = z.object({ statusCode: z.number().int(), error: z.string(), message: z.string() });

export const restImpactSchema = z.object({
  root: restCiSchema,
  nodes: z.array(z.object({ ci: restCiSchema, depth: z.number().int(), predicted: z.enum(PREDICTED_STATES), path: z.array(z.uuid()) })),
  services: z.array(z.object({ service: restCiSchema, tier: z.number().int(), predicted: z.enum(PREDICTED_STATES), path: z.array(z.uuid()) })),
  durationMs: z.number().int(),
});

export const restIncidentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  severity: z.enum(['informational', 'low', 'medium', 'high', 'critical']),
  state: z.enum(['open', 'acknowledged', 'mitigated', 'resolved', 'closed']),
  source: z.string(),
  serviceCiId: z.uuid().nullable(),
  affectedServiceCiIds: z.array(z.uuid()),
  rootCauseCiId: z.uuid().nullable(),
  openedAt: z.iso.datetime(),
  acknowledgedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  assignee: z.string().nullable(),
});

export const restConnectivitySchema = z.object({
  sites: z.array(z.object({ ciId: z.uuid(), name: z.string(), code: z.string(), drRole: z.enum(SITE_DR_ROLES), criticality: z.number().int().nullable(), healthyPaths: z.number().int() })),
  links: z.array(
    z.object({
      ciId: z.uuid(),
      name: z.string(),
      fromSite: z.string().nullable(),
      toSite: z.string().nullable(),
      replication: z.boolean(),
      probeTarget: z.string().nullable(),
      reachable: z.boolean().nullable(),
      latencyMs: z.number().nullable(),
      lossPercent: z.number().nullable(),
      probedAt: z.iso.datetime().nullable(),
    }),
  ),
  findings: z.array(z.object({ id: z.uuid(), rule: z.enum(READINESS_RULES), subjectCiId: z.uuid(), detail: z.string(), state: z.enum(['open', 'cleared']), openedAt: z.iso.datetime(), clearedAt: z.iso.datetime().nullable(), incidentId: z.uuid().nullable() })),
});

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RestRoute {
  method: HttpMethod;
  /** Path below REST_BASE_PATH with `{name}` parameters, as OpenAPI writes them. */
  path: string;
  summary: string;
  /** Writes need the operator role; reads any signed-in role. */
  write: boolean;
  params: z.ZodObject | null;
  query: z.ZodObject | null;
  body: z.ZodType | null;
  response: z.ZodType;
  /** Status of a successful call. */
  status: number;
}

function route<R extends RestRoute>(r: R): R {
  return r;
}

export const REST_ROUTES = {
  listCis: route({
    method: 'GET',
    path: '/cis',
    summary: 'List current CIs, filtered like the CMDB screen, one cursor page at a time.',
    write: false,
    params: null,
    query: z.object({
      types: list(ciTypeSchema),
      layers: list(ciLayerSchema),
      lifecycle: list(lifecycleSchema),
      health: list(healthStateSchema),
      tags: list(z.string().min(1)),
      text: z.string().min(1).optional(),
      ...pageQuery,
    }),
    body: null,
    response: z.object({ items: z.array(restCiSchema), pageInfo: restPageInfoSchema, totalCount: z.number().int() }),
    status: 200,
  }),
  getCi: route({ method: 'GET', path: '/cis/{id}', summary: 'One CI by id.', write: false, params: uuidParam, query: z.object({ asOf: z.iso.datetime().optional() }), body: null, response: restCiSchema, status: 200 }),
  patchCiAttributes: route({
    method: 'PATCH',
    path: '/cis/{id}/attributes',
    summary: "Set attributes on a CI as a person's edit (user-label confidence); keys absent from the body are kept.",
    write: true,
    params: uuidParam,
    query: null,
    body: z.object({ attributes: z.record(z.string().min(1), z.unknown()) }),
    response: restCiSchema,
    status: 200,
  }),
  listCiRelationships: route({
    method: 'GET',
    path: '/cis/{id}/relationships',
    summary: "A CI's current relationships: downstream (what it depends on), upstream (what depends on it) or both.",
    write: false,
    params: uuidParam,
    query: z.object({ direction: z.enum(['upstream', 'downstream', 'both']).optional(), types: list(relationshipTypeSchema), ...pageQuery }),
    body: null,
    response: z.object({ items: z.array(relationshipSchema), pageInfo: restPageInfoSchema, totalCount: z.number().int() }),
    status: 200,
  }),
  getCiImpact: route({
    method: 'GET',
    path: '/cis/{id}/impact',
    summary: 'What a failure of the CI would reach (upstream) or what it depends on (downstream), with the business services.',
    write: false,
    params: uuidParam,
    query: z.object({ direction: z.enum(['upstream', 'downstream']).optional(), maxDepth: z.coerce.number().int().min(0).optional() }),
    body: null,
    response: restImpactSchema,
    status: 200,
  }),
  createRelationship: route({
    method: 'POST',
    path: '/relationships',
    summary: "Create a relationship as a person's edit.",
    write: true,
    params: null,
    query: null,
    body: z.object({ type: relationshipTypeSchema, fromCiId: z.uuid(), toCiId: z.uuid(), attributes: z.record(z.string().min(1), z.unknown()).optional() }),
    response: relationshipSchema,
    status: 201,
  }),
  retireRelationship: route({ method: 'DELETE', path: '/relationships/{id}', summary: 'Retire a relationship (it stays in history with validTo set).', write: true, params: uuidParam, query: null, body: null, response: relationshipSchema, status: 200 }),
  search: route({
    method: 'GET',
    path: '/search',
    summary: 'Full-text search over CIs (names, codes, identity values, attributes).',
    write: false,
    params: null,
    query: z.object({ q: z.string().min(1), layers: list(ciLayerSchema), first: z.coerce.number().int().min(1).max(REST_MAX_PAGE).optional() }),
    body: null,
    response: z.array(z.object({ ci: restCiSchema, score: z.number(), highlight: z.string().nullable() })),
    status: 200,
  }),
  listIncidents: route({
    method: 'GET',
    path: '/incidents',
    summary: 'Incidents of business services, open ones by default.',
    write: false,
    params: null,
    query: z.object({ open: z.enum(['true', 'false']).optional(), serviceId: z.uuid().optional() }),
    body: null,
    response: z.array(restIncidentSchema),
    status: 200,
  }),
  getConnectivity: route({ method: 'GET', path: '/connectivity', summary: 'Sites, inter-site links with their latest probes, and the HA / DR readiness findings.', write: false, params: null, query: null, body: null, response: restConnectivitySchema, status: 200 }),
} as const;

export type RestRouteId = keyof typeof REST_ROUTES;

/** `/cis/{id}` with `{ id }` → `/cis/…`, each parameter URI-encoded. */
export function restPath(path: string, params: Readonly<Record<string, string>>): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(params[name] ?? ''));
}

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Record<string, unknown>;
  delete out['$schema'];
  return out;
}

/** The OpenAPI 3.1 document of every route in the table. */
export function openApiDocument(version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [id, r] of Object.entries(REST_ROUTES) as Array<[RestRouteId, RestRoute]>) {
    const parameters: Array<Record<string, unknown>> = [];
    for (const [where, schema] of [['path', r.params], ['query', r.query]] as const) {
      if (schema === null) continue;
      const shape = schema.shape as Record<string, z.ZodType>;
      for (const [name, field] of Object.entries(shape)) {
        parameters.push({ name, in: where, required: where === 'path' || !field.safeParse(undefined).success, schema: jsonSchema(field, 'input') });
      }
    }
    const operation: Record<string, unknown> = {
      operationId: id,
      summary: r.summary,
      tags: [r.path.split('/')[1] ?? 'api'],
      parameters,
      responses: {
        [String(r.status)]: { description: 'OK', content: { 'application/json': { schema: jsonSchema(r.response, 'output') } } },
        default: { description: 'Error', content: { 'application/json': { schema: jsonSchema(restErrorSchema, 'output') } } },
      },
      security: [{ bearer: [] }],
      'x-openmap-write': r.write,
    };
    if (r.body !== null) operation['requestBody'] = { required: true, content: { 'application/json': { schema: jsonSchema(r.body, 'input') } } };
    const p = REST_BASE_PATH + r.path;
    paths[p] = { ...(paths[p] ?? {}), [r.method.toLowerCase()]: operation };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'OpenMap REST API', version, description: 'The REST face of OpenMap (ADR-049). GraphQL at /graphql covers everything else.' },
    paths,
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  };
}
