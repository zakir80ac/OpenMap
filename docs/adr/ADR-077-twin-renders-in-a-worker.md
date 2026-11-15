# ADR-077 — The digital twin renders in a Web Worker on an OffscreenCanvas

Status: Accepted · Date: 2026-11-15 · Tracker: REQ-PERF-007, REQ-UI-029, REQ-UI-037, REQ-PERF-001

## Context

The 3D twin (REQ-UI-029, ADR-018) drew with three.js and react-three-fiber on the page's main thread. On the CI runner
its Lighthouse performance was 0.84 to 0.90 against the 0.90 floor, about half the runs red. Measured on 2026-11-14 and
15:

- Changes that cut the twin's blocking time locally from 120 ms to 30 ms did not move CI. These were one
  InstancedMesh per box set, Lambert materials, and shaders compiled with `compileAsync` before the first frame.
- With a 4x CPU slowdown on the dev host (800 ms blocking time, 0.73), the long tasks were react-three-fiber's root
  mount: 578 ms and 197 ms.
- A Chrome trace of that load had about 400 ms in `GLES2::ReadPixels` and `CommandBufferHelper::Finish`, though no
  script called `readPixels`.
  - Where there is no GPU, Chrome composites the page in software, so every frame of a WebGL canvas is read back to
    the main thread, after the CPU has rasterised it (SwiftShader).
  - Antialiasing off, no infinite grid, a `desynchronized` context and fewer frames changed it little (670 to 764 ms).
- Operators also meet this. A NOC terminal or a VDI session without a GPU is the same environment, so the cost is
  real, not a quirk of CI.

CLAUDE.md §9 already puts the 2D dependency graph in a Web Worker for the same reason.

## Decision

- **The twin's canvas goes to a worker.** It is transferred with `transferControlToOffscreen()` to a module worker
  (`apps/console/src/components/twin/worker/twin.worker.tsx`). The worker runs react-three-fiber's `createRoot` on the
  OffscreenCanvas with the same scene (`TwinSceneContent`). The WebGL context, three.js, the scene's React tree, shader
  compilation and every frame, with its read-back, stay off the main thread.
- **The page and the worker exchange plain messages** (`worker/protocol.ts`):
  - into the worker: the facility and graph models, the selection, forwarded pointer and wheel events, and the canvas
    size (a ResizeObserver);
  - out of the worker: select, hover, the cursor the orbit controls ask for, and label positions.
- **Labels become DOM.** drei's `<Html>` needs a DOM, so the scene projects each label's anchor to canvas pixels after
  every drawn frame, and the page draws the labels as DOM over the canvas.
- **The worker shims the canvas as an element.** It adds style, `ownerDocument`, the client size, pointer capture and
  listeners, and builds react-three-fiber's event manager from the forwarded events. It passes every root option on
  each `configure`, because react-three-fiber resets the options it is not given (the frame loop would start running).
- **No new dependency.** `@react-three/offscreen` (0.0.8) was evaluated and not taken. It is pre-1.0, it takes over
  `worker.onmessage`, follows only window resizes, and does not cover labels. The part needed here is about 200 lines
  of our own.
- **Fallback.** A browser that cannot transfer a canvas, or whose worker fails to start, gets the same scene on a
  canvas in the page (`TwinCanvasInPage`).

## Consequences

- Dev host, 4x CPU slowdown, median of three:
  - total blocking time 800 ms to 68 ms;
  - performance 0.73 to 1.0;
  - largest contentful paint 0.40 s.
- Selection, hover, orbit and the drill-down work through the worker: e2e T-121 and T-662 in en and ar, plus a scripted
  click in the scene. There were no console errors.
- The worker bundles three.js and react-three-fiber itself. The page no longer evaluates them for the twin, except in
  the fallback.
- A future 3D screen should start from this host (`TwinScene.tsx` with its worker) rather than a main-thread
  `<Canvas>`. The 3D layer stack (REQ-UI-033) still draws in the page; it is within budget in CI today.
