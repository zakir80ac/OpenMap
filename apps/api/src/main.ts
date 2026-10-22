// REQ-CORE-012 — API entry point. Telemetry is initialised by the first import; the application graph
// is loaded afterwards through a dynamic import so the loader hook sees every module.
import './instrumentation.js';

const { bootstrap } = await import('./bootstrap.js');
await bootstrap();
