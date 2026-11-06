// REQ-DISC-011 — Kubernetes / OpenShift collector over the API server: cluster, namespaces, nodes
// (as hosts with their OS), Deployments / StatefulSets / DaemonSets as workloads, running
// containers with image provenance, Services with selector-resolved dependencies, Ingress hosts
// and the registries images are pulled from. One target = one API server.
package kubernetes

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID     = "kubernetes"
	version         = "0.1.0"
	defaultPort     = 6443
	optionVerify    = "verifyTls"
	optionCA        = "caCertPem"
	optionName      = "clusterName"
	credTypeToken   = "api_token"
	credFieldToken  = "token"
	credUser        = "username"
	credPassword    = "password"
	evidenceKind    = "api_response"
	systemNs        = "kube-system"
	defaultRegistry = "docker.io"

	typeCluster   = "k8s_cluster"
	typeNamespace = "k8s_namespace"
	typeWorkload  = "k8s_workload"
	typeService   = "k8s_service"
	typeContainer = "container"
	typeRegistry  = "container_registry"
	typeHost      = "host"
	typeOS        = "operating_system"
	typeIP        = "ip_address"

	relContains    = "contains"
	relMemberOf    = "member_of"
	relRunsOn      = "runs_on"
	relDependsOn   = "depends_on"
	relInstalledOn = "installed_on"
	relUsesIP      = "uses_ip"
	relBackedBy    = "backed_by"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "kubernetes", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{credTypeToken, "password"},
		TargetKinds: []string{"host", "url"}, Emits: []string{typeCluster, typeNamespace, typeWorkload, typeService, typeContainer, typeRegistry, typeHost, typeOS, typeIP},
		ContractVersion: contract.Version,
	}
}

type meta struct {
	Name            string            `json:"name"`
	Namespace       string            `json:"namespace"`
	UID             string            `json:"uid"`
	Labels          map[string]string `json:"labels"`
	Annotations     map[string]string `json:"annotations"`
	OwnerReferences []struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
		UID  string `json:"uid"`
	} `json:"ownerReferences"`
}

type list[T any] struct {
	Items []T `json:"items"`
}

type versionDoc struct {
	GitVersion string `json:"gitVersion"`
	Platform   string `json:"platform"`
}

type namespaceDoc struct {
	Metadata meta `json:"metadata"`
	Status   struct {
		Phase string `json:"phase"`
	} `json:"status"`
}

type nodeDoc struct {
	Metadata meta `json:"metadata"`
	Spec     struct {
		ProviderID string `json:"providerID"`
	} `json:"spec"`
	Status struct {
		NodeInfo struct {
			MachineID               string `json:"machineID"`
			SystemUUID              string `json:"systemUUID"`
			KubeletVersion          string `json:"kubeletVersion"`
			OSImage                 string `json:"osImage"`
			KernelVersion           string `json:"kernelVersion"`
			ContainerRuntimeVersion string `json:"containerRuntimeVersion"`
			Architecture            string `json:"architecture"`
			OperatingSystem         string `json:"operatingSystem"`
		} `json:"nodeInfo"`
		Addresses []struct {
			Type    string `json:"type"`
			Address string `json:"address"`
		} `json:"addresses"`
		Capacity   map[string]string `json:"capacity"`
		Conditions []struct {
			Type   string `json:"type"`
			Status string `json:"status"`
		} `json:"conditions"`
	} `json:"status"`
}

type containerSpec struct {
	Name  string `json:"name"`
	Image string `json:"image"`
}

type workloadDoc struct {
	Metadata meta `json:"metadata"`
	Spec     struct {
		Replicas *int `json:"replicas"`
		Template struct {
			Metadata meta `json:"metadata"`
			Spec     struct {
				Containers []containerSpec `json:"containers"`
			} `json:"spec"`
		} `json:"template"`
	} `json:"spec"`
	Status struct {
		ReadyReplicas          int `json:"readyReplicas"`
		AvailableReplicas      int `json:"availableReplicas"`
		NumberReady            int `json:"numberReady"`
		DesiredNumberScheduled int `json:"desiredNumberScheduled"`
	} `json:"status"`
}

type replicaSetDoc struct {
	Metadata meta `json:"metadata"`
}

type podDoc struct {
	Metadata meta `json:"metadata"`
	Spec     struct {
		NodeName   string          `json:"nodeName"`
		Containers []containerSpec `json:"containers"`
	} `json:"spec"`
	Status struct {
		Phase             string `json:"phase"`
		PodIP             string `json:"podIP"`
		ContainerStatuses []struct {
			Name         string `json:"name"`
			ContainerID  string `json:"containerID"`
			Image        string `json:"image"`
			ImageID      string `json:"imageID"`
			Ready        bool   `json:"ready"`
			RestartCount int    `json:"restartCount"`
			Started      *bool  `json:"started"`
		} `json:"containerStatuses"`
	} `json:"status"`
}

type serviceDoc struct {
	Metadata meta `json:"metadata"`
	Spec     struct {
		Type      string            `json:"type"`
		ClusterIP string            `json:"clusterIP"`
		Selector  map[string]string `json:"selector"`
		Ports     []struct {
			Name       string `json:"name"`
			Port       int    `json:"port"`
			TargetPort any    `json:"targetPort"`
			Protocol   string `json:"protocol"`
			NodePort   int    `json:"nodePort"`
		} `json:"ports"`
		ExternalIPs []string `json:"externalIPs"`
	} `json:"spec"`
	Status struct {
		LoadBalancer struct {
			Ingress []struct {
				IP       string `json:"ip"`
				Hostname string `json:"hostname"`
			} `json:"ingress"`
		} `json:"loadBalancer"`
	} `json:"status"`
}

type ingressDoc struct {
	Metadata meta `json:"metadata"`
	Spec     struct {
		Rules []struct {
			Host string `json:"host"`
			HTTP struct {
				Paths []struct {
					Path    string `json:"path"`
					Backend struct {
						Service struct {
							Name string `json:"name"`
						} `json:"service"`
					} `json:"backend"`
				} `json:"paths"`
			} `json:"http"`
		} `json:"rules"`
	} `json:"spec"`
}

// Inventory is one cluster's content as gathered by Walk.
type Inventory struct {
	Version     versionDoc
	Namespaces  []namespaceDoc
	Nodes       []nodeDoc
	Workloads   []workloadDoc // kind recorded in Kinds, parallel slice
	Kinds       []string
	ReplicaSets []replicaSetDoc
	Pods        []podDoc
	Services    []serviceDoc
	Ingresses   []ingressDoc
	Raw         [][]byte
}

// Walk reads the cluster-wide lists. Ingress and ReplicaSet lists are optional (RBAC may hide them).
func Walk(ctx context.Context, c *restjson.Client) (*Inventory, error) {
	inv := &Inventory{}
	if err := c.Get(ctx, "/version", &inv.Version); err != nil {
		return nil, err
	}
	var ns list[namespaceDoc]
	if err := c.Get(ctx, "/api/v1/namespaces", &ns); err != nil {
		return nil, err
	}
	inv.Namespaces = ns.Items
	var nodes list[nodeDoc]
	if err := c.Get(ctx, "/api/v1/nodes", &nodes); err != nil {
		return nil, err
	}
	inv.Nodes = nodes.Items
	for _, kind := range []struct{ kind, path string }{{"Deployment", "/apis/apps/v1/deployments"}, {"StatefulSet", "/apis/apps/v1/statefulsets"}, {"DaemonSet", "/apis/apps/v1/daemonsets"}} {
		var wl list[workloadDoc]
		if err := c.Get(ctx, kind.path, &wl); err != nil {
			return nil, err
		}
		for _, w := range wl.Items {
			inv.Workloads = append(inv.Workloads, w)
			inv.Kinds = append(inv.Kinds, kind.kind)
		}
	}
	var rs list[replicaSetDoc]
	if err := c.Get(ctx, "/apis/apps/v1/replicasets", &rs); err == nil {
		inv.ReplicaSets = rs.Items
	}
	var pods list[podDoc]
	if err := c.Get(ctx, "/api/v1/pods", &pods); err != nil {
		return nil, err
	}
	inv.Pods = pods.Items
	var svcs list[serviceDoc]
	if err := c.Get(ctx, "/api/v1/services", &svcs); err != nil {
		return nil, err
	}
	inv.Services = svcs.Items
	var ing list[ingressDoc]
	if err := c.Get(ctx, "/apis/networking.k8s.io/v1/ingresses", &ing); err == nil {
		inv.Ingresses = ing.Items
	}
	inv.Raw = c.Raw()
	return inv, nil
}

// registryOf returns the registry host of an image reference ("ghcr.io/org/app:1" → "ghcr.io").
func registryOf(image string) string {
	first := image
	if i := strings.Index(image, "/"); i >= 0 {
		first = image[:i]
	} else {
		return defaultRegistry
	}
	if strings.ContainsAny(first, ".:") || first == "localhost" {
		return first
	}
	return defaultRegistry
}

func matches(selector, labels map[string]string) bool {
	if len(selector) == 0 {
		return false
	}
	for k, v := range selector {
		if labels[k] != v {
			return false
		}
	}
	return true
}

func clusterUID(inv *Inventory) string {
	for _, ns := range inv.Namespaces {
		if ns.Metadata.Name == systemNs {
			return ns.Metadata.UID
		}
	}
	if len(inv.Namespaces) > 0 {
		return inv.Namespaces[0].Metadata.UID
	}
	return ""
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, clusterName string, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, raw := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: raw})
	}
	uid := clusterUID(inv)
	if uid == "" {
		uid = target.Value
	}
	if clusterName == "" {
		clusterName = target.Value
	}
	clusterRef := contract.CiRef{Type: typeCluster, Identity: map[string]string{"clusterUid": uid}}
	ready := 0
	for _, n := range inv.Nodes {
		for _, c := range n.Status.Conditions {
			if c.Type == "Ready" && c.Status == "True" {
				ready++
			}
		}
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeCluster, Identity: clusterRef.Identity, Name: clusterName,
		Attributes: map[string]any{"apiServer": target.Value, "version": inv.Version.GitVersion, "platform": inv.Version.Platform, "nodeCount": len(inv.Nodes), "nodesReady": ready, "namespaceCount": len(inv.Namespaces), "podCount": len(inv.Pods), "distribution": distribution(inv)},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: uid}}, ObservedAt: at})

	nsRef := map[string]contract.CiRef{}
	for _, ns := range inv.Namespaces {
		identity := map[string]string{"clusterUid": uid, "name": ns.Metadata.Name}
		nsRef[ns.Metadata.Name] = contract.CiRef{Type: typeNamespace, Identity: identity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeNamespace, Identity: identity, Name: ns.Metadata.Name, Attributes: map[string]any{"phase": ns.Status.Phase, "labels": ns.Metadata.Labels, "uid": ns.Metadata.UID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: ns.Metadata.UID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: clusterRef, To: nsRef[ns.Metadata.Name], Attributes: map[string]any{}, ObservedAt: at})
	}

	nodeRef := map[string]contract.CiRef{}
	for _, n := range inv.Nodes {
		info := n.Status.NodeInfo
		identity := map[string]string{"fqdn": n.Metadata.Name}
		if info.SystemUUID != "" {
			identity["systemUuid"] = strings.ToLower(info.SystemUUID)
		}
		var internalIP string
		for _, a := range n.Status.Addresses {
			if a.Type == "InternalIP" && internalIP == "" {
				internalIP = a.Address
			}
		}
		roles := []string{}
		for k := range n.Metadata.Labels {
			if strings.HasPrefix(k, "node-role.kubernetes.io/") {
				roles = append(roles, strings.TrimPrefix(k, "node-role.kubernetes.io/"))
			}
		}
		sort.Strings(roles)
		ref := contract.CiRef{Type: typeHost, Identity: identity}
		nodeRef[n.Metadata.Name] = ref
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHost, Identity: identity, Name: n.Metadata.Name,
			Attributes: map[string]any{"kubeletVersion": info.KubeletVersion, "osImage": info.OSImage, "kernelVersion": info.KernelVersion, "containerRuntime": info.ContainerRuntimeVersion, "architecture": info.Architecture, "providerId": n.Spec.ProviderID, "machineId": info.MachineID, "internalIp": internalIP, "cpuCapacity": n.Status.Capacity["cpu"], "memoryCapacity": n.Status.Capacity["memory"], "podCapacity": n.Status.Capacity["pods"], "roles": roles, "k8sCluster": clusterName},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: n.Metadata.UID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: clusterRef, Attributes: map[string]any{"roles": roles}, ObservedAt: at})
		if info.OSImage != "" {
			hostRef := identity["systemUuid"]
			if hostRef == "" {
				hostRef = n.Metadata.Name
			}
			osIdentity := map[string]string{"hostRef": hostRef, "family": strings.ToLower(firstNonEmpty(info.OperatingSystem, "linux")), "version": info.OSImage}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: info.OSImage, Attributes: map[string]any{"kernelVersion": info.KernelVersion, "architecture": info.Architecture, "source": "kubelet"}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalledOn, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: ref, Attributes: map[string]any{}, ObservedAt: at})
		}
		if internalIP != "" {
			ipIdentity := map[string]string{"address": internalIP, "vrfRef": "default"}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: internalIP, Attributes: map[string]any{"assignedTo": n.Metadata.Name, "role": "node"}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: ref, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
		}
	}

	registries := map[string]contract.CiRef{}
	registry := func(image string) contract.CiRef {
		host := registryOf(image)
		if ref, ok := registries[host]; ok {
			return ref
		}
		identity := map[string]string{"url": "https://" + host}
		ref := contract.CiRef{Type: typeRegistry, Identity: identity}
		registries[host] = ref
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeRegistry, Identity: identity, Name: host, Attributes: map[string]any{"host": host, "discoveredFrom": clusterName}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		return ref
	}

	workloadRef := map[string]contract.CiRef{}   // uid → ref
	workloadByKey := map[string]contract.CiRef{} // ns/kind/name → ref
	workloadLabels := map[string]map[string]string{}
	for i, w := range inv.Workloads {
		kind := inv.Kinds[i]
		identity := map[string]string{"uid": w.Metadata.UID}
		ref := contract.CiRef{Type: typeWorkload, Identity: identity}
		workloadRef[w.Metadata.UID] = ref
		workloadByKey[w.Metadata.Namespace+"/"+kind+"/"+w.Metadata.Name] = ref
		workloadLabels[w.Metadata.UID] = w.Spec.Template.Metadata.Labels
		images := []string{}
		for _, c := range w.Spec.Template.Spec.Containers {
			images = append(images, c.Image)
		}
		desired := 0
		if w.Spec.Replicas != nil {
			desired = *w.Spec.Replicas
		} else if kind == "DaemonSet" {
			desired = w.Status.DesiredNumberScheduled
		}
		readyN := w.Status.ReadyReplicas
		if kind == "DaemonSet" {
			readyN = w.Status.NumberReady
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeWorkload, Identity: identity, Name: w.Metadata.Name,
			Attributes: map[string]any{"kind": kind, "namespace": w.Metadata.Namespace, "replicasDesired": desired, "replicasReady": readyN, "images": images, "labels": w.Metadata.Labels, "k8sCluster": clusterName},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: w.Metadata.UID}}, ObservedAt: at})
		if ns, ok := nsRef[w.Metadata.Namespace]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: ns, To: ref, Attributes: map[string]any{}, ObservedAt: at})
		}
		for _, img := range images {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relBackedBy, From: ref, To: registry(img), Attributes: map[string]any{"image": img}, ObservedAt: at})
		}
	}
	rsOwner := map[string]string{} // replicaset uid → deployment uid
	for _, rs := range inv.ReplicaSets {
		for _, o := range rs.Metadata.OwnerReferences {
			if o.Kind == "Deployment" {
				rsOwner[rs.Metadata.UID] = o.UID
			}
		}
	}
	podOwner := func(p podDoc) (contract.CiRef, bool) {
		for _, o := range p.Metadata.OwnerReferences {
			switch o.Kind {
			case "ReplicaSet":
				if dep, ok := rsOwner[o.UID]; ok {
					if ref, ok := workloadRef[dep]; ok {
						return ref, true
					}
				}
			case "StatefulSet", "DaemonSet", "Deployment":
				if ref, ok := workloadRef[o.UID]; ok {
					return ref, true
				}
			}
		}
		return contract.CiRef{}, false
	}
	podsOfWorkload := map[string][]podDoc{}
	for _, p := range inv.Pods {
		owner, hasOwner := podOwner(p)
		if hasOwner {
			podsOfWorkload[owner.Identity["uid"]] = append(podsOfWorkload[owner.Identity["uid"]], p)
		}
		node, hasNode := nodeRef[p.Spec.NodeName]
		for _, cs := range p.Status.ContainerStatuses {
			if cs.ContainerID == "" {
				continue
			}
			identity := map[string]string{"containerId": cs.ContainerID}
			ref := contract.CiRef{Type: typeContainer, Identity: identity}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeContainer, Identity: identity, Name: p.Metadata.Name + "/" + cs.Name,
				Attributes: map[string]any{"pod": p.Metadata.Name, "namespace": p.Metadata.Namespace, "container": cs.Name, "image": cs.Image, "imageId": cs.ImageID, "ready": cs.Ready, "restartCount": cs.RestartCount, "phase": p.Status.Phase, "node": p.Spec.NodeName, "podIp": p.Status.PodIP, "k8sCluster": clusterName},
				Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: p.Metadata.UID + "/" + cs.Name}}, ObservedAt: at})
			if hasNode {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: ref, To: node, Attributes: map[string]any{}, ObservedAt: at})
			}
			if hasOwner {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: owner, Attributes: map[string]any{"pod": p.Metadata.Name}, ObservedAt: at})
			}
			if p.Status.PodIP != "" {
				ipIdentity := map[string]string{"address": p.Status.PodIP, "vrfRef": "k8s:" + uid}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: p.Status.PodIP, Attributes: map[string]any{"assignedTo": p.Metadata.Name, "role": "pod", "namespace": p.Metadata.Namespace}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: ref, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
			}
		}
	}

	ingressHosts := map[string][]string{} // ns/service → hosts
	for _, ing := range inv.Ingresses {
		for _, r := range ing.Spec.Rules {
			for _, p := range r.HTTP.Paths {
				key := ing.Metadata.Namespace + "/" + p.Backend.Service.Name
				ingressHosts[key] = append(ingressHosts[key], r.Host+p.Path)
			}
		}
	}
	for _, s := range inv.Services {
		identity := map[string]string{"uid": s.Metadata.UID}
		ref := contract.CiRef{Type: typeService, Identity: identity}
		ports := []map[string]any{}
		for _, p := range s.Spec.Ports {
			ports = append(ports, map[string]any{"name": p.Name, "port": p.Port, "targetPort": p.TargetPort, "protocol": p.Protocol, "nodePort": p.NodePort})
		}
		external := append([]string{}, s.Spec.ExternalIPs...)
		for _, i := range s.Status.LoadBalancer.Ingress {
			external = append(external, firstNonEmpty(i.IP, i.Hostname))
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeService, Identity: identity, Name: s.Metadata.Name,
			Attributes: map[string]any{"namespace": s.Metadata.Namespace, "serviceType": s.Spec.Type, "clusterIp": s.Spec.ClusterIP, "ports": ports, "selector": s.Spec.Selector, "externalEndpoints": external, "ingressHosts": ingressHosts[s.Metadata.Namespace+"/"+s.Metadata.Name], "k8sCluster": clusterName},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: s.Metadata.UID}}, ObservedAt: at})
		if ns, ok := nsRef[s.Metadata.Namespace]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: ns, To: ref, Attributes: map[string]any{}, ObservedAt: at})
		}
		linked := map[string]bool{}
		for wlUID, labels := range workloadLabels {
			wl := workloadRef[wlUID]
			if inv.workloadNamespace(wlUID) != s.Metadata.Namespace {
				continue
			}
			if matches(s.Spec.Selector, labels) && !linked[wlUID] {
				linked[wlUID] = true
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relDependsOn, From: ref, To: wl, Attributes: map[string]any{"via": "selector"}, ObservedAt: at})
			}
		}
		// Pods without a template match (e.g. bare pods) still count when their labels match.
		for wlUID, pods := range podsOfWorkload {
			if linked[wlUID] {
				continue
			}
			for _, p := range pods {
				if p.Metadata.Namespace == s.Metadata.Namespace && matches(s.Spec.Selector, p.Metadata.Labels) {
					linked[wlUID] = true
					obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relDependsOn, From: ref, To: workloadRef[wlUID], Attributes: map[string]any{"via": "pod-labels"}, ObservedAt: at})
					break
				}
			}
		}
	}
	return obs
}

func (inv *Inventory) workloadNamespace(uid string) string {
	for _, w := range inv.Workloads {
		if w.Metadata.UID == uid {
			return w.Metadata.Namespace
		}
	}
	return ""
}

func distribution(inv *Inventory) string {
	for _, ns := range inv.Namespaces {
		if strings.HasPrefix(ns.Metadata.Name, "openshift-") {
			return "openshift"
		}
	}
	for _, n := range inv.Nodes {
		switch {
		case strings.HasPrefix(n.Spec.ProviderID, "aws://"):
			return "eks-or-self-managed-aws"
		case strings.HasPrefix(n.Spec.ProviderID, "azure://"):
			return "aks-or-self-managed-azure"
		case strings.HasPrefix(n.Spec.ProviderID, "gce://"):
			return "gke-or-self-managed-gcp"
		case strings.HasPrefix(n.Spec.ProviderID, "kind://"):
			return "kind"
		}
	}
	if strings.Contains(inv.Version.GitVersion, "k3s") {
		return "k3s"
	}
	return "kubernetes"
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	if cred == nil {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "kubernetes requires an api_token or password credential")
	}
	auth := restjson.Auth{}
	switch cred.Type {
	case credTypeToken:
		auth.Bearer = cred.Fields[credFieldToken]
	case credPassword:
		auth.User, auth.Pass = cred.Fields[credUser], cred.Fields[credPassword]
	default:
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "credential type %q is not usable against the API server", cred.Type)
	}
	if auth.Bearer == "" && auth.User == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "credential carries no token or username")
	}
	c, err := restjson.New(target.Value, defaultPort, auth, restjson.Options{VerifyTLS: restjson.BoolOption(options, optionVerify), CAPem: restjson.StringOption(options, optionCA)})
	if err != nil {
		return collector.Observation{}, err
	}
	inv, err := Walk(ctx, c)
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	return Emit(inv, target, restjson.StringOption(options, optionName), time.Now().UTC()), nil
}
