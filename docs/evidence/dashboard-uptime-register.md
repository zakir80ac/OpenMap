# Overall uptime tile, register pagination, subscription cover (REQ-UI-036, REQ-CMDB-041, REQ-CMDB-042)

Captured 2026-11-05 on the dev compose stack with the synthetic estate (scale 0.05).

## What changed on screen

- **Dashboard.** A small `services.uptime` tile: the estate's availability this month (down minutes against observed
  minutes, weighted across every business service from the monthly availability report), the change against last
  month in percentage points, and how many services are below their target. It is first on the administrator and
  CTO/CIO templates; migration 0017 put it first on the dashboards already created from those templates.
- **Asset register.** Page numbers: "{n} rows · Page x of y" with first / previous / next / last; the page lives in the
  URL (`?page=2`) so a reload or the back button returns to the same rows; a filter change goes back to page 1; a
  failed page shows the error with a retry. `assetPage(filter, page, pageSize)` (GraphQL 1.2.0) returns the page
  with the total under the same filter; the old cursor query stays for other consumers.
- **Subscription cover.** A software, software instance, licence, SaaS application or tenant, cloud account or cloud
  resource carries a subscription (provider, plan, start, end, credits remaining with unit and currency, source)
  instead of a warranty (ADR-027): the first cover column reads "Warranty / subscription ends" and shows the credits
  under the date, the data-gap filter has "Missing subscription", the summary counts expired subscriptions, the
  details form shows the subscription group for those types (and never asks them for a warranty), and the manual
  entry follows the chosen type.

## Where the subscription data comes from

| Vendor | Term | Credits | How |
| --- | --- | --- | --- |
| Licences (software collectors, synthetic estate) | `expiresAt` → end, `subscriptionStart` → start | — | `subscriptionFromAttributes` in the reconciler's register sync and in migration 0018's backfill |
| Microsoft 365 (`internal/saas`) | `GET /v1.0/directory/subscriptions` joined to `subscribedSkus` by SKU id → `subscriptionStart` / `subscriptionEnd` per SaaS application | — | needs `Organization.Read.All`; a 403 leaves the term unknown (the gap) |
| Azure (`internal/azure`) | — | `billingProperties/default` → billing account → `Microsoft.Consumption/credits/balance` → `creditsRemaining`, `creditsCurrency`, `creditsAsOf` on the cloud account | credit-based accounts only; pay-as-you-go or no billing reader right yields nothing |
| Google Workspace, Salesforce, ServiceNow, Workday, AWS, GCP, OCI, Alibaba | — | — | no read API exposes a term or a balance; entered by hand on the asset, kept over later sweeps |

On the dev register after migration 0018: 26 licences carry a subscription (from their expiry and type); 3,143
software instances, software products and cloud rows show the subscription gap until a vendor reports a term. The
synthetic estate now emits terms on licences and a term plus a credit balance on both cloud accounts for the next
replay.

## Tests

| Test | What it proves | Result |
| --- | --- | --- |
| `DashboardView.test.tsx` (estate availability + tile) | weighted figure, unobserved time excluded, tile renders figure, change and services below target, en and ar | 9 passed |
| `AssetsView.test.tsx` (pager, subscription) | page numbers and totals, URL page, failed page error; SaaS row shows credits and saves term and credits through `updateAsset`; a software instance asks for a subscription, not a warranty | 19 passed |
| `apps/api/src/api.integration.test.ts` | `assetPage` totals, second page, beyond-the-end page, oversized page size refused; manual SaaS asset with subscription, gaps, summary, clearing, invalid input refused, labelling an unknown CI into a licence maps expiry and credits | 22 of 22 passed |
| `apps/collectors/internal/saas`, `internal/azure` | Graph `directory/subscriptions` joined to SKUs; Azure billing properties and credit balance on the account (protocol-shaped stand-ins) | ok |
| `packages/contracts`, `apps/reconciler` | `subscriptionFromAttributes`, gaps per type, register sync row | 14 / 6 passed |
| `apps/console/e2e/assets.spec.ts`, `dashboard.spec.ts` | the pager, the subscription save on a software row, the uptime tile on the administrator dashboard, screenshots in en and ar | 3 of 3 each (setup, en, ar) |

Guard ok; `contracts:check` GraphQL 1.3.0 additive; i18n in sync.

## Lighthouse and screenshots

Assets 0.97 / 1.0 / 1.0, Dashboard 0.99 / 1.0 / 1.0 (performance / accessibility / best practices), measured alone on
the CPU with the kind cluster stopped. `docs/evidence/console/dashboard-uptime-{en,ar}.png` (the tile first on the
administrator dashboard), `assets-register-{en,ar}.png` (the pager), `assets-subscription-{en,ar}.png` (the
subscription saved on a software row).
