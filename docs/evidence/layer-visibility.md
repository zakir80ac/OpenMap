# Layered visibility across the estate-wide screens (REQ-CMDB-021)

Captured 2026-11-07 on the dev compose stack.

The twelve layers (DC, network and security, hardware, storage, virtualization, cloud, OS, containers, databases,
applications, SaaS, unknown) are the CI contract's `CI_LAYERS`; every CI carries one (`CI_TYPE_LAYER`, or a person's
label). The Layers screen sets which layers this device shows (REQ-UI-005, kept per device). Before this row only
CMDB, Dependencies and the digital twin honoured it.

## What changed

1. **One rule** (`apps/console/src/components/common/HiddenLayersNotice.tsx`): `visibleLayersFilter` asks for the layer
   a person picks, else only the visible layers while any is hidden, else no restriction.
2. **One notice** on every estate-wide list while layers are hidden: which ones, Show all layers, and Choose layers
   (to the Layers screen).
3. **Screens**: CMDB (notice added; filter already applied), Assets register (hidden layers left out of the register
   query, their pills dimmed), Impact explorer (left out of the component list and search, pills dimmed), Dashboard
   estate-by-layer widget (hidden layers left out of the breakdown). Dependencies and the twin keep their own lane and
   scene switches over the same setting.

## Tests

| Id | What | Result |
| --- | --- | --- |
| T-200 | `apps/console/src/components/common/HiddenLayersNotice.test.tsx` (en, ar): the filter rule, the hidden list, the notice naming layers, Show all; `AssetsView.test.tsx`: a hidden layer left out of the register query, the notice, Show all restoring the unrestricted query | 5 of 5 and 1 of 1 (console 307 of 307) |
| T-201 | Playwright `apps/console/e2e/layer-visibility.spec.ts` (en, ar): Applications switched off on Layers; CMDB, Assets, Impact and the Dashboard show the notice and CMDB lists no application-layer row; Show all brings everything back | 2 of 2 |

## Screenshots

- `console/layer-visibility-cmdb-en.png`, `console/layer-visibility-cmdb-ar.png`
- `console/layer-visibility-assets-en.png`, `console/layer-visibility-assets-ar.png`
