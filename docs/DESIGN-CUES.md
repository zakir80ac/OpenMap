# Design cues taken from the AetherTwin prototype (Gemini / AI Studio)

Reviewed 2026-10-22 at Syed's request. The prototype is a single-page "IT Digital Twin & BSM" demo with six top-level
sections. What follows is what OpenMap adopts, what it already had, and what it deliberately does differently.

## Their navigation (six tabs)

| Section | What it shows | OpenMap decision |
| --- | --- | --- |
| BSM Dependency Map | Six horizontal lanes (L0 Business services → L1 Apps → L2 Containers/Virt → L3 Databases/Event streams → L4 Network/Security → L5 Physical/Cloud); tier filter chips; "click a node to isolate blast radius"; each card = code, health badge, name, subtitle, one headline metric | **Adopt** a lane layout mode in the dependency map (toggle next to force layout), with lanes = OpenMap layers. Adopt the card anatomy. |
| Sites & Connectivity | WAN links as first-class rows with carrier, latency, throughput/capacity, loss, redundancy state; "telco transit health" per carrier; site cards with facility tier, power capacity, racks, PUE, active alerts | **Adopt** as a new screen (we had sites only inside onboarding). Links already exist in the contract (`site_link`); add carrier and last-known telemetry. |
| DC 42U Rack Twin | Rack elevation with per-U device, category, serial, power draw, exhaust temperature; rack KPIs (load vs max safe, phase A/B balance, cold/hot aisle, U utilisation, PUE); slot inspection with BMC address, dual PSU feeds, physical cable connections | **Already had** the 3D rack; **adopt** per-device draw and exhaust temperature on the elevation, phase balance KPI, and the slot inspection panel's cable list. |
| Health & Telemetry | Fleet table: CI, category/site, IP/FQDN, health, CPU, memory, IOPS, throughput, Apdex, action; health and category filters | **Adopt** as a new screen backed by ClickHouse metrics. |
| Warranty & Compliance | Contract matrix with SLA commitment text, expiry countdown, status, annual cost; second tab for regulatory compliance and CVE risk (SOC 2, ISO 27001, PCI DSS) with audit pass rate | **Already had** the asset/warranty screen; **adopt** the SLA commitment column, annual commitment total, and a compliance tab with per-framework posture. |
| Incident Sandbox | Prepared failure scenarios by category with blast radius and estimated loss per hour; inject fault; origin CIs, cascade depth, degraded services, and an SOP runbook with steps | **Already had** interactive impact modeling (ours is component × condition, theirs is fixed scenarios). **Adopt** runbooks attached to scenarios and incidents, and "estimated loss per hour" as the standard money figure. |

## Ecosystem organisation cues

- **Every CI carries a short code** (`BS-PAYMENTS`, `DB-ORACLE-RAC`, `NET-ARISTA-SPINE1`, `FAC-PDU-01`, `SRV-R760-01`, `SAAS-OKTA-PRD`, `WRT-DELL-PSP`). Codes make cards scannable and are what people say out loud in incidents. OpenMap adds `code` to the CI contract, generated as `<layer prefix>-<slug>` and editable.
- **One headline metric per layer**: services show impact per hour, applications Apdex, compute CPU, databases IOPS, network throughput, facilities PUE, cloud load, SaaS seat utilisation. OpenMap encodes this as `LAYER_HEADLINE_METRIC` so every card and table agrees.
- **Money everywhere**: impact per hour on services and scenarios, annual cost on contracts, total annual support commitment. OpenMap already carries revenue per hour and contract cost; the UI must surface them on cards, not only in detail.
- **Health vocabulary**: NOMINAL / WARN / CRITICAL badges with a legend. OpenMap keeps healthy / degraded / down (plus unknown and at-risk) because they map to propagation rules; the badge styling is the same idea.
- **Warranties and support contracts appear as CIs in the fleet** (`WRT-*`). OpenMap models them as records attached to assets and vendors, and lists them in the asset screen; they do not pollute the dependency graph.

## What OpenMap keeps doing differently

- Twelve layers instead of six lanes, because OS, storage, cloud and SaaS deserve their own visibility toggles; the lane view groups them into the six lanes for the map.
- Impact modeling is component × condition with redundancy-aware propagation, not a fixed scenario list; prepared scenarios become saved scenarios on top of it.
- Everything is discovered and bitemporal; nothing on screen is a static record.
- Arabic and RTL from the first screen.
