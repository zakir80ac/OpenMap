# Webhooks and notifications (REQ-INT-009, ADR-065)

Captured 2026-11-10 on the dev compose stack. The compose stack keeps outbound integrations off unless the deployment
turns them on (`FEATURE_OUTBOUND_INTEGRATIONS`, default false; the airgap profile forces it off), so on the live screen a
test notification is refused with the deployment's reason; real delivery is proven by the integration test against the
stack's Postgres and OpenBao with an HTTP receiver and an SMTP server.

## What is sent

| Sink            | Shape                                                                                                                        | Credential fields (OpenBao)       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Webhook         | The CloudEvents envelope, `x-openmap-signature: v1=<HMAC-SHA256 of "<timestamp>.<body>">`, timestamp, event and delivery ids | `signingSecret`, optional `token` |
| Slack           | Block Kit: header, severity and time, fields, "Open in OpenMap" button                                                       | `url` (the incoming-webhook URL)  |
| Microsoft Teams | Adaptive Card 1.4 coloured by severity, fact set, open action                                                                | `url`                             |
| PagerDuty       | Events API v2 trigger, `dedup_key` per subject and event type (incidents go through the incident adapter)                    | `routingKey`                      |
| Email (SMTP)    | Multipart text and HTML in UTF-8, right to left in Arabic; implicit TLS or STARTTLS, AUTH PLAIN                              | `username`, `password`            |

Settings per integration: minimum severity, message language (else the tenant's), email sender and recipients, STARTTLS.
Each integration sends at most 30 messages a minute; the rest are counted as suppressed.

## Tests

| Test                                                                         | What it proves                                                                                                                                                                                                                                                                                                                                                                                    | Result                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `packages/contracts/src/notification.test.ts` (T-562)                        | severity from the event or its type, facts capped, console paths, settings defaults and refusal of bad addresses, Slack, Teams, PagerDuty and email payloads (escaped HTML, right to left)                                                                                                                                                                                                        | 7 passed (contracts 106)    |
| `apps/bsm-engine/src/integrations/smtp.test.ts`, `notify.test.ts` (T-563)    | SMTP against an in-test server (AUTH PLAIN, every recipient, encoded Arabic subject, base64 parts, no early end of DATA, refused recipient, silent server); the notifier: signed webhook, Slack, Teams, email, PagerDuty; Arabic; incident skip; minimum severity; airgap and tenant switches; rate limit; test targeting; unreadable credential recorded; every event type labelled in en and ar | 4 + 5 passed (engine 66)    |
| `apps/bsm-engine/src/integrations/notify.integration.test.ts` (T-564)        | on the stack's Postgres and OpenBao: an SLA breach reaches an HTTP receiver that verifies the HMAC signature and an SMTP server in Arabic, both recorded as delivered; a test reaches only the named integration; a disabled one gets nothing                                                                                                                                                     | 2 passed                    |
| `apps/api/src/integrations/notification-test.integration.test.ts` (T-565)    | `sendTestNotification` over GraphQL as an operator: the test and audit events in the outbox in one transaction; an ITSM integration refused; nothing queued with the tenant's outbound switch off                                                                                                                                                                                                 | 2 passed                    |
| `apps/console/src/components/integrations/IntegrationsView.test.tsx` (T-566) | an operator sends a test from the detail panel and sees it queued (en, ar); notification settings written over the settings the form does not own                                                                                                                                                                                                                                                 | 9 passed (console 380)      |
| `apps/console/e2e/screens.spec.ts` (Integrations)                            | on the live stack: a webhook integration created, probed, and a test notification sent, answered with queued or the deployment's refusal; screenshots `integrations-notify-{en,ar}.png`                                                                                                                                                                                                           | 3 of 3 (setup, en, ar), 8 s |

Guard ok; `contracts:check` GraphQL 1.38.0 additive; event contract 0.12.0; i18n in sync (67 keys per locale).
