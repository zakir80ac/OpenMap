# @openmap/console

The OpenMap console: Next.js 15 (App Router), React 19, TypeScript strict, Tailwind v4, TanStack Query and Virtual,
on the Obsidian Pro design system from `@openmap/ui`. Every user-facing string is an i18n key from `@openmap/i18n`,
rendered in English (ltr) and Arabic (rtl).

## Run

From the repository root, build the workspace packages once, then start the console:

```sh
pnpm install
pnpm --filter @openmap/constants build && pnpm --filter @openmap/config build && pnpm --filter @openmap/contracts build && pnpm --filter @openmap/i18n build && pnpm --filter @openmap/ui build
pnpm --filter @openmap/console dev
```

`dev` and `start` run through `scripts/next.ts`, which reads `CONSOLE_PORT` from `@openmap/config` (`loadEnv()`); nothing
in this package names a port or URL. The browser reaches the API through `NEXT_PUBLIC_API_URL`, which `next.config.ts`
derives from `PUBLIC_API_URL` at build time; `src/lib/graphql.ts` posts operations to the `/graphql` path on that origin.

Other scripts:

| Script                                  | What it does                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm --filter @openmap/console typecheck` | regenerates the theme, then `tsc --noEmit`                                   |
| `pnpm --filter @openmap/console test`      | Vitest (jsdom): sidebar navigation in both locales, layer-visibility hook    |
| `pnpm --filter @openmap/console build`     | `next build` with `output: 'standalone'` (theme generated in `prebuild`)     |
| `pnpm --filter @openmap/console e2e`       | Playwright, projects `en` and `ar`; needs `npx playwright install chromium`  |

## Locale routing

Routes live under `src/app/[locale]/`. The segment is validated with `isLocale` from `@openmap/i18n`; the locale layout
sets `<html lang dir>`, loads the fonts and mounts `Providers` (TanStack `QueryClientProvider`, `DirectionProvider` from
`@openmap/ui`, and the i18n context). Client components read strings with `useT()` from `src/providers.tsx`; server
components and metadata use `getT(locale)` from `src/lib/i18n.ts`.

- `/` redirects to `/<DEFAULT_LOCALE>/dashboard`, reading `DEFAULT_LOCALE` through `loadEnv()` at request time.
- `src/middleware.ts` prefixes any path that lacks a locale (`/cmdb` → `/en/cmdb`).
- The locale switcher in the top bar swaps the first path segment, so the same screen reopens in the other language.
- Unknown routes under a valid locale render `src/app/[locale]/not-found.tsx` inside the shell.

Routes: `dashboard` (KPIs, service health, layer summary from the `layers` and `services` queries), `layers` (twelve
layers with counts, per-device visibility stored in localStorage, isometric stack), `cmdb` (virtualised CI list over
the cursor-paginated `cis` query with layer filter chips; the global search's `?q=` becomes the contract's text filter).

## Theme generation

Tailwind reads its theme from `src/app/theme.css`, which is **generated, not committed**. `scripts/gen-theme.ts` writes
it from `@openmap/ui`: `themeCss()` (the `@theme` block that creates the `om-*` utilities) plus `stylesheet()` (the
`--om-*` custom properties, the `[dir]` blocks and the pulse keyframes). It runs automatically in `predev`, `prebuild`
and `typecheck`; run `pnpm --filter @openmap/console gen:theme` to refresh it by hand after changing tokens.

`src/app/globals.css` imports Tailwind and the generated file, scans `packages/ui/dist` for the component classes, maps
the `next/font` variables (Manrope, Inter, JetBrains Mono, IBM Plex Sans Arabic for `ar`) onto the `--om-font-*` tokens
and defines the shell geometry (`--om-sidebar-width: 232px`, `--om-topbar-height: 64px`).

## Guard notes

`next build` regenerates `next-env.d.ts` without a requirement header; `scripts/stamp-next-env.ts` (postbuild) prepends
one so `pnpm guard` stays green. Numeric literals in `apps/` are forbidden outside tests, so sizes come from the
`spacing` tokens, Tailwind classes, CSS variables and `@openmap/constants` (`GRAPH.defaultPageSize`, `TIME`).
