# ADR-065 — Notifications: webhooks, Slack, Teams, email and PagerDuty from the event stream

Status: Accepted · Date: 2026-11-10 · Tracker: REQ-INT-009 · Contracts: event 0.12.0, GraphQL 1.38.0

## Context

CAPABILITY-MAP.md §8 lists webhooks and notifications (email, Slack, Teams, PagerDuty) through the event schema, outbox
subscribers and tenant-enabled sinks. The integration catalogue already named the vendors, and the BSM engine already
delivered incidents to ITSM and SIEM adapters (ADR-012, REQ-INT-005/007). For a notification vendor, though, the
incident adapter fell through to a raw JSON post that Slack, Teams and email cannot take, and only incidents were ever
sent. Every outbox event already reaches the BSM engine's event-stream worker.

## Decision

1. **The BSM engine's notifier takes every event.** For each event it finds the tenant's enabled, outbound notification
   integrations subscribed to the event's type, and sends each a message. Sending runs in the background, so health
   propagation never waits on a channel or its retries. Incident events go to PagerDuty through the incident adapter,
   which also resolves them; webhook, Slack, Teams and email take incidents through the notifier instead.
2. **Each sink gets its own shape** (`packages/contracts/src/notification.ts`):
   - a **webhook** receives the CloudEvents envelope itself, signed: `x-openmap-signature: v1=<hex HMAC-SHA256 of
"<timestamp>.<body>">` with the credential's `signingSecret`, plus `x-openmap-timestamp`, `x-openmap-event` and
     `x-openmap-delivery`, so a receiver can verify the body, reject replays and de-duplicate;
   - **Slack** a Block Kit message (header, severity and time, fields, an "Open in OpenMap" button);
   - **Microsoft Teams** an Adaptive Card 1.4 coloured by severity, with a fact set and an open action;
   - **PagerDuty** an Events API v2 trigger, de-duplicated per subject and event type;
   - **email** a multipart text and HTML message, right to left when the message is Arabic.
3. **Messages are worded, not dumped.** Severity comes from the event's own severity, state or health, else from its
   type; the title is the event type's label in the integration's language (else the tenant's) with the subject's
   name; facts are the event's scalar fields (at most `NOTIFICATION.maxFacts`, values capped); the link opens the
   screen where the subject is seen. Every event type has a label in English and Arabic (a test enforces it).
4. **Noise and safety controls.** An integration's `minSeverity` drops lesser events; each integration sends at most
   `NOTIFICATION.maxPerWindow` messages per minute (the rest are counted as suppressed); nothing leaves in the airgap
   profile, with `FEATURE_OUTBOUND_INTEGRATIONS` off (the compose default), or when the tenant's outbound switch is
   off. Credentials come from OpenBao per message (`signingSecret` and `token` for webhooks, `url` for Slack and Teams
   so the secret-bearing webhook address is not stored in Postgres, `routingKey` for PagerDuty, `username` and
   `password` for SMTP) and are never stored or logged.
5. **Every attempt is a delivery.** HTTP sinks use the existing delivery engine (retries on retryable statuses,
   dead letter after the last); email follows the same schedule and does not retry a permanent 5xx refusal. A message
   that never left (a credential OpenBao would not give) is recorded as a failed delivery with the reason.
6. **Email without a mail library.** A small SMTP client in the engine (implicit TLS or STARTTLS, AUTH PLAIN, one
   multipart message in UTF-8 base64, multi-line replies, a timeout per reply) covers what notifications need and adds
   no dependency.
7. **Test messages.** `sendTestNotification(id)` (operators) checks the outbound switches and the vendor, then writes an
   `openmap.integration.notification.test` event and an audit event to the outbox; the engine sends the test to that
   integration only, subscribed or not, and the console re-reads the deliveries for a short while.

## Consequences

- Event contract 0.12.0 (`openmap.integration.notification.test`); GraphQL 1.38.0 (`sendTestNotification`). Metrics
  `openmap_bsm_notifications_total{vendor,outcome}` (engine) and `openmap_notification_tests_total{vendor}` (API);
  span `bsm.notify`.
- The delivery engine posts to an endpoint exactly as configured when no path is given (a webhook URL keeps its form).
- The Integrations screen edits notification settings (minimum severity, language, email sender and recipients,
  STARTTLS) over the settings it does not own, and offers "Send a test notification" to operators.
- Compose passes `FEATURE_OUTBOUND_INTEGRATIONS` through (default false), so a deployment opts in explicitly.
