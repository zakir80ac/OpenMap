// REQ-QA-005 REQ-DISC-011 — simulated Kubernetes API servers: one per cluster, each on its own HTTPS listener,
// bearer-token authentication (401 Status objects otherwise), cluster-wide lists of namespaces, nodes,
// Deployments, ReplicaSets, StatefulSets, DaemonSets, pods, Services and Ingresses with limit/continue
// paging when a limit is asked for, and /version.
//
//   - The estate cluster (an upstream-conformant RKE2 cluster) is rendered from the estate's kubernetes result:
//     namespaces (kube-system carries the estate cluster UID, the usual cluster-identity convention), the VMs
//     that are member_of the cluster as nodes, workloads with their images and app labels, services with their
//     app selectors, and one pod per estate runs_on placement (pods attribute) with running containerd
//     containers. Deployments own their pods through a ReplicaSet; DaemonSet pods use the host network.
//   - An OpenShift-flavoured cluster is GENERATED here (the estate has none): a deterministic OpenShift 4.16
//     cluster with openshift-* namespaces, RHCOS master and worker nodes on CRI-O, platform operands, an
//     application namespace and config.openshift.io ClusterVersion. Expectations come from that same set.
package kubernetes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	keyEstate     = "estate"
	keyOpenShift  = "openshift"
	rsHashLen     = 10
	podHashLen    = 5
	containerHash = 64
	digestHash    = 64
	// podNet is the third-octet offset of pod addresses inside the pod CIDR, clear of the service range.
	podNet       = 64
	podsPerOctet = 250
	ocpVersion   = "4.16.21"
	ocpGit       = "v1.29.10+67d3387"
	ocpRuntime   = "cri-o://1.29.10-3.rhaos4.16.git7db3a6d.el9"
	ocpOS        = "Red Hat Enterprise Linux CoreOS 416.94.202410211619-0"
	ocpKernel    = "5.14.0-427.42.1.el9_4.x86_64"
	ocpDomain    = "ocp-sim-01.sim.bank.local"
	ocpName      = "ocp-sim-01"
	ocpPodPrefix = "10.128"
	ocpNodeNet   = "10.242.0."
	ocpNodeBase  = 20
	ocpMasters   = 3
	ocpWorkers   = 3
	ocpRelease   = "quay.io/openshift-release-dev/ocp-v4.0-art-dev@sha256:"
	defaultKern  = "6.8.0-45-generic"
	nodeCPU      = "8"
	nodeMemory   = "65842536Ki"
	nodePods     = "110"
)

type Vendor struct{}

func (Vendor) ID() string             { return "kubernetes-apiserver" }
func (Vendor) Collector() string      { return "kubernetes" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-011"} }

func hexOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func uuidOf(s string) string {
	h := hexOf(s)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

type kns struct {
	name, uid string
	labels    map[string]string
	identity  map[string]string
}

type knode struct {
	name, ip, osImage, kubelet, uuid, kernel string
	roles                                    []string
}

type placement struct {
	node string
	pods int
}

type kwl struct {
	name, ns, kind, uid, app, image string
	replicas                        int
	placements                      []placement
	identity                        map[string]string
}

type ksvc struct {
	name, ns, uid, typ, clusterIP, protocol, selector string
	port, targetPort                                  int
	identity                                          map[string]string
	backs                                             []*kwl
}

type kpod struct {
	name, ns, uid, node, ip, containerID string
	owner                                *kwl
	ownerKind, ownerName, ownerUID       string
	container                            string
}

type kcluster struct {
	key, name, uid, gitVersion, runtime, podPrefix string
	openshift                                      bool
	identity                                       map[string]string
	namespaces                                     []*kns
	nodes                                          []*knode
	workloads                                      []*kwl
	services                                       []*ksvc
	pods                                           []*kpod
}

func containerName(image string) string {
	ref := image
	if i := strings.Index(ref, "@"); i >= 0 {
		ref = ref[:i]
	}
	if i := strings.LastIndex(ref, "/"); i >= 0 {
		ref = ref[i+1:]
	}
	if i := strings.Index(ref, ":"); i >= 0 {
		ref = ref[:i]
	}
	return ref
}

func rsName(w *kwl) string { return w.name + "-" + hexOf("rs/" + w.uid)[:rsHashLen] }

// pods derives one pod per placement slot: ReplicaSet-hashed names for Deployments, ordinals for
// StatefulSets, node-hashed names for DaemonSets; DaemonSets use the host network.
func (k *kcluster) derivePods() {
	nodeIP := map[string]string{}
	for _, n := range k.nodes {
		nodeIP[n.name] = n.ip
	}
	seq := 0
	for _, w := range k.workloads {
		ordinal := 0
		for _, p := range w.placements {
			for i := 0; i < p.pods; i++ {
				pod := &kpod{ns: w.ns, node: p.node, owner: w, container: containerName(w.image)}
				switch w.kind {
				case "Deployment":
					pod.name = rsName(w) + "-" + hexOf(w.uid + "/" + p.node + "/" + strconv.Itoa(i))[:podHashLen]
					pod.ownerKind, pod.ownerName, pod.ownerUID = "ReplicaSet", rsName(w), uuidOf("rs/"+w.uid)
				case "StatefulSet":
					pod.name = w.name + "-" + strconv.Itoa(ordinal)
					pod.ownerKind, pod.ownerName, pod.ownerUID = w.kind, w.name, w.uid
				default:
					pod.name = w.name + "-" + hexOf(w.uid + "/" + p.node)[:podHashLen]
					pod.ownerKind, pod.ownerName, pod.ownerUID = w.kind, w.name, w.uid
				}
				ordinal++
				pod.uid = uuidOf("pod/" + k.key + "/" + w.ns + "/" + pod.name)
				pod.containerID = "containerd://" + hexOf("container/" + pod.uid)[:containerHash]
				if k.openshift {
					pod.containerID = "cri-o://" + hexOf("container/" + pod.uid)[:containerHash]
				}
				if w.kind == "DaemonSet" {
					pod.ip = nodeIP[p.node]
				} else {
					pod.ip = k.podPrefix + "." + strconv.Itoa(podNet+seq/podsPerOctet) + "." + strconv.Itoa(1+seq%podsPerOctet)
					seq++
				}
				k.pods = append(k.pods, pod)
			}
		}
	}
}

func fromEstate(e *estate.Estate) []*kcluster {
	var out []*kcluster
	for i, c := range e.OfType("k8s_cluster", nil) {
		k := &kcluster{key: keyEstate, name: c.Name, uid: c.ID("clusterUid"), identity: c.Identity, runtime: c.Str("containerRuntime")}
		if i > 0 {
			k.key = keyEstate + "-" + strconv.Itoa(i)
		}
		k.gitVersion = c.Str("version")
		if d := c.Str("distribution"); d == "rke2" {
			k.gitVersion += "+rke2r1"
		}
		if pod := c.Str("podCidr"); pod != "" {
			parts := strings.Split(strings.Split(pod, "/")[0], ".")
			if len(parts) == 4 {
				k.podPrefix = parts[0] + "." + parts[1]
			}
		}
		for _, ns := range e.From(c, "contains") {
			if ns.Type != "k8s_namespace" {
				continue
			}
			n := &kns{name: ns.ID("name"), identity: ns.Identity, labels: map[string]string{"kubernetes.io/metadata.name": ns.ID("name")}}
			n.uid = uuidOf("ns/" + k.uid + "/" + n.name)
			if n.name == "kube-system" {
				n.uid = k.uid
			}
			if t := ns.Str("labelsTeam"); t != "" {
				n.labels["team"] = t
			}
			k.namespaces = append(k.namespaces, n)
			for _, child := range e.From(ns, "contains") {
				switch child.Type {
				case "k8s_workload":
					w := &kwl{name: child.Str("name"), ns: n.name, kind: child.Str("kind"), uid: child.ID("uid"), app: child.Str("labelsApp"), image: child.Str("image"), replicas: int(child.Num("replicas", 1)), identity: child.Identity}
					for _, r := range e.Rels {
						if r.Type == "runs_on" && r.From.Type == "k8s_workload" && r.From.Identity["uid"] == w.uid {
							pods := 1
							if v, ok := r.Attributes["pods"].(float64); ok {
								pods = int(v)
							}
							w.placements = append(w.placements, placement{node: strings.ToLower(r.To.Identity["fqdn"]), pods: pods})
						}
					}
					k.workloads = append(k.workloads, w)
				case "k8s_service":
					s := &ksvc{name: child.Str("name"), ns: n.name, uid: child.ID("uid"), typ: child.Str("type"), clusterIP: child.Str("clusterIp"), protocol: child.Str("protocol"),
						selector: child.Str("selectorApp"), port: int(child.Num("targetPort", 0)), targetPort: int(child.Num("targetPort", 0)), identity: child.Identity}
					if ports := child.Attributes["ports"]; ports != nil {
						if arr, ok := ports.([]any); ok && len(arr) > 0 {
							if p, ok := arr[0].(float64); ok {
								s.port = int(p)
							}
						}
					}
					k.services = append(k.services, s)
				}
			}
		}
		// Every cluster has these namespaces; the estate does not list them.
		for _, name := range []string{"default", "kube-public", "kube-node-lease"} {
			k.namespaces = append(k.namespaces, &kns{name: name, uid: uuidOf("ns/" + k.uid + "/" + name), labels: map[string]string{"kubernetes.io/metadata.name": name}})
		}
		for _, r := range e.Rels {
			if r.Type != "member_of" || r.To.Type != "k8s_cluster" || r.To.Identity["clusterUid"] != k.uid {
				continue
			}
			vm := e.Resolve(r.From)
			fqdn := strings.ToLower(r.From.Identity["fqdn"])
			node := &knode{name: fqdn, uuid: r.From.Identity["instanceUuid"], kernel: defaultKern}
			if s, ok := r.Attributes["kubeletVersion"].(string); ok {
				node.kubelet = s
			}
			if s, ok := r.Attributes["role"].(string); ok && s == "control-plane" {
				node.roles = []string{"control-plane", "etcd", "master"}
			} else {
				node.roles = []string{"worker"}
			}
			if vm != nil {
				node.ip = vm.Str("ipAddress")
				node.osImage = vm.Str("guestOs")
				if strings.HasPrefix(node.osImage, "Ubuntu") {
					node.osImage += " LTS"
				}
			}
			k.nodes = append(k.nodes, node)
		}
		for _, s := range k.services {
			for _, r := range e.Rels {
				if r.Type == "depends_on" && r.From.Type == "k8s_service" && r.From.Identity["uid"] == s.uid {
					for _, w := range k.workloads {
						if w.uid == r.To.Identity["uid"] {
							s.backs = append(s.backs, w)
						}
					}
				}
			}
		}
		k.derivePods()
		out = append(out, k)
	}
	return out
}

// openShift generates the OpenShift-flavoured cluster.
func openShift() *kcluster {
	k := &kcluster{key: keyOpenShift, name: ocpName, gitVersion: ocpGit, runtime: ocpRuntime, openshift: true, podPrefix: ocpPodPrefix}
	k.uid = uuidOf("ocp/" + ocpName + "/kube-system")
	k.identity = map[string]string{"clusterUid": k.uid}
	for _, name := range []string{"default", "kube-system", "kube-public", "openshift", "openshift-apiserver", "openshift-dns", "openshift-ingress", "openshift-image-registry", "openshift-monitoring", "payments"} {
		uid := uuidOf("ocp/" + ocpName + "/ns/" + name)
		if name == "kube-system" {
			uid = k.uid
		}
		labels := map[string]string{"kubernetes.io/metadata.name": name}
		if strings.HasPrefix(name, "openshift") {
			labels["openshift.io/cluster-monitoring"] = "true"
		}
		k.namespaces = append(k.namespaces, &kns{name: name, uid: uid, labels: labels, identity: map[string]string{"clusterUid": k.uid, "name": name}})
	}
	var masters, workers []string
	for i := 0; i < ocpMasters+ocpWorkers; i++ {
		role, idx := "master", i
		if i >= ocpMasters {
			role, idx = "worker", i-ocpMasters
		}
		name := role + "-" + strconv.Itoa(idx) + "." + ocpDomain
		roles := []string{role}
		if role == "master" {
			roles = []string{"control-plane", "master"}
			masters = append(masters, name)
		} else {
			workers = append(workers, name)
		}
		k.nodes = append(k.nodes, &knode{name: name, ip: ocpNodeNet + strconv.Itoa(ocpNodeBase+i), osImage: ocpOS, kubelet: strings.Split(ocpGit, "+")[0] + "+" + hexOf(name)[:7], uuid: uuidOf("ocp/node/" + name), kernel: ocpKernel, roles: roles})
	}
	all := append(append([]string{}, masters...), workers...)
	spread := func(nodes []string, total int) []placement {
		counts := map[string]int{}
		for i := 0; i < total; i++ {
			counts[nodes[i%len(nodes)]]++
		}
		var out []placement
		for _, n := range nodes {
			if counts[n] > 0 {
				out = append(out, placement{node: n, pods: counts[n]})
			}
		}
		return out
	}
	release := func(component string) string { return ocpRelease + hexOf("ocp-release/" + component)[:digestHash] }
	add := func(ns, name, kind, app, image string, replicas int, nodes []string) *kwl {
		w := &kwl{name: name, ns: ns, kind: kind, uid: uuidOf("ocp/wl/" + ns + "/" + name), app: app, image: image, replicas: replicas}
		w.identity = map[string]string{"uid": w.uid}
		if kind == "DaemonSet" {
			w.placements = spread(nodes, len(nodes))
		} else {
			w.placements = spread(nodes, replicas)
		}
		k.workloads = append(k.workloads, w)
		return w
	}
	apiserver := add("openshift-apiserver", "apiserver", "Deployment", "openshift-apiserver-a", release("openshift-apiserver"), ocpMasters, masters)
	router := add("openshift-ingress", "router-default", "Deployment", "router-default", release("haproxy-router"), 2, workers)
	dns := add("openshift-dns", "dns-default", "DaemonSet", "dns-default", release("coredns"), len(all), all)
	prom := add("openshift-monitoring", "prometheus-k8s", "StatefulSet", "prometheus-k8s", release("prometheus"), 2, workers)
	registry := add("openshift-image-registry", "image-registry", "Deployment", "image-registry", release("docker-registry"), 1, workers)
	payments := add("payments", "payments-api", "Deployment", "payments-api", "image-registry.openshift-image-registry.svc:5000/payments/api:2.4.1", ocpWorkers, workers)
	svc := func(ns, name, typ, ip string, port, target int, backs *kwl) {
		s := &ksvc{name: name, ns: ns, uid: uuidOf("ocp/svc/" + ns + "/" + name), typ: typ, clusterIP: ip, protocol: "TCP", selector: backs.app, port: port, targetPort: target, backs: []*kwl{backs}}
		s.identity = map[string]string{"uid": s.uid}
		k.services = append(k.services, s)
	}
	svc("openshift-apiserver", "api", "ClusterIP", "172.30.0.20", 443, 8443, apiserver)
	svc("openshift-ingress", "router-internal-default", "ClusterIP", "172.30.0.30", 443, 443, router)
	svc("openshift-dns", "dns-default", "ClusterIP", "172.30.0.10", 53, 5353, dns)
	svc("openshift-monitoring", "prometheus-k8s", "ClusterIP", "172.30.0.40", 9091, 9091, prom)
	svc("openshift-image-registry", "image-registry", "ClusterIP", "172.30.0.50", 5000, 5000, registry)
	svc("payments", "payments-api", "ClusterIP", "172.30.0.60", 8443, 8443, payments)
	k.derivePods()
	return k
}

func clusters(e *estate.Estate) []*kcluster {
	return append(fromEstate(e), openShift())
}

func objectMeta(name, ns, uid string, labels map[string]string) map[string]any {
	m := map[string]any{"name": name, "uid": uid, "resourceVersion": strconv.Itoa(len(name) + len(uid)), "creationTimestamp": "2025-07-05T00:00:00Z"}
	if ns != "" {
		m["namespace"] = ns
	}
	if labels != nil {
		m["labels"] = labels
	}
	return m
}

func (k *kcluster) namespacesDoc() []any {
	out := []any{}
	for _, n := range k.namespaces {
		out = append(out, map[string]any{"metadata": objectMeta(n.name, "", n.uid, n.labels), "spec": map[string]any{"finalizers": []string{"kubernetes"}}, "status": map[string]any{"phase": "Active"}})
	}
	return out
}

func (k *kcluster) nodesDoc() []any {
	out := []any{}
	for _, n := range k.nodes {
		labels := map[string]string{"kubernetes.io/hostname": n.name, "kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64"}
		for _, r := range n.roles {
			labels["node-role.kubernetes.io/"+r] = "true"
		}
		if k.openshift {
			labels["node.openshift.io/os_id"] = "rhcos"
		}
		out = append(out, map[string]any{
			"metadata": objectMeta(n.name, "", uuidOf("node/"+k.key+"/"+n.name), labels),
			"spec":     map[string]any{"podCIDR": k.podPrefix + ".0.0/24"},
			"status": map[string]any{
				"addresses":  []any{map[string]any{"type": "InternalIP", "address": n.ip}, map[string]any{"type": "Hostname", "address": n.name}},
				"capacity":   map[string]any{"cpu": nodeCPU, "memory": nodeMemory, "pods": nodePods},
				"conditions": []any{map[string]any{"type": "Ready", "status": "True", "reason": "KubeletReady"}},
				"nodeInfo": map[string]any{"machineID": hexOf("machine/" + n.name)[:32], "systemUUID": n.uuid, "bootID": uuidOf("boot/" + n.name), "kernelVersion": n.kernel,
					"osImage": n.osImage, "containerRuntimeVersion": k.runtime, "kubeletVersion": n.kubelet, "kubeProxyVersion": n.kubelet, "operatingSystem": "linux", "architecture": "amd64"},
			},
		})
	}
	return out
}

func (k *kcluster) workloadsDoc(kind string) []any {
	out := []any{}
	for _, w := range k.workloads {
		if w.kind != kind {
			continue
		}
		labels := map[string]string{"app": w.app}
		spec := map[string]any{
			"selector": map[string]any{"matchLabels": labels},
			"template": map[string]any{"metadata": map[string]any{"labels": labels}, "spec": map[string]any{"containers": []any{map[string]any{"name": containerName(w.image), "image": w.image}}}},
		}
		pods := 0
		for _, p := range w.placements {
			pods += p.pods
		}
		status := map[string]any{"observedGeneration": 1}
		switch kind {
		case "DaemonSet":
			status["desiredNumberScheduled"], status["numberReady"], status["currentNumberScheduled"] = pods, pods, pods
			spec["template"].(map[string]any)["spec"].(map[string]any)["hostNetwork"] = true
		default:
			spec["replicas"] = w.replicas
			status["replicas"], status["readyReplicas"], status["availableReplicas"] = pods, pods, pods
		}
		if kind == "StatefulSet" {
			spec["serviceName"] = w.name
		}
		out = append(out, map[string]any{"metadata": objectMeta(w.name, w.ns, w.uid, labels), "spec": spec, "status": status})
	}
	return out
}

func (k *kcluster) replicaSetsDoc() []any {
	out := []any{}
	for _, w := range k.workloads {
		if w.kind != "Deployment" {
			continue
		}
		meta := objectMeta(rsName(w), w.ns, uuidOf("rs/"+w.uid), map[string]string{"app": w.app})
		meta["ownerReferences"] = []any{map[string]any{"apiVersion": "apps/v1", "kind": "Deployment", "name": w.name, "uid": w.uid, "controller": true, "blockOwnerDeletion": true}}
		out = append(out, map[string]any{"metadata": meta, "spec": map[string]any{"replicas": w.replicas}, "status": map[string]any{"replicas": w.replicas, "readyReplicas": w.replicas}})
	}
	return out
}

func (k *kcluster) podsDoc() []any {
	out := []any{}
	for _, p := range k.pods {
		meta := objectMeta(p.name, p.ns, p.uid, map[string]string{"app": p.owner.app})
		meta["ownerReferences"] = []any{map[string]any{"apiVersion": "apps/v1", "kind": p.ownerKind, "name": p.ownerName, "uid": p.ownerUID, "controller": true, "blockOwnerDeletion": true}}
		image := p.owner.image
		imageID := image
		if !strings.Contains(image, "@") {
			repo := image
			if i := strings.LastIndex(repo, ":"); i > strings.LastIndex(repo, "/") {
				repo = repo[:i]
			}
			imageID = repo + "@sha256:" + hexOf("digest/" + image)[:digestHash]
		}
		started := true
		spec := map[string]any{"nodeName": p.node, "containers": []any{map[string]any{"name": p.container, "image": image}}}
		if p.owner.kind == "DaemonSet" {
			spec["hostNetwork"] = true
		}
		out = append(out, map[string]any{"metadata": meta, "spec": spec, "status": map[string]any{
			"phase": "Running", "podIP": p.ip, "podIPs": []any{map[string]any{"ip": p.ip}}, "qosClass": "Burstable",
			"containerStatuses": []any{map[string]any{"name": p.container, "containerID": p.containerID, "image": image, "imageID": imageID, "ready": true, "restartCount": 0, "started": started,
				"state": map[string]any{"running": map[string]any{"startedAt": "2026-10-01T00:00:00Z"}}}},
		}})
	}
	return out
}

func (k *kcluster) servicesDoc() []any {
	out := []any{}
	for _, s := range k.services {
		spec := map[string]any{"type": s.typ, "clusterIP": s.clusterIP, "clusterIPs": []string{s.clusterIP}, "sessionAffinity": "None",
			"ports": []any{map[string]any{"name": strings.ToLower(s.protocol) + "-" + strconv.Itoa(s.port), "port": s.port, "targetPort": s.targetPort, "protocol": s.protocol}}}
		if s.selector != "" {
			spec["selector"] = map[string]string{"app": s.selector}
		}
		out = append(out, map[string]any{"metadata": objectMeta(s.name, s.ns, s.uid, nil), "spec": spec, "status": map[string]any{"loadBalancer": map[string]any{}}})
	}
	return out
}

func (k *kcluster) list(path string) (string, []any, bool) {
	switch path {
	case "/api/v1/namespaces":
		return "NamespaceList", k.namespacesDoc(), true
	case "/api/v1/nodes":
		return "NodeList", k.nodesDoc(), true
	case "/api/v1/pods":
		return "PodList", k.podsDoc(), true
	case "/api/v1/services":
		return "ServiceList", k.servicesDoc(), true
	case "/apis/apps/v1/deployments":
		return "DeploymentList", k.workloadsDoc("Deployment"), true
	case "/apis/apps/v1/statefulsets":
		return "StatefulSetList", k.workloadsDoc("StatefulSet"), true
	case "/apis/apps/v1/daemonsets":
		return "DaemonSetList", k.workloadsDoc("DaemonSet"), true
	case "/apis/apps/v1/replicasets":
		return "ReplicaSetList", k.replicaSetsDoc(), true
	case "/apis/networking.k8s.io/v1/ingresses":
		return "IngressList", []any{}, true
	}
	if k.openshift && path == "/apis/config.openshift.io/v1/clusterversions" {
		return "ClusterVersionList", []any{map[string]any{"apiVersion": "config.openshift.io/v1", "kind": "ClusterVersion", "metadata": objectMeta("version", "", uuidOf("ocp/clusterversion"), nil),
			"spec":   map[string]any{"channel": "stable-4.16", "clusterID": uuidOf("ocp/cluster-id/" + k.name)},
			"status": map[string]any{"desired": map[string]any{"version": ocpVersion}, "history": []any{map[string]any{"state": "Completed", "version": ocpVersion}}}}}, true
	}
	return "", nil, false
}

func status(w http.ResponseWriter, code int, reason, msg string) {
	sim.WriteJSON(w, code, map[string]any{"kind": "Status", "apiVersion": "v1", "metadata": map[string]any{}, "status": "Failure", "message": msg, "reason": reason, "code": code})
}

func (k *kcluster) handler(token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !sim.BearerOK(r, token) {
			status(w, http.StatusUnauthorized, "Unauthorized", "Unauthorized")
			return
		}
		if r.Method != http.MethodGet {
			status(w, http.StatusMethodNotAllowed, "MethodNotAllowed", "the simulator serves reads only")
			return
		}
		if r.URL.Path == "/version" {
			major, minor := "1", ""
			if parts := strings.SplitN(strings.TrimPrefix(k.gitVersion, "v"), ".", 3); len(parts) >= 2 {
				major, minor = parts[0], parts[1]
			}
			sim.WriteJSON(w, http.StatusOK, map[string]any{"major": major, "minor": minor, "gitVersion": k.gitVersion, "gitTreeState": "clean", "goVersion": "go1.22.7", "compiler": "gc", "platform": "linux/amd64"})
			return
		}
		kind, items, ok := k.list(r.URL.Path)
		if !ok {
			status(w, http.StatusNotFound, "NotFound", "the server could not find the requested resource")
			return
		}
		meta := map[string]any{"resourceVersion": strconv.Itoa(len(items))}
		if limit, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && limit > 0 {
			offset, _ := strconv.Atoi(r.URL.Query().Get("continue"))
			offset = min(max(offset, 0), len(items))
			end := min(offset+limit, len(items))
			if end < len(items) {
				meta["continue"] = strconv.Itoa(end)
				meta["remainingItemCount"] = len(items) - end
			}
			items = items[offset:end]
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"kind": kind, "apiVersion": "v1", "metadata": meta, "items": items})
	})
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	byKey := map[string]*kcluster{}
	keys := []string{}
	for _, k := range clusters(e) {
		byKey[k.key] = k
		keys = append(keys, k.key)
	}
	return sim.ServeEach(env, keys, true, func(key string) http.Handler { return byKey[key].handler(env.Secret) })
}

func registryOf(image string) string {
	first, _, found := strings.Cut(image, "/")
	if found && (strings.ContainsAny(first, ".:") || first == "localhost") {
		return first
	}
	return "docker.io"
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	var runs []sim.Run
	for _, k := range clusters(e) {
		run := sim.Run{
			Name:           k.name,
			Targets:        []sim.Target{{Kind: "url", Value: ep.Devices[k.key], Label: k.name}},
			Options:        map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM, "clusterName": k.name},
			CredentialType: "api_token",
			Credential:     &sim.Credential{Type: "api_token", Fields: map[string]string{"token": env.Secret}},
		}
		x := &run.Expect
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "k8s_cluster", Name: k.name, Identity: k.identity})
		for _, n := range k.namespaces {
			// The collector names a namespace by its own name; the estate prefixes the cluster name.
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "k8s_namespace", Name: n.name, Identity: n.identity})
			x.Rel("contains", "k8s_cluster", k.name, "k8s_namespace", n.name)
		}
		for _, n := range k.nodes {
			// Nodes are hosts to the collector; the estate models the same machines as VMs.
			x.CI("host", n.name)
			x.Rel("member_of", "host", n.name, "k8s_cluster", k.name)
			if n.osImage != "" {
				x.CI("operating_system", n.osImage)
				x.Rel("installed_on", "operating_system", n.osImage, "host", n.name)
			}
			if n.ip != "" {
				x.CI("ip_address", n.ip)
				x.Rel("uses_ip", "host", n.name, "ip_address", n.ip)
			}
		}
		registries := map[string]bool{}
		for _, w := range k.workloads {
			// The collector names a workload by its own name; the estate prefixes the namespace.
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "k8s_workload", Name: w.name, Identity: w.identity})
			x.Rel("contains", "k8s_namespace", w.ns, "k8s_workload", w.name)
			reg := registryOf(w.image)
			if !registries[reg] {
				registries[reg] = true
				x.CI("container_registry", reg)
			}
			x.Rel("backed_by", "k8s_workload", w.name, "container_registry", reg)
		}
		for _, s := range k.services {
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "k8s_service", Name: s.name, Identity: s.identity})
			x.Rel("contains", "k8s_namespace", s.ns, "k8s_service", s.name)
			// The service depends on the workloads its selector matches (estate and collector alike).
			for _, w := range s.backs {
				x.Rel("depends_on", "k8s_service", s.name, "k8s_workload", w.name)
			}
		}
		sort.SliceStable(k.pods, func(i, j int) bool { return k.pods[i].name < k.pods[j].name })
		for _, p := range k.pods {
			name := p.name + "/" + p.container
			x.CI("container", name)
			x.Rel("runs_on", "container", name, "host", p.node)
			x.Rel("member_of", "container", name, "k8s_workload", p.owner.name)
		}
		runs = append(runs, run)
	}
	return runs
}
