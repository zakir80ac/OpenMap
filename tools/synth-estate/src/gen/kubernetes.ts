// REQ-QA-001 — Kubernetes: on-premises RKE2 clusters on VM worker nodes plus AKS and EKS clusters
// on cloud resources, with system namespaces, workloads and services. Application generators add
// their own namespaces, workloads and services through the exported helpers.
import { SYNTH_ESTATE } from '@openmap/constants';
import { K8S_RUNTIME, K8S_VERSION, POOL } from '../catalog.js';
import type { Slot } from '../estate.js';
import { cidr, ip4, OCTET_MAX, RFC1918_TEN } from '../ip.js';
import type { Rng } from '../rng.js';
import { isoAt, MS_PER_DAY } from '../time.js';
import { pad, siteOf, type K8sClusterRec, type World } from '../world.js';
import { claimVm } from './claim.js';
import { addCloudResource } from './cloud.js';
import { renameVm } from './virtualization.js';

interface ClusterDef {
  name: string;
  site: string;
  environment: 'production' | 'nonprod';
  distribution: 'rke2' | 'aks' | 'eks';
}

const CLUSTER_DEFS: readonly ClusterDef[] = [
  { name: 'k8s-ryd-prod-01', site: 'RYD', environment: 'production', distribution: 'rke2' },
  { name: 'k8s-ryd-prod-02', site: 'RYD', environment: 'production', distribution: 'rke2' },
  { name: 'k8s-jed-dr-01', site: 'JED', environment: 'production', distribution: 'rke2' },
  { name: 'k8s-ryd-nonprod-01', site: 'RYD', environment: 'nonprod', distribution: 'rke2' },
  { name: 'aks-uaen-prod-01', site: 'AZ-UAEN', environment: 'production', distribution: 'aks' },
  { name: 'eks-mes1-prod-01', site: 'AWS-MES1', environment: 'production', distribution: 'eks' },
];

interface SystemWorkloadDef {
  namespace: string;
  name: string;
  kind: 'Deployment' | 'DaemonSet' | 'StatefulSet';
  replicas: number;
  image: string;
  service: { name: string; servicePort: number; type: 'ClusterIP' | 'LoadBalancer' } | null;
}

const SYSTEM_WORKLOADS: readonly SystemWorkloadDef[] = [
  { namespace: 'kube-system', name: 'coredns', kind: 'Deployment', replicas: 2, image: 'registry.k8s.io/coredns/coredns:v1.11.3', service: { name: 'kube-dns', servicePort: 53, type: 'ClusterIP' } },
  { namespace: 'kube-system', name: 'kube-proxy', kind: 'DaemonSet', replicas: 0, image: 'registry.k8s.io/kube-proxy:v1.30.5', service: null },
  { namespace: 'ingress-nginx', name: 'ingress-nginx-controller', kind: 'Deployment', replicas: 3, image: 'registry.k8s.io/ingress-nginx/controller:v1.11.2', service: { name: 'ingress-nginx-controller', servicePort: 443, type: 'LoadBalancer' } },
  { namespace: 'monitoring', name: 'prometheus-k8s', kind: 'StatefulSet', replicas: 2, image: 'quay.io/prometheus/prometheus:v2.54.1', service: { name: 'prometheus-k8s', servicePort: 9090, type: 'ClusterIP' } },
  { namespace: 'monitoring', name: 'node-exporter', kind: 'DaemonSet', replicas: 0, image: 'quay.io/prometheus/node-exporter:v1.8.2', service: null },
  { namespace: 'cert-manager', name: 'cert-manager', kind: 'Deployment', replicas: 1, image: 'quay.io/jetstack/cert-manager-controller:v1.15.3', service: null },
];

const CLUSTERS_BASE = 6;
const NODES_PER_CLUSTER_BASE = 8;
const NODES_MIN = 3;
const SERVICE_CIDR_PREFIX = 20;
const POD_CIDR_PREFIX = 16;
const MAX_POD_NODES = 3;
const CLUSTER_AGE_DAYS_MAX = 900;

const clusterNo = new WeakMap<K8sClusterRec, number>();
const nodeCursor = new WeakMap<K8sClusterRec, number>();

export function ensureNamespace(world: World, cluster: K8sClusterRec, name: string): number {
  const existing = cluster.namespaces.get(name);
  if (existing !== undefined) return existing;
  const idx = world.b.ci(cluster.slot, 'k8s_namespace', { clusterUid: cluster.clusterUid, name }, cluster.name + '/' + name, { name, cluster: cluster.name, phase: 'Active', labelsTeam: name.startsWith('kube-') || name === 'monitoring' || name === 'cert-manager' || name === 'ingress-nginx' ? 'platform' : 'application', podSecurity: 'restricted' }, cluster.site.def.code, { tags: ['kubernetes'] });
  world.b.rel(cluster.slot, 'contains', cluster.idx, idx);
  cluster.namespaces.set(name, idx);
  return idx;
}

export function addWorkload(world: World, rng: Rng, cluster: K8sClusterRec, namespace: string, name: string, kind: SystemWorkloadDef['kind'], replicas: number, image: string, app: string): number {
  const nsIdx = ensureNamespace(world, cluster, namespace);
  const uid = rng.uuid();
  const nodes = cluster.nodeIdx.length;
  const effectiveReplicas = kind === 'DaemonSet' ? nodes : replicas;
  const idx = world.b.ci(cluster.slot, 'k8s_workload', { uid }, namespace + '/' + name, { name, namespace, kind, replicas: effectiveReplicas, readyReplicas: effectiveReplicas, image, cluster: cluster.name, labelsApp: app, strategy: kind === 'Deployment' ? 'RollingUpdate' : null, createdAt: isoAt(-rng.int(1, CLUSTER_AGE_DAYS_MAX) * MS_PER_DAY) }, cluster.site.def.code, { tags: ['kubernetes', kind.toLowerCase()] });
  world.b.rel(cluster.slot, 'contains', nsIdx, idx);
  const spread = kind === 'DaemonSet' ? nodes : Math.min(nodes, Math.max(1, Math.min(MAX_POD_NODES, effectiveReplicas)));
  let cursor = nodeCursor.get(cluster) ?? 0;
  for (let i = 0; i < spread; i++) {
    const nodeIdx = cluster.nodeIdx[(cursor + i) % Math.max(1, nodes)];
    if (nodeIdx !== undefined) world.b.rel(cluster.slot, 'runs_on', idx, nodeIdx, { pods: kind === 'DaemonSet' ? 1 : Math.ceil(effectiveReplicas / spread) });
  }
  cursor += spread;
  nodeCursor.set(cluster, cursor);
  return idx;
}

export function addService(world: World, rng: Rng, cluster: K8sClusterRec, namespace: string, name: string, port: number, type: 'ClusterIP' | 'LoadBalancer', workloadIdx: number, app: string): number {
  const nsIdx = ensureNamespace(world, cluster, namespace);
  const uid = rng.uuid();
  const n = clusterNo.get(cluster) ?? 0;
  const svc = cluster.services;
  const clusterIp = ip4(RFC1918_TEN, cluster.site.def.octetBase + POOL.k8s, ((n * 16) + (svc >> 8)) & OCTET_MAX, (svc + 10) & OCTET_MAX);
  const idx = world.b.ci(cluster.slot, 'k8s_service', { uid }, namespace + '/' + name, { name, namespace, type, clusterIp, ports: [port], targetPort: port, protocol: 'TCP', selectorApp: app, cluster: cluster.name, sessionAffinity: 'None' }, cluster.site.def.code, { tags: ['kubernetes', 'service'] });
  world.b.rel(cluster.slot, 'contains', nsIdx, idx);
  // A Service depends on the workloads its selector matches, as the Kubernetes collector reports it.
  world.b.rel(cluster.slot, 'depends_on', idx, workloadIdx, { port, via: 'selector' });
  cluster.services++;
  return idx;
}

function clusterSlot(world: World, def: ClusterDef, siteNodeId: string, siteCode: string): Slot {
  return world.b.slotFor('k8s|' + def.name, {
    family: 'kubernetes',
    collectorId: 'kubernetes',
    nodeId: siteNodeId,
    siteCode,
    target: { kind: 'cluster', value: def.name, label: def.distribution + ' ' + def.environment },
    evidenceKind: 'api_response',
  });
}

export function generateKubernetes(world: World, rng: Rng): void {
  const { b } = world;
  world.k8sServiceBudget = b.count(SYNTH_ESTATE.k8sServices);
  const clusterCount = Math.min(CLUSTER_DEFS.length, b.count(CLUSTERS_BASE));
  CLUSTER_DEFS.slice(0, clusterCount).forEach((def, n) => {
    const site = siteOf(world, def.site);
    if (site.def.cloud && site.cloudAccountIdx < 0) return;
    const slot = clusterSlot(world, def, site.nodeId, site.def.code);
    const clusterUid = rng.uuid();
    const nodeCount = Math.max(NODES_MIN, b.count(NODES_PER_CLUSTER_BASE));
    const podCidr = cidr(RFC1918_TEN, site.def.octetBase + POOL.k8s, 0, 0, POD_CIDR_PREFIX);
    const serviceCidr = cidr(RFC1918_TEN, site.def.octetBase + POOL.k8s, (n * 16) & OCTET_MAX, 0, SERVICE_CIDR_PREFIX);
    const idx = b.ci(
      slot,
      'k8s_cluster',
      { clusterUid },
      def.name,
      { name: def.name, version: K8S_VERSION, containerRuntime: K8S_RUNTIME, distribution: def.distribution, environment: def.environment, nodeCount, podCidr, serviceCidr, cni: def.distribution === 'rke2' ? 'cilium' : def.distribution === 'aks' ? 'azure' : 'vpc-cni', apiEndpoint: def.name + '-api.' + site.def.code.toLowerCase() + '.bank.local', site: site.def.code, createdAt: isoAt(-rng.int(30, CLUSTER_AGE_DAYS_MAX) * MS_PER_DAY) },
      site.def.code,
      { tags: ['kubernetes', def.distribution], primary: true },
    );
    b.rel(slot, 'located_in', idx, site.ciIdx);
    const cluster: K8sClusterRec = { idx, name: def.name, clusterUid, site, slot, namespaces: new Map(), nodeIdx: [], services: 0 };
    clusterNo.set(cluster, n);

    if (site.def.cloud) {
      const managedType = def.distribution === 'aks' ? 'Microsoft.ContainerService/managedClusters' : 'AWS::EKS::Cluster';
      const managedIdx = addCloudResource(world, rng, site, managedType, def.name, { kubernetesVersion: K8S_VERSION, nodePools: 1 });
      b.rel(slot, 'hosted_on', idx, managedIdx);
      for (let i = 0; i < nodeCount; i++) {
        const nodeType = def.distribution === 'aks' ? 'Microsoft.Compute/virtualMachineScaleSets/virtualMachines' : 'AWS::EC2::Instance';
        const nodeIdx = addCloudResource(world, rng, site, nodeType, def.name + '-np1-' + pad(i, 2), { kubernetesVersion: K8S_VERSION, nodePool: 'np1', instanceType: def.distribution === 'aks' ? 'Standard_D8s_v5' : 'm6i.2xlarge' });
        b.rel(slot, 'member_of', nodeIdx, idx, { role: 'worker', pool: 'np1' });
        cluster.nodeIdx.push(nodeIdx);
      }
    } else {
      for (let i = 0; i < nodeCount; i++) {
        const vm = claimVm(site, 'linux') ?? claimVm(site, 'any');
        if (!vm) break;
        const role = i < NODES_MIN ? 'control-plane' : 'worker';
        renameVm(world, vm, def.name + (role === 'worker' ? '-w' : '-cp') + pad(i, 2), 'k8s-node');
        b.rel(slot, 'member_of', vm.idx, idx, { role, kubeletVersion: K8S_VERSION });
        cluster.nodeIdx.push(vm.idx);
      }
    }

    for (const wl of SYSTEM_WORKLOADS) {
      const workloadIdx = addWorkload(world, rng, cluster, wl.namespace, wl.name, wl.kind, wl.replicas, wl.image, wl.name);
      if (wl.service && world.k8sServiceBudget > 0) {
        addService(world, rng, cluster, wl.namespace, wl.service.name, wl.service.servicePort, wl.service.type, workloadIdx, wl.name);
        world.k8sServiceBudget--;
      }
    }
    world.k8sClusters.push(cluster);
    site.k8sClusters.push(cluster);
  });
}
