# ADR-049 — REST API, OpenAPI document and SDK from one route table

Status: Accepted (REQ-CORE-019, 2026-11-08) · Date: 2026-11-08 · Tracker: REQ-CORE-019

## Context

REQ-CORE-019 (docs/CAPABILITY-MAP.md §8): "REST and GraphQL API, SDKs, OpenAPI", at parity with Device42's REST API.

- The API served GraphQL (Mercurius) for everything.
- REST existed only for the CMDB export (`GET /export/cis`, ADR-032) and the health probes.
- There was no OpenAPI document and no client library.

Device42 users script against REST: list and fetch CIs, change attributes, add and remove relationships, ask what an
outage would touch. Integrations generate clients from an OpenAPI document. The GraphQL schema stays the contract for
the console and for anything that wants a graph-shaped query.

## Decision

1. **One route table is the source** (`packages/contracts/src/rest.ts`, `REST_ROUTES`). Each route names:
   - its method and path under `/api/v1`, a summary and whether it writes;
   - zod schemas for path parameters, query, body and response.

   The table drives three consumers, so they cannot drift:
   - the API's controllers validate against it;
   - `openApiDocument()` emits OpenAPI 3.1 from it (JSON Schema 2020-12, as the contract's other JSON Schemas);
   - the SDK types its calls from it.
2. **REST v1** (`apps/api/src/rest`) is a thin layer over the services GraphQL uses. It holds no logic of its own.
   - **Routes:**
     - CIs: list with the CMDB filter and cursor pages, fetch one, patch attributes;
     - a CI's relationships and its impact (upstream or downstream, with affected services);
     - create and retire a relationship;
     - search;
     - incidents;
     - sites and connectivity (ADR-025).
   - **Auth:**
     - The same Keycloak bearer token as GraphQL, with the tenant from the token.
     - Writes need the operator role, reads any signed-in role, through the global guards.
     - Errors are `{ statusCode, error, message }`.
   - **Discovery:**
     - `GET /api/v1/openapi.json` is public, so tools can discover the API before they authenticate.
     - The document is also written to `packages/contracts/openapi/openapi.json` at build. Its `info.version` is the
       REST contract version (`CONTRACT_VERSIONS.rest`, 1.0.0), recorded in docs/CONTRACTS.md and the tracker.
   - **Observability:**
     - `openmap_rest_requests_total{route,status}` and `openmap_rest_request_duration_seconds{route}` count and time
       every call.
     - Each call runs in a `rest.<routeId>` span.
3. **SDK** (`packages/sdk`, `@openmap/sdk`).
   - A TypeScript client whose methods are the routes, typed from the table: `client.cis.list(query)`,
     `client.cis.get(id)`, …
   - It also has `client.graphql(query, variables)` for anything REST does not cover.
   - It takes a token or a token provider (the automation client's credentials grant, ADR-017) and runs on Node and in
     browsers (fetch).
   - SDKs for other languages are generated from the OpenAPI document with standard generators. The document is the
     contract, and nothing is hand-copied.
4. **Console:** Settings gains an API card with these parts. It is in en and ar.
   - the base URLs (REST, OpenAPI, GraphQL);
   - every REST route from the live document, with its method, path and summary;
   - how a script obtains a token.

## Consequences

- **Adding a REST route** means a table entry, a controller method and a minor REST contract bump (an addition) or a
  major one (a change). The OpenAPI file in the repository shows the diff.
- **Data shapes:** REST returns the contract's own shapes (`ciSchema` with custom fields, `relationshipSchema`), the
  same data the GraphQL types expose.
- **Pages:** list routes use the same cursor pages as GraphQL (`first`, `after`, `pageInfo`), so a script reads 100k
  CIs page by page.
