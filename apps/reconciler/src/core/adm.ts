// REQ-DEP-002 (ADR-029) — application dependency mapping, the pure half. What collectors observed is joined into
// dependencies: a flow (`communicates_with`, with the destination port, protocol, flow and byte counts) whose ends
// are addresses (the netflow collector), compute (an agent or a flow source that resolved its endpoints) or a
// listener; the compute that owns each address (`uses_ip`); the listener on the server side with its owning process
// (`listening_service`, `runs_on`); and the application components running on both sides. Every derived edge
// carries its evidence as attributes and a confidence by kind; the worker turns them into a collector result so they
// are persisted, versioned and fanned out like any observation. Deterministic: same input, same output, same order.
import { ADM } from '@openmap/constants';
import type { Attributes, CiType } from '@openmap/contracts';

export interface FlowEdge {
  /** The relationship's endpoints: ip_address, a compute CI, or a listening_service on the server side. */
  fromId: string;
  fromType: CiType;
  toId: string;
  toType: CiType;
  protocol: string;
  port: number;
  flows: number;
  bytes: number;
  packets: number;
  exporters: string[];
  /** The observation window (ISO instants). */
  firstSeen: string;
  lastSeen: string;
}

export interface Listener {
  id: string;
  /** The compute CI (via runs_on) the listener runs on. */
  computeId: string;
  protocol: string;
  port: number;
  process: string | null;
}

export interface Component {
  id: string;
  /** Compute CIs (via runs_on) the component runs on. */
  computeIds: string[];
  protocol: string | null;
  port: number | null;
  application: string | null;
}

export interface AdmInput {
  flows: FlowEdge[];
  /** ip_address id → address text, for the evidence. */
  addresses: Map<string, string>;
  /** ip_address id → compute CI ids that use it (uses_ip). */
  owners: Map<string, string[]>;
  /** compute id → display name, for the evidence. */
  computeNames: Map<string, string>;
  listeners: Listener[];
  components: Component[];
}

export type DerivationKind = 'listener' | 'compute' | 'component';

export interface DerivedDependency {
  fromId: string;
  toId: string;
  kind: DerivationKind;
  confidence: number;
  attributes: Attributes;
  observedAt: string;
}

interface Aggregate {
  fromId: string;
  toId: string;
  kind: DerivationKind;
  protocol: string;
  ports: Set<number>;
  flows: number;
  bytes: number;
  packets: number;
  exporters: Set<string>;
  clientAddresses: Set<string>;
  serverAddresses: Set<string>;
  processes: Set<string>;
  firstSeen: string;
  lastSeen: string;
  ambiguous: boolean;
}

/** Component protocols name the application protocol; flows name the transport. */
const PROTOCOL_ALIASES: Record<string, string> = { https: 'tcp', http: 'tcp', tls: 'tcp', grpc: 'tcp', amqp: 'tcp', kafka: 'tcp', dns: 'udp', syslog: 'udp', snmp: 'udp' };

const IP_TYPE: CiType = 'ip_address';
const LISTENER_TYPE: CiType = 'listening_service';

function key(fromId: string, toId: string, kind: DerivationKind, protocol: string): string {
  return fromId + '\u0000' + toId + '\u0000' + kind + '\u0000' + protocol;
}

function add(aggregates: Map<string, Aggregate>, fromId: string, toId: string, kind: DerivationKind, flow: FlowEdge, process: string | null, ambiguous: boolean, clientAddress: string | null, serverAddress: string | null): void {
  const k = key(fromId, toId, kind, flow.protocol);
  let a = aggregates.get(k);
  if (a === undefined) {
    a = { fromId, toId, kind, protocol: flow.protocol, ports: new Set(), flows: 0, bytes: 0, packets: 0, exporters: new Set(), clientAddresses: new Set(), serverAddresses: new Set(), processes: new Set(), firstSeen: flow.firstSeen, lastSeen: flow.lastSeen, ambiguous };
    aggregates.set(k, a);
  }
  a.ports.add(flow.port);
  a.flows += flow.flows;
  a.bytes += flow.bytes;
  a.packets += flow.packets;
  for (const x of flow.exporters) a.exporters.add(x);
  if (process !== null && process !== '') a.processes.add(process);
  if (clientAddress !== null) a.clientAddresses.add(clientAddress);
  if (serverAddress !== null) a.serverAddresses.add(serverAddress);
  if (flow.firstSeen < a.firstSeen) a.firstSeen = flow.firstSeen;
  if (flow.lastSeen > a.lastSeen) a.lastSeen = flow.lastSeen;
  a.ambiguous = a.ambiguous || ambiguous;
}

function confidenceOf(kind: DerivationKind, ambiguous: boolean): number {
  switch (kind) {
    case 'listener':
      return ADM.confidence.listener;
    case 'compute':
      return ADM.confidence.compute;
    case 'component':
      return ambiguous ? ADM.confidence.ambiguousComponent : ADM.confidence.component;
  }
}

function sorted(values: ReadonlySet<string>): string[] {
  return [...values].sort();
}

function protocolMatches(component: Component, flow: FlowEdge): boolean {
  return component.protocol === null || component.protocol === flow.protocol || PROTOCOL_ALIASES[component.protocol] === flow.protocol;
}

/** The server side of a flow: the compute and, when known, the listener the flow reaches. */
interface ServerSide {
  computeId: string;
  listener: Listener | null;
}

/**
 * Joins flows, address owners, listeners and components into `depends_on` edges:
 * - client compute → server listener when the server runs a listener on the flow's protocol and port (or the flow
 *   already names the listener);
 * - client compute → server compute when it does not (the port is still recorded);
 * - client component → server component when a component on the server side serves that port and the client side
 *   runs a component (every client component when there are several, marked ambiguous with a lower confidence).
 * Flows whose addresses no compute owns, self-flows and flows under ADM.minFlows derive nothing.
 */
export function deriveDependencies(input: AdmInput): DerivedDependency[] {
  const listenersById = new Map(input.listeners.map((l) => [l.id, l]));
  const listenersByCompute = new Map<string, Listener[]>();
  for (const l of input.listeners) {
    const list = listenersByCompute.get(l.computeId) ?? [];
    list.push(l);
    listenersByCompute.set(l.computeId, list);
  }
  const componentsByCompute = new Map<string, Component[]>();
  for (const c of input.components)
    for (const computeId of c.computeIds) {
      const list = componentsByCompute.get(computeId) ?? [];
      list.push(c);
      componentsByCompute.set(computeId, list);
    }

  const clientsOf = (flow: FlowEdge): string[] => (flow.fromType === IP_TYPE ? (input.owners.get(flow.fromId) ?? []) : flow.fromType === LISTENER_TYPE ? [] : [flow.fromId]);
  const serversOf = (flow: FlowEdge): ServerSide[] => {
    if (flow.toType === LISTENER_TYPE) {
      const listener = listenersById.get(flow.toId);
      return listener === undefined ? [] : [{ computeId: listener.computeId, listener }];
    }
    const computes = flow.toType === IP_TYPE ? (input.owners.get(flow.toId) ?? []) : [flow.toId];
    return computes.map((computeId) => ({ computeId, listener: (listenersByCompute.get(computeId) ?? []).find((l) => l.protocol === flow.protocol && l.port === flow.port) ?? null }));
  };

  const aggregates = new Map<string, Aggregate>();
  const ordered = [...input.flows].sort((a, b) => a.fromId.localeCompare(b.fromId) || a.toId.localeCompare(b.toId) || a.port - b.port);
  for (const flow of ordered) {
    if (flow.flows < ADM.minFlows) continue;
    const clients = clientsOf(flow);
    const servers = serversOf(flow);
    if (clients.length === 0 || servers.length === 0) continue;
    const clientAddress = flow.fromType === IP_TYPE ? (input.addresses.get(flow.fromId) ?? flow.fromId) : null;
    const serverAddress = flow.toType === IP_TYPE ? (input.addresses.get(flow.toId) ?? flow.toId) : null;
    for (const client of clients) {
      for (const server of servers) {
        if (client === server.computeId) continue;
        const target = server.listener === null ? server.computeId : server.listener.id;
        const kind: DerivationKind = server.listener === null ? 'compute' : 'listener';
        const process = server.listener?.process ?? null;
        add(aggregates, client, target, kind, flow, process, false, clientAddress, serverAddress);
        const serverComponents = (componentsByCompute.get(server.computeId) ?? []).filter((c) => c.port === flow.port && protocolMatches(c, flow));
        const clientComponents = componentsByCompute.get(client) ?? [];
        if (serverComponents.length === 0 || clientComponents.length === 0) continue;
        const ambiguous = clientComponents.length > 1;
        for (const from of clientComponents)
          for (const to of serverComponents) {
            if (from.id === to.id) continue;
            add(aggregates, from.id, to.id, 'component', flow, process, ambiguous, clientAddress, serverAddress);
          }
      }
    }
  }

  const out: DerivedDependency[] = [];
  for (const a of aggregates.values()) {
    const confidence = confidenceOf(a.kind, a.ambiguous);
    const attributes: Attributes = {
      [ADM.derivedFromKey]: ADM.derivedFromFlows,
      kind: a.kind,
      protocol: a.protocol,
      ports: [...a.ports].sort((x, y) => x - y),
      flows: a.flows,
      bytes: a.bytes,
      packets: a.packets,
      exporters: sorted(a.exporters),
      clientAddresses: sorted(a.clientAddresses),
      serverAddresses: sorted(a.serverAddresses),
      processes: sorted(a.processes),
      firstSeen: a.firstSeen,
      lastSeen: a.lastSeen,
      ambiguous: a.ambiguous,
      confidence,
    };
    out.push({ fromId: a.fromId, toId: a.toId, kind: a.kind, confidence, attributes, observedAt: a.lastSeen });
  }
  return out.sort((x, y) => x.fromId.localeCompare(y.fromId) || x.toId.localeCompare(y.toId) || x.kind.localeCompare(y.kind) || String(x.attributes['protocol']).localeCompare(String(y.attributes['protocol'])));
}

/** Stable identity of a derived edge for retirement: the previous pass's edge with the same endpoints and type is kept. */
export function edgeKey(fromId: string, toId: string): string {
  return fromId + '\u0000' + toId;
}
