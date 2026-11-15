// REQ-PERF-007 (ADR-077) — the globals three.js, react-three-fiber and drei look up and a worker does not have. This
// module is imported first in twin.worker.tsx, so it runs before they load. Nothing here draws or reads layout: the
// canvas itself becomes `window` once the renderer is initialised (twin.worker.tsx), so listeners added to the window
// (the orbit controls' drag) reach the forwarded events.
const scope = globalThis as unknown as Record<string, unknown>;
if (scope['window'] === undefined) scope['window'] = {};
if (scope['document'] === undefined) scope['document'] = {};

export {};
