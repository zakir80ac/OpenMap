# Assistant: conversations that remember (REQ-AI-008, ADR-028 increment two)

Captured 2026-11-05 on the dev compose stack: Postgres, Memgraph and ClickHouse with the synthetic estate (tenant
`ac9a6a65-1f19-4ecf-bf16-b3a90e42cc5c`), the `cpu` LLM profile (llama.cpp serving `qwen2.5-coder-1.5b-instruct-q4_k_m.gguf`),
model prose on for English only (`ASSISTANT_PROSE_LOCALES=en`; Arabic answers are the deterministic composition).
Increment one is documented in `assistant-conversation.md`.

## What changed

1. **A conversation is a record.** Prisma migration 0019 adds `assistant_conversations` (owner, tenant, title =
   the first question clipped) and `assistant_turns` (the question, the locale, the outcome `answered` /
   `clarified` / `failed`, and the answer as returned: text, intent, confidence, figures, evidence, follow-ups,
   clarification, grounded, the CI ids and the resolved reading of the question). `askAssistant(question, locale,
   conversationId)` appends to a conversation and opens one when none is given; the answer carries `conversationId`
   and `turnId`. `conversations`, `conversation(id)` and `deleteConversation(id)` are scoped to the user who asked.
   GraphQL 1.5.0 (additive), assistant contract 0.2.0.
2. **A follow-up leans on the previous turn** (`apps/assistant/src/core/conversation.ts`). A question that opens
   with a continuation word ("and", "what about", "و…", "وماذا عن"), or is short with no intent marker and only a
   fragment (a type, a period, a window, a scope word, a grouping), inherits what it left out from the previous
   turn's persisted reading; the intent is derived again from the merged entities. "And last month?" after an uptime
   question re-runs `services.availability` with `back: 1`; "and for VMs?" after "average memory of hosts" swaps the
   subject and keeps the attribute and aggregate; "what about VMs?" after a host CPU question carries the measurement
   to `vm.cpu.utilisation_percent`; "and per site?" after a host count groups it; "and web-01?" after an impact
   question walks the impact of web-01. What was inherited is recorded on the classification as `followup:<field>`.
3. **`metrics.series`.** "CPU utilisation of host X over the last 7 days" (or "آخر 7 أيام", "last 24 hours", "last
   week") reads `metrics` in ClickHouse over the window, averaged into `ASSISTANT.seriesBuckets` buckets, and is worded
   as the average, the range, the sample count, the latest reading and the trend from the first to the last bucket in
   en and ar. A calendar period on a measurement ("last month") is read as a rolling window of the same length.
   `metrics.latest` now honours a named CI ("CPU of host X").
4. **The console shows the conversations.** The Assistant screen lists the person's conversations beside the thread
   (open, continue, delete, new); the open conversation's id lives in the URL (`?c=<id>`), so a reload rebuilds the
   thread from the server and a follow-up typed into an opened conversation continues it.

## Evaluation set: 38 of 38 (100%, floor `ASSISTANT.evalAccuracyMin`)

`apps/assistant/src/eval/questions.ts` now holds 30 single questions (the series question added) and four
multi-turn conversations (`EVAL_CONVERSATIONS`), run by `apps/api/src/assistant/assistant.eval.integration.test.ts`
(T-143, T-146) through GraphQL against the stack above. Each turn of a conversation is asked with the conversation id
of the first; the later turn must resolve to the expected intent and skill and name the expected fragments in its
evidence (`"back":1`, `"vm"`, `"hours":168`). The conversation is then listed, read back with both turns and deleted.
The per-question record is `docs/evidence/assistant-eval.json`.

| Conversation | Turn one | Turn two | Outcome |
| --- | --- | --- | --- |
| uptime-then-last-month (en) | What is the uptime of business services this month? → `services.availability`, 100% | And last month? → `services.availability`, `back: 1`: "Last month, 15 business services were 100% available…" | ok |
| memory-then-vms (en) | What is the average memory of the hosts? → `cmdb.attributes` memoryGb on hosts | And for VMs? → `cmdb.attributes` memoryGb on `vm`: "The average memory of 1,500 virtual machines is 23.95 GB." | ok |
| ar-uptime-then-last-month (ar) | ما هو توافر خدمات الأعمال هذا الشهر؟ | والشهر الماضي؟ → `services.availability`, `back: 1` | ok |
| cpu-then-window (en) | CPU utilisation of host {name} → `metrics.latest` for that host | And over the last 7 days? → `metrics.series`, `hours: 168`, the sample-less wording (see below) | ok |

The synthetic estate holds one metric sample per CI at its generation instant (2026-10-01 on this stack), so a series
over the last days is correctly answered as "No host CPU utilisation samples were recorded for ahv-dmm-c01-01 over the
last 7 days." The series arithmetic (window binding, sample-weighted average, minimum, maximum, first and last
readings, trend) is unit-tested against bucket rows in T-146 (`metrics-series.test.ts`); the SQL runs in the
evaluation without error.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-145 | `apps/assistant` unit: windows and continuation words in both scripts, follow-up detection, "and last month?" (en, ar), "and for VMs?", measurement carried to the new type and to a window, grouping/scope/name added, complete questions left alone, persisted reading round-trip, every multi-turn case resolved offline, series wording in en and ar | 54 of 54 |
| T-146 | API: `metrics.series` offline (bucket reduction, window parameters, named CI, empty window, unknown name) and the evaluation set through GraphQL with the four conversations, list / read / delete | 2 of 2; 38 of 38 |
| T-147 | Console `AssistantView` (en, ar): the first answer puts the conversation id in the URL and follow-ups continue it, a conversation in the URL loads with its turns and continues, open / new / delete from the list, a missing conversation says so, server and local turns merged without duplicates | 14 of 14 |
| T-148 | Playwright `assistant.spec.ts` (en, ar) against the live stack: uptime question opens a conversation (URL), "and last month?" / "والشهر الماضي؟" answered as availability with `back: 1`, reload rebuilds the thread, new conversation, reopen from the list, delete | see below |

Also green: `pnpm guard`, `pnpm i18n:check` (26 new keys per locale), `pnpm contracts:check` (1.5.0 additive, one
dangerous change: the optional `conversationId` argument), `pnpm --filter @openmap/console test` (248), lint.
Lighthouse: not re-measured (the Assistant screen carries no budget; the budgeted screens are untouched).

## Screenshots

- `console/assistant-followup-en.png`, `console/assistant-followup-ar.png`: the follow-up answered as last month's
  availability, with the evidence open showing `"back":1`.
- `console/assistant-reloaded-en.png`, `console/assistant-reloaded-ar.png`: the same thread after a reload, rebuilt
  from the server, with the conversation listed beside it.
