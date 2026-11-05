# ADR-028 — Ask becomes a conversation: intent, plan, retrieve across the stores, compose with grounding

Status: Accepted and implemented (increment one shipped under REQ-AI-007 on 2026-11-05: skills `cmdb.attributes`, `metrics.latest`, `services.availability`, `incidents`, `impact`, `history`, `howto` and the kept `graph.query`; the classifier with clarifications; the grounding guard; the evaluation set in CI; GraphQL 1.4.0. Increment two shipped under REQ-AI-008 on 2026-11-05: persisted conversations (`assistant_conversations`, `assistant_turns`, migration 0019), follow-up resolution against the previous turn (`apps/assistant/src/core/conversation.ts`), the `metrics.series` skill over a rolling window, GraphQL 1.5.0 with `Conversation`, `AssistantTurn`, `conversations`, `conversation`, `deleteConversation` and `askAssistant(…, conversationId)`, the console's conversation list with the thread kept by id in the URL, and four multi-turn cases in the evaluation set: 38 of 38 through GraphQL) · Date: 2026-11-05 · Tracker: REQ-AI-007, REQ-AI-008

Notes from increment two. (1) A turn row holds both the question and the answer, so the column the first sketch called
`role` is `outcome` (`answered`, `clarified`, `failed`): the thread is one row per exchange, not two. (2) The follow-up
resolution is deterministic: a question that opens with a continuation word, or is short with no intent marker and
only a fragment (a type, a period, a window, a scope word, a grouping), inherits what it left out from the previous
turn's persisted reading and the intent is derived again from the merged entities; a new subject type drops the
previous names and scope, a swapped type carries a measurement to its equivalent metric, and a marker intent that no
longer fits (availability on hosts) is dropped. (3) A calendar period in a measurement question ("CPU last month") is
read as a rolling window of the same length (`ASSISTANT.rollingDays`), because measurements are sampled, not booked
to calendar months as availability is. (4) The synthetic estate holds one sample per CI at its generation instant,
so a series over the last days is the sample-less wording on the dev stack; the series arithmetic is unit-tested
against bucket rows and the SQL runs in the evaluation.

## Context

Syed's 2026-11-05 review: "Ask chat is dumb. I want a more comprehensive human like chat, not just fetch SQL query
output. I want a structured, multilevel chat trained for OpenMap." Earlier the same day: Ask "doesn't always provide
response expected and throws error", with two examples: "OS per server average" was refused because `memory` is not a
graph property, and "How many VMs running per host in VMware" failed on a nested aggregate.

What Ask is today (REQ-AI-001): one question becomes one Cypher statement for Memgraph through a grounded prompt,
rewritten and validated (tenant scope, read-only, known labels and directions), repaired twice on rejection, and
returned as a deterministic summary line, the Cypher and a table. There is no conversation state on the server, the
console keeps turns in React state only, Memgraph is the only store read, measurements in ClickHouse and attributes
in Postgres are out of reach, and the model (Qwen2.5-Coder 1.5B on the CPU profile) copies prompt fragments verbatim.

## Decision

1. **A conversation is a record.** `assistant_conversations` (owner, title, tenant) and `assistant_turns` (role,
   text, intent, the retrieval plan and its evidence, the CIs cited, follow-ups, clarification) persist per user;
   `askAssistant(question, conversationId)` appends to a conversation and the answer carries the conversation id, so
   a follow-up ("and last month?") resolves against the previous turn's entities and period.
2. **Five levels, deterministic where it matters.**
   - _Understand_: an intent classifier over a bilingual pattern catalogue (lookup, count, attribute statistics,
     measurement, availability, incidents, impact, change history, how-to, report) with the LLM as the fallback
     that returns JSON (intent, entities, measurement, period) and a confidence; entities are resolved against the
     CMDB (names, codes, types) and an ambiguous match becomes a clarifying question, not a guess.
   - _Plan_: a short list of retrieval steps over named skills, each with a validated parameter shape:
     `graph.query` (the existing NL→Cypher path, kept), `cmdb.attributes` (Postgres aggregates over CI attributes:
     OS per host, memory per VM, VM density per host through `runs_on`), `metrics.latest` / `metrics.series`
     (ClickHouse metrics per CI or per type), `services.availability` (ADR-024), `incidents`, `impact` (the impact
     service), `history` (`ci_history`), `howto` (a checked-in knowledge base of OpenMap's screens and concepts).
   - _Retrieve_: the steps run with timeouts; every query, row count and error is kept as evidence on the turn.
   - _Compose_: the LLM writes two to five sentences from the structured results in the user's locale, under a
     grounding guard: every number in the prose must occur in the results, every CI named must be in the evidence,
     or the sentence is replaced by the deterministic summary; the answer always ends with the figures it rests on
     and the CIs it cites, and the evidence (queries) is one click away.
   - _Follow up_: three suggested next questions per intent (deterministic), the clarifying question when
     confidence is low, and "I cannot answer that from the estate" with the reason when no skill applies.
3. **Trained for OpenMap means a catalogue, examples and an evaluation set, not weights.** The grounding prompt is
   generated from the contracts (types, layers, relationships, metric names, availability and SLA vocabulary) with
   worked examples per skill; `apps/assistant/eval/questions.json` holds the questions Syed raised and the ones each
   skill must answer, with the expected intent, skill and figure; `pnpm --filter @openmap/assistant test:integration`
   runs them against the real stack and CI fails under `ASSISTANT.evalAccuracyMin`. Failures are events
   (`openmap.assistant.query.failed`) so the catalogue grows from what people actually ask. Fine-tuning (LoRA on the
   evaluation set, Qwen2.5-7B on the GPU profile) is the documented next step once a GPU host exists; it is not what
   the first increment depends on.
4. **The console shows a conversation**: the thread with the prose answer, the figures and CI pills, "show the
   evidence", the follow-up chips, the clarification as a question with choices, and the list of past conversations.

## Consequences

- GraphQL: `Conversation`, `AssistantTurn`, `conversations`, `conversation`, `askAssistant(question, conversationId)`,
  `deleteConversation`; the `AssistantAnswer` of REQ-AI-001 remains for the Impact screen. Prisma migration for the
  two tables. The assistant module reads Postgres, Memgraph and ClickHouse through the API's existing repositories.
- The two reported failures become skill cases: "OS per server" is `cmdb.attributes` (group hosts by `os`), "VMs per
  host in VMware" is `cmdb.attributes` over `runs_on` with the average computed in SQL, never in nested Cypher.
- Increment one (REQ-AI-007): skills `cmdb.attributes`, `metrics.latest`, `services.availability`, the classifier
  with clarifications, the grounding guard, the evaluation set in CI. Increment two (REQ-AI-008): persisted
  conversations, follow-ups, `howto`, `history`, the console thread and conversation list.
