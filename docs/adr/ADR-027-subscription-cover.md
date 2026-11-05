# ADR-027 — Software, SaaS and cloud assets carry a subscription (start, end, credits) instead of a warranty

Status: Accepted · Date: 2026-11-05 · Tracker: REQ-CMDB-042 · Contracts: asset 0.3.0, GraphQL 1.3.0

## Context

Syed's 2026-11-05 review: "If an asset is software / SaaS or Cloud Service, then it should be Subscription start,
Subscription end and credits remaining (need to see how we can pull that data)".

The register (ADR-023) gave every asset the same three dates: warranty, support, end of life. A licence, a SaaS tenant
or a cloud account has no warranty; what it has is a term and, on prepaid accounts, a balance. What the collectors
already observe today:

| Source | What is there | What is missing |
| --- | --- | --- |
| Licence CIs (software collectors, synthetic estate) | `expiresAt`, `licenceType`, `vendor`, `poNumber` | a term start, credits |
| Microsoft 365 (`internal/saas`, Graph) | `subscribedSkus`: seats prepaid and consumed per SKU | the term: `subscribedSkus` carries no dates |
| Google Workspace, Salesforce, ServiceNow, Workday (`internal/saas`) | users, seats, editions | terms (the Reseller API has them for reseller-managed Workspace tenants only; the others expose contract dates in their commercial portals, not their APIs) |
| Azure (`internal/azure`) | subscription id, state, resources | billing account, credit balance |
| AWS, GCP, OCI, Alibaba | account id, resources | promotional credits: not exposed by any read API (AWS Cost Explorer reports applied credits, not a balance; GCP shows credits in the billing export per line, not as a balance) |

## Decision

1. **A subscription cover on the asset** (`subscriptionSchema`): provider, plan, `startsAt`, `endsAt`, `credits`
   (`remaining`, `unit`, `currency`, `asOf`), source and verification. Either an end date or a balance must be known
   for the cover to exist. It is stored as `asset_records.subscription` (migration 0018), served as
   `AssetRecord.subscription` with `subscriptionEndsAt` and `creditsRemaining`, entered by hand through
   `AssetDetailsInput.subscription`, and audited per field like the other covers.
2. **Which types.** `SUBSCRIPTION_CI_TYPES` (software, software instance, licence, SaaS application and tenant, cloud
   account and resource) take a subscription in place of a warranty: the register asks them for the `subscription`
   gap and never for `warranty`; support and end of life stay. The details form shows the subscription group for
   these types and the warranty group for the rest; the register's first cover column reads "Warranty / subscription
   ends" and shows the credits left under the date; the summary counts `subscriptionExpired`.
3. **Where the data comes from.** Collectors report a term and a balance through named CI attributes
   (`SUBSCRIPTION_ATTRIBUTES`: `subscriptionStart`, `subscriptionEnd`, `creditsRemaining`, `creditsUnit`,
   `creditsCurrency`, `creditsAsOf`, with `expiresAt`, `activatedAt`, `purchaseDate`, `licenceType`, `sku`,
   `edition` as fallbacks), and `subscriptionFromAttributes` maps them the same way for the reconciler's register
   sync, for a labelled unknown CI, and for the one-off backfill of migration 0018. Per vendor:
   - **Microsoft 365**: `GET /v1.0/directory/subscriptions` (the `companySubscription` resource) gives the commercial
     term per SKU (`createdDateTime`, `nextLifecycleDateTime`); the collector joins it to `subscribedSkus` by SKU id
     and emits `subscriptionStart`/`subscriptionEnd` on each SaaS application CI. The call needs the
     `Organization.Read.All` (or `LicenseAssignment.Read.All`) permission; without it the call is 403 and the
     term stays unknown, which the register shows as the gap.
   - **Azure**: `GET /subscriptions/{id}/providers/Microsoft.Billing/billingProperties/default` gives the billing
     account; `GET /providers/Microsoft.Billing/billingAccounts/{id}/providers/Microsoft.Consumption/credits/balance`
     gives the estimated balance of a credit-based account (sponsorship, Azure credits). The collector emits
     `creditsRemaining`, `creditsUnit`, `creditsCurrency`, `creditsAsOf` on the cloud account CI; a pay-as-you-go
     subscription or a credential without billing reader rights yields nothing, never an error.
   - **Licences**: `expiresAt` (already observed) is the term end; `subscriptionStart` is read when a collector
     reports it (the synthetic estate now does).
   - **Google Workspace, Salesforce, ServiceNow, Workday, AWS, GCP, OCI, Alibaba**: no read API exposes the term or a
     balance to a read-only credential; these are entered by hand on the asset (source `manual`) and the row keeps
     the person's entry over later sweeps, as warranty and support already do. The Google Reseller API is a
     tenant-scoped decision for Syed: it applies only where the organisation buys Workspace through a reseller.
4. **The synthetic estate** carries terms on licences and a term plus a credit balance on both cloud accounts, so the
   dev register shows the cover on the first replay; nothing is invented at read time.

## Consequences

- Asset contract 0.3.0 (new schema, type set, gap value, mapping), GraphQL 1.3.0 (additive), Prisma 0018.
- The warranty gap no longer counts software, SaaS or cloud rows; `needsData` on the dev estate drops where licences
  now carry a subscription, and rises on software instances and cloud resources until a vendor reports a term.
- The collector tests cover the new calls with protocol-shaped stand-ins (no vendor data is fabricated); the real
  Microsoft 365 and Azure calls run once Syed grants the read-only credentials listed in `docs/STATE.md`.
