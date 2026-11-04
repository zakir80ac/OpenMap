# ADR-021 — The Layers screen as a stack that zooms onto a layer's equipment

Status: Accepted · Date: 2026-11-05 · Tracker: REQ-UI-033 · Dependency: simple-icons 16.36.0 (CC0-1.0)

## Context

The Layers screen drew the twelve-layer model as a flat isometric SVG (REQ-UI-005). Syed asked for a revision with
3D icons per layer; a first cut with translucent wafers and abstract holographic glyphs was rejected the same day
("horrible", "game inspired", labels overlapping): he wants layers shown as the realistic objects they hold —
switches and firewalls, racks, servers, storage — with VMware, Microsoft, Red Hat and similar marks where they apply,
and the whole console more formal. The console already carries three.js, react-three-fiber and drei for the digital
twin (ADR-018), so a real 3D scene costs no new renderer.

## Decision

- **Overview, then focus.** `LayerStack3D` (client-only chunk, loaded after the page paints) renders the twelve
  layers as a stack of slate planes in contract order, the data centre at the bottom, each with an accent strip in
  the layer's `layerColors` token, under a three-quarter orthographic camera, with the layer name and count as HTML
  labels beside each plane. Syed judged this ordered stack the right overview. A click on a plane, or on its row in
  the list, eases the camera onto that plane (380 ms), recedes the other planes and stands the layer's equipment on
  it; a focus panel under the canvas shows the count, the health split, the platform marks and a link into the CMDB
  filtered to the layer; Escape, Back or a second click returns to the overview. Twelve tiles in three rows were
  tried in between and lost the layering sequence. Shadows, a hemisphere light
  and a key light give the equipment weight. Orbit is limited to the three-quarter reading; nothing spins.
- **Equipment.** The focused layer shows schematic equipment built from primitives at plausible proportions
  (`LAYER_STACK`):
  42U cabinets with rails, doors and a status LED for the data centre; a 32-port switch and a firewall appliance for
  network and security; 2U servers with drive bays for hardware; a 12-slot disk shelf with a SAN switch for storage;
  a host with translucent VM cards for virtualization; availability-zone slabs for cloud; a server with a console
  screen for operating systems; a host carrying container blocks for containers; stacked drums for databases; a
  three-server tier for applications; platform cards for SaaS; a translucent crate for `unknown`. A layer repeats
  its unit one to three times by its share of the largest count. Chassis are graphite, bezels darker, LEDs emissive.
- **Vendor marks.** Representative platforms per layer are shown beside the layer's row in the visibility list
  (`LAYER_MARKS`), as crisp inline SVG, never inside the canvas where they would be too small to read. The
  icon comes from `simple-icons` (CC0-1.0, bundled, no network) when the catalogue carries the mark (VMware, Nutanix,
  Red Hat, Ubuntu, Kubernetes, Docker, Cisco, Fortinet, Palo Alto Networks, Dell, HP, NetApp, PostgreSQL, MongoDB,
  Google Cloud); Microsoft, Azure, AWS, Hyper-V, Oracle, Salesforce and ServiceNow withdrew their logos from that
  catalogue and appear as their names in a chip, which is nominative use. The icon keeps its brand colour.
- **Text stays HTML.** Nothing is lettered inside the canvas: the plane labels are DOM nodes positioned by
  projecting each plane's front corner through the camera, and they step aside while a plane is focused. The
  visibility list beside the scene is the legend (name, platforms, count, healthy / degraded / down, switch); hovering
  a row lights its plane and hovering a plane highlights its row; the row is also the keyboard path to focus. An
  `sr-only` plane list mirrors the scene for assistive technology and is what the e2e reads (`data-layer`,
  `data-visible`).
- **Model first.** `apps/console/src/lib/layer-stack-model.ts` is pure (plane positions, label anchors, equipment
  family, units, marks, the overview pose and the focus pose of any plane) and unit tested; the scene only draws it.
- **Motion.** Nothing moves on its own, so frames are rendered on demand (hover, toggle, orbit); the page's main
  thread stays free after the chunk loads. Materials are shared per tier, not created per mesh. Device pixel ratio
  is capped as in the twin.

## Consequences

- A new layer needs an equipment family in `LAYER_EQUIPMENT` and marks in `LAYER_MARKS`, enforced by the
  `Record<CiLayer, …>` types. A new vendor icon is a `simple-icons` slug; one the catalogue lacks is a name.
- `simple-icons` joins the component table as a bundled, licence-clean asset catalogue; it carries trademarks, so a
  mark is shown only beside the platform it names.
- The SVG `LayerStack` is removed; T-126 asserts the canvas and plane list, focusing a layer from its row (panel,
  `data-focused`) and Escape back, and that toggling a switch changes the plane's `data-visible`. The CMDB accepts
  `?layer=` so the focus panel can open it filtered.
