# ADR-022 — The formal profile: Horizon without the game-like effects

Status: Accepted · Date: 2026-11-05 · Tracker: REQ-UI-034

## Context

The Horizon pass (ADR-018, ADR-020) answered "generic, AI-generated" with holographic gradient card borders, HUD
corner brackets, a drifting perspective grid floor, aurora washes, travelling sheens on live bars, expanding rings on
live dots, glowing figures and an entrance rise on every card. Reviewing the holographic layer stack, Syed judged the
result "game inspired" and asked for a final sweep that makes the console formal. The dark navy ground, glass
surfaces, the Sora display face and the accent palette are not in question; the ornament is.

## Decision

- **One token group, not many.** `packages/ui/src/tokens/effects.ts` keeps only `float`: a layered ambient and key
  shadow a surface may opt into (`om-float`), a 2 px hover lift and a faint accent outline. The holographic border,
  bracket, grid, aurora, sheen, rise, ring and value-glow tokens, their CSS variables, keyframes and rules are
  removed, not switched off, so no screen can turn them back on by accident.
- **Cards are plain bordered surfaces** (`border-om-border-glass` on `surface1`, the card shadow, the inner
  highlight). No pseudo-elements.
- **Glow is on request.** `Pill` and `Bar` default to `glowing = false`; `Dot` keeps its opacity pulse for live
  states and loses the ring; sparklines and donuts draw without drop shadows; the section eyebrow keeps its mono caps
  and lead line without the glow.
- **Shell.** The sidebar's active item is a quiet cyan tint with the indicator bar; the brand mark is set in sentence
  case; group labels rule with a plain hairline; the top bar loses its gradient hairline. The console ground is the
  navy token with one faint cool highlight; no grid floor.
- **What stays.** Sora for display, Inter for body, JetBrains Mono for codes; the layer and state colours; the
  mono-caps eyebrows; the Segmented, Sparkline and Donut primitives; the floating KPI tiles on the dashboard.

## Consequences

- Every screen is re-captured (walkthrough) and Lighthouse re-run; the formal profile removes animation, so the
  budgets can only improve.
- The twin's holographic edge glow and the dashboard's tiles keep the float shadow; nothing else lifts.
- Future ornament goes through this ADR: a new effect is a token in `effects.ts` with a reason, used by a rule, never
  a one-off in a component.
