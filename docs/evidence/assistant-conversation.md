# Assistant: a conversation over the estate (REQ-AI-007, ADR-028)

Captured 2026-11-05 on the dev compose stack: Postgres, Memgraph and ClickHouse with the synthetic estate (tenant
`ac9a6a65-1f19-4ecf-bf16-b3a90e42cc5c`), the `cpu` LLM profile (llama.cpp serving `qwen2.5-coder-1.5b-instruct-q4_k_m.gguf`; `LLM_MODEL`
names the alias the API asks for), model prose on (`ASSISTANT_PROSE`) for English only
(`ASSISTANT_PROSE_LOCALES=en`, the compose default for the CPU profile; Arabic answers are the deterministic composition).

## What changed

Ask was one question → one Cypher statement → a table. It is now the five levels of ADR-028:

1. **Understand** (`apps/assistant/src/core/intent.ts`): a bilingual vocabulary (CI types, attribute families,
   measurements, aggregates, grouping words, intent markers, periods, health, names, scope words) reads the question
   deterministically; the model is asked for a JSON verdict only when the catalogue leaves the intent unknown or the
   confidence under `ASSISTANT.minIntentConfidence`, and its verdict fills gaps, never overrides a confident match.
2. **Plan** (`plan.ts`): the intent becomes skill steps with validated parameters, or a clarifying question when a
   name is missing or nothing in the catalogue explains the question.
3. **Retrieve** (`apps/api/src/assistant/skills/*`): `cmdb.attributes` (Postgres: counts, breakdowns, numeric
   aggregates, relationship fan-out such as VMs per hypervisor, all in SQL), `metrics.latest` (ClickHouse: latest
   sample per CI aggregated or ranked), `services.availability` and `incidents` (the services module of ADR-024),
   `impact` and `history` (the dependency graph and the CI versions), `howto` (a catalogue of the screens) and the kept
   `graph.query` (REQ-AI-001 NL→Cypher) for open-ended lookups. Each step runs with a timeout and is kept as
   evidence: store, query, parameters, rows, duration, error.
4. **Compose** (`compose.ts`, `guard.ts`): every summary is worded through the message catalogue in en and ar with the
   figures it rests on; when prose is on, the model rewords it under the grounding guard (every number must be a
   figure at some rounding, every identifier a CI the evidence names, at most `ASSISTANT.maxProseSentences`), and an
   ungrounded reply falls back to the deterministic text with `grounded: false` on the answer.
5. **Follow up** (`followups.ts`): three next questions per intent; a clarification offers choices that re-ask the
   question with the exact CI code.

The two reported failures are skill cases now: "OS per server average" is a breakdown of hosts by `osName`;
"How many VMs running per host in VMware" is the `hosted_on` fan-out from VMs to hypervisors, scoped by the
`platform` value `vmware` the catalogue discovered on the tenant's VMs.

## Evaluation set: 29 of 29 (100%, floor `ASSISTANT.evalAccuracyMin`)

`apps/assistant/src/eval/questions.ts`, run by `apps/api/src/assistant/assistant.eval.integration.test.ts` (T-143)
through GraphQL against the stack above. Each question must resolve to the expected intent and first skill (or a
clarification), carry a figure where the estate holds one, and name the expected fragment in its evidence query.

| Id                  | Question                                                         | Intent          | First skill           | Figures | Grounded prose | Result |
| ------------------- | ---------------------------------------------------------------- | --------------- | --------------------- | ------- | -------------- | ------ |
| `count-hosts`       | How many hosts are there?                                        | count           | cmdb.attributes       | 1       | yes            | pass   |
| `os-per-server`     | OS per server average                                            | attribute_stats | cmdb.attributes       | 6       | yes            | pass   |
| `vm-density-vmware` | How many VMs running per host in VMware                          | count           | cmdb.attributes       | 3       | yes            | pass   |
| `avg-memory-hosts`  | What is the average memory of the hosts?                         | attribute_stats | cmdb.attributes       | 2       | yes            | pass   |
| `hosts-per-os`      | How many hosts run each operating system?                        | count           | cmdb.attributes       | 6       | yes            | pass   |
| `hosts-per-site`    | How many hosts per site?                                         | count           | cmdb.attributes       | 5       | no             | pass   |
| `vcpus-per-vm`      | What is the average number of vCPUs per VM?                      | attribute_stats | cmdb.attributes       | 2       | yes            | pass   |
| `avg-cpu-hosts`     | Average CPU utilisation of hosts                                 | measurement     | metrics.latest        | 2       | no             | pass   |
| `top-cpu-hosts`     | Which hosts have the highest CPU utilisation?                    | measurement     | metrics.latest        | 10      | no             | pass   |
| `power-racks`       | Which PDUs draw the most power?                                  | measurement     | metrics.latest        | 10      | yes            | pass   |
| `uptime-month`      | What is the uptime of business services this month?              | availability    | services.availability | 4       | yes            | pass   |
| `uptime-service`    | What was the availability of "ATM Network" last month?           | availability    | services.availability | 2       | yes            | pass   |
| `open-incidents`    | Which incidents are open?                                        | incidents       | incidents             | 1       | yes            | pass   |
| `impact-host`       | Which business services depend on the host named ahv-dmm-c01-01? | impact          | impact                | 1       | yes            | pass   |
| `impact-no-name`    | What is affected if it fails?                                    | impact          | None                  | 0       | yes            | pass   |
| `history-host`      | What changed on the host ahv-dmm-c01-01 recently?                | history         | history               | 1       | yes            | pass   |
| `howto-subnet`      | How do I add a subnet?                                           | howto           | howto                 | 0       | yes            | pass   |
| `services-down`     | Which business services are down?                                | lookup          | graph.query           | 0       | yes            | pass   |
| `racks-most-hosts`  | Which racks hold the most hosts?                                 | lookup          | graph.query           | 1       | yes            | pass   |
| `small-talk`        | hello there                                                      | unknown         | None                  | 0       | yes            | pass   |
| `ar-count-hosts`    | كم عدد المضيفين؟                                                 | count           | cmdb.attributes       | 1       | yes            | pass   |
| `ar-avg-memory`     | ما متوسط الذاكرة للمضيفين؟                                       | attribute_stats | cmdb.attributes       | 2       | yes            | pass   |
| `ar-vm-density`     | كم جهازاً افتراضياً لكل مضيف؟                                    | count           | cmdb.attributes       | 3       | yes            | pass   |
| `ar-uptime`         | ما هو توافر خدمات الأعمال هذا الشهر؟                             | availability    | services.availability | 4       | yes            | pass   |
| `ar-incidents`      | أي الحوادث مفتوحة؟                                               | incidents       | incidents             | 1       | yes            | pass   |
| `ar-howto-subnet`   | كيف أضيف شبكة فرعية؟                                             | howto           | howto                 | 0       | yes            | pass   |
| `ar-avg-cpu`        | متوسط استخدام المعالج للمضيفين                                   | measurement     | metrics.latest        | 2       | yes            | pass   |
| `ar-services-down`  | أي خدمات الأعمال معطلة؟                                          | lookup          | graph.query           | 0       | yes            | pass   |
| `ar-hosts-per-os`   | كم مضيفًا يعمل بكل نظام تشغيل؟                                   | count           | cmdb.attributes       | 6       | yes            | pass   |

## Other tests

| Test                                                                   | What it proves                                                                                                                                                                                                                                                                | Result                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `apps/assistant/src/core/conversation.test.ts` (T-142)                 | vocabulary normalisation and matching in both scripts; every evaluation question classified and planned as expected offline; every summary kind worded in en and ar with its figures; the guard rejects invented numbers and identifiers; the model's verdict only fills gaps | 44 passed (3 files, incl. compose.test.ts) |
| `apps/console/src/components/assistant/AssistantView.test.tsx` (T-144) | prose, figures, evidence steps, linked CIs and follow-ups in en and ar; a follow-up and a clarification choice are asked as the next question with the locale; refusal and ungrounded states                                                                                  | 7 passed                                   |
| `apps/console/e2e/screens.spec.ts` (Assistant)                         | the example question answered on the real stack with figures, follow-ups and evidence, screenshots in en and ar                                                                                                                                                               | 3 of 3 (setup, en, ar), 11 s               |

Guard ok; `contracts:check` GraphQL 1.4.0 additive (the optional `locale` argument); i18n in sync (193 keys added per locale).
