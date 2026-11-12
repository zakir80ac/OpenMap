# Digital twin drill-down (REQ-UI-037)

Captured 2026-11-12 on the dev compose stack with the synthetic estate (seed 42, scale 0.05: 4 rooms, 101 racks,
2,235 devices).

## What an operator can do

- **Open a rack** in the 3D scene, or from the "Open a rack" picker in the side panel (the same rack for the keyboard
  and screen readers). The camera flies to the open rack; its glass lets clicks through to the devices inside.
- **Pick a device** in the rack (in the scene or the rack's list) and drill down. Each level lists, from the CMDB's
  relationships in both directions:

  | Section | What it holds |
  | --- | --- |
  | Hardware components | The parts collectors reported (processors, memory, drives, adapters, power supplies) and related hardware (BMC, chassis) |
  | Compute | The hypervisor, VMs, containers and clusters it carries or runs on |
  | Operating system | The OS installed on it |
  | Databases | Databases and clusters hosted on it |
  | Applications and software | Applications, components, listening services and installed software |
  | Business services supported | Services linked directly and those the upstream impact walk reaches, with the hop count |
  | Network | Interfaces, ports, IP addresses, subnets, VLANs, switches, load balancers |
  | Storage | LUNs, arrays, zoning and backup policies |
  | Security | Its CVEs (CVSS, exploited, internet-facing), firewall rules and objects, certificates |
  | Vendor, support and contracts | Vendor, support contracts and licences |
  | Power and location | Rack, PDUs, power feeds and circuits |

- **Drill further** from any neighbour (server › OS › installed software, server › hypervisor › VM › application…);
  the breadcrumb returns to any level, each level opens its CI in the CMDB or focuses the dependency layers on it.

## Screens

| | English | Arabic (RTL) |
| --- | --- | --- |
| A racked server: its parts, OS, software, network, services and place | `console/twin-drill-server-en.png` | `console/twin-drill-server-ar.png` |
| One level down: the server's operating system, camera on the open rack | `console/twin-drill-os-en.png` | `console/twin-drill-os-ar.png` |

## Tests

- T-660 (`apps/console/src/lib/twin-drill.test.ts`): the grouping of neighbours into sections, both directions,
  duplicates, services from the walk, ordering.
- T-661 (`apps/console/src/components/twin/TwinView.test.tsx`): rack → device (selected in the scene too) → sections →
  hypervisor → breadcrumb back to the rack; the rack picker without the scene; en and ar.
- T-662 (`apps/console/e2e/twin-drill.spec.ts`): on the real stack, a racked host that supports a business service is
  drilled into, its sections are present, its OS is drilled into, and the breadcrumb returns; en and ar.

## Performance on the way

- Racks and devices are drawn as one `InstancedMesh` each, filled imperatively, instead of one React component per box:
  the twin's total blocking time went from 120 ms to 30 ms on the dev host (Lighthouse 1.0), and the scene no longer
  builds tens of thousands of components at full scale.
- `Card` (`packages/ui`) now forwards ARIA attributes: labels given to cards across the console (this panel, the
  dashboard's editing bar, the service SLA and uptime panels) were silently dropped before.

No contract changed: the drill-down reads `ci { components vulnerabilities relationships }` and the upstream `impact`
query, both already in GraphQL.
