// REQ-DISC-011 — turns one Docker Engine inventory into contract observations: the engine as a host
// with its operating system, every container (runs_on the engine), the registries pulled images came
// from (container backed_by registry), the engine's IPAM subnets and the container addresses in them.
package docker

import (
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	typeHost      = "host"
	typeOS        = "operating_system"
	typeContainer = "container"
	typeRegistry  = "container_registry"
	typeSubnet    = "subnet"
	typeIP        = "ip_address"

	relRunsOn      = "runs_on"
	relInstalledOn = "installed_on"
	relBackedBy    = "backed_by"
	relUsesIP      = "uses_ip"
	relInSubnet    = "in_subnet"

	// Same container identity the Kubernetes collector derives from a docker:// containerID, so a
	// container seen through both the engine and the kubelet is one CI.
	containerIDScheme = "docker://"
	// Docker Hub references carry no registry host; the Kubernetes collector names it the same way.
	defaultRegistry = "docker.io"
	registryScheme  = "https://"
	// Engine-local address space: bridge networks overlap across engines (172.17.0.0/16 everywhere),
	// so subnets and addresses are scoped to the engine ID.
	vrfPrefix = "docker:"
	// Image references that are only a digest (the tag was removed after the container started).
	imageIDPrefix = "sha256:"
	// Compose project and service labels, surfaced as plain attributes.
	labelComposeProject = "com.docker.compose.project"
	labelComposeService = "com.docker.compose.service"
)

// Label keys that may carry credentials are never copied into attributes.
var secretLabelKey = regexp.MustCompile(`(?i)(pass(word|wd|phrase)|secret|token|api[-_.]?key|private[-_.]?key|credential)`)

// RegistryOf returns the registry host of an image reference ("ghcr.io/org/app:1" → "ghcr.io").
func RegistryOf(ref string) string {
	if host, ok := explicitRegistry(ref); ok {
		return host
	}
	return defaultRegistry
}

// explicitRegistry reports the registry host when the reference names one ("quay.io/x", "localhost:5000/x").
func explicitRegistry(ref string) (string, bool) {
	first, _, found := strings.Cut(ref, "/")
	if found && (strings.ContainsAny(first, ".:") || first == "localhost") {
		return first, true
	}
	return "", false
}

// Where an image came from, as far as the engine can tell.
const (
	imageFromRegistry   = "registry"         // a repo digest proves the pull (classic store) or names its registry host
	imageAssumed        = "registry-assumed" // containerd store, implicit Docker Hub reference, no local-build marker
	imageLocal          = "local"            // built or loaded locally
	imageUnknown        = "unknown"          // the image is no longer on the engine
	containerdStoreType = "io.containerd.snapshotter.v1"
	driverTypeKey       = "driver-type"
)

// ContainerdStore reports whether the engine keeps images in the containerd image store.
func ContainerdStore(info InfoDoc) bool {
	for _, kv := range info.DriverStatus {
		if len(kv) == 2 && kv[0] == driverTypeKey && kv[1] == containerdStoreType {
			return true
		}
	}
	return false
}

// ImageRegistries returns the registries an image was pulled from and how sure that is. The classic
// image store sets repo digests only on pull (or push), so a digest proves the registry. The containerd
// image store gives every image a repo digest, locally built ones included: there an explicit registry
// host is trusted, an image Compose built (it carries the compose project label) is local, and any other
// implicit Docker Hub reference is assumed pulled (a plain `docker build` tag is indistinguishable).
func ImageRegistries(img ImageDoc, containerdStore bool) ([]string, string) {
	if len(img.RepoDigests) == 0 || (containerdStore && img.Labels[labelComposeProject] != "") {
		return nil, imageLocal
	}
	hosts := []string{}
	seen := map[string]bool{}
	source := imageFromRegistry
	digests := append([]string{}, img.RepoDigests...)
	sort.Strings(digests)
	for _, d := range digests {
		name, _, _ := strings.Cut(d, "@")
		host, explicit := explicitRegistry(name)
		if !explicit {
			host = defaultRegistry
			if containerdStore {
				source = imageAssumed
			}
		}
		if !seen[host] {
			seen[host] = true
			hosts = append(hosts, host)
		}
	}
	return hosts, source
}

// PortStrings renders published and exposed ports as "ip:public->private/proto" or "private/proto".
func PortStrings(ports []PortDoc) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, p := range ports {
		s := strconv.Itoa(p.PrivatePort) + "/" + p.Type
		if p.PublicPort > 0 {
			s = net.JoinHostPort(p.IP, strconv.Itoa(p.PublicPort)) + "->" + s
		}
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// LabelStrings renders labels as sorted "key=value" strings, dropping keys that look like credentials.
func LabelStrings(labels map[string]string) []string {
	out := []string{}
	for k, v := range labels {
		if secretLabelKey.MatchString(k) {
			continue
		}
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

// MountStrings renders mounts as "type:source->destination:rw|ro" (volume mounts use the volume name).
func MountStrings(mounts []MountDoc) []string {
	out := []string{}
	for _, m := range mounts {
		source := m.Source
		if m.Type == "volume" && m.Name != "" {
			source = m.Name
		}
		mode := "ro"
		if m.RW {
			mode = "rw"
		}
		out = append(out, m.Type+":"+source+"->"+m.Destination+":"+mode)
	}
	sort.Strings(out)
	return out
}

func containerName(c ContainerDoc) string {
	if len(c.Names) > 0 {
		return strings.TrimPrefix(c.Names[0], "/")
	}
	return c.ID
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, raw := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: raw})
	}
	info := inv.Info
	engineName := firstNonEmpty(info.Name, target.Value)
	hostIdentity := map[string]string{"fqdn": engineName}
	hostRef := contract.CiRef{Type: typeHost, Identity: hostIdentity}
	vrf := vrfPrefix + firstNonEmpty(info.ID, engineName)

	volumes := []string{}
	for _, v := range inv.Volumes {
		volumes = append(volumes, v.Name)
	}
	sort.Strings(volumes)
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHost, Identity: hostIdentity, Name: engineName,
		Attributes: map[string]any{
			"role": "container-engine", "engineEndpoint": target.Value, "dockerEngineId": info.ID, "dockerVersion": firstNonEmpty(info.ServerVersion, inv.Version.Version),
			"apiVersion": inv.APIVersion, "engineApiVersion": inv.Version.APIVersion, "platform": inv.Version.Platform.Name, "operatingSystem": info.OperatingSystem,
			"osType": info.OSType, "kernelVersion": info.KernelVersion, "architecture": info.Architecture, "cpuCount": info.NCPU, "memoryBytes": info.MemTotal,
			"storageDriver": info.Driver, "defaultRuntime": info.DefaultRuntime, "cgroupDriver": info.CgroupDriver, "cgroupVersion": info.CgroupVersion,
			"containersTotal": info.Containers, "containersRunning": info.ContainersRunning, "containersPaused": info.ContainersPaused, "containersStopped": info.ContainersStopped,
			"imageCount": info.Images, "swarmState": info.Swarm.LocalNodeState, "containerdImageStore": ContainerdStore(info), "volumes": volumes, "volumeCount": len(volumes), "engineLabels": append([]string{}, info.Labels...),
		},
		Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: info.ID}}, ObservedAt: at})
	if info.OperatingSystem != "" {
		osIdentity := map[string]string{"hostRef": engineName, "family": strings.ToLower(firstNonEmpty(info.OSType, inv.Version.Os)), "version": info.OperatingSystem}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: info.OperatingSystem, Attributes: map[string]any{"kernelVersion": info.KernelVersion, "architecture": info.Architecture, "osVersion": info.OSVersion, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalledOn, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: hostRef, Attributes: map[string]any{}, ObservedAt: at})
	}

	// Subnets of the engine's networks (host / none networks have no IPAM pool).
	type subnet struct {
		ipnet *net.IPNet
		ref   contract.CiRef
	}
	var subnets []subnet
	networkNames := map[string]string{}
	networks := append([]NetworkDoc{}, inv.Networks...)
	sort.Slice(networks, func(i, j int) bool { return networks[i].Name < networks[j].Name })
	for _, n := range networks {
		networkNames[n.ID] = n.Name
		for _, cfg := range n.IPAM.Config {
			_, ipnet, err := net.ParseCIDR(cfg.Subnet)
			if err != nil {
				continue
			}
			identity := map[string]string{"cidr": ipnet.String(), "vrfRef": vrf}
			ref := contract.CiRef{Type: typeSubnet, Identity: identity}
			subnets = append(subnets, subnet{ipnet: ipnet, ref: ref})
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeSubnet, Identity: identity, Name: n.Name + " " + ipnet.String(),
				Attributes: map[string]any{"network": n.Name, "networkId": n.ID, "driver": n.Driver, "scope": n.Scope, "internal": n.Internal, "gateway": cfg.Gateway, "engine": engineName, "source": collectorID},
				Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: n.ID}}, ObservedAt: at})
		}
	}
	subnetOf := func(ip net.IP) (contract.CiRef, bool) {
		for _, s := range subnets {
			if s.ipnet.Contains(ip) {
				return s.ref, true
			}
		}
		return contract.CiRef{}, false
	}

	containerdStore := ContainerdStore(info)
	images := map[string]ImageDoc{}
	for _, img := range inv.Images {
		images[img.ID] = img
	}
	registries := map[string]contract.CiRef{}
	registry := func(host string) contract.CiRef {
		if ref, ok := registries[host]; ok {
			return ref
		}
		identity := map[string]string{"url": registryScheme + host}
		ref := contract.CiRef{Type: typeRegistry, Identity: identity}
		registries[host] = ref
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeRegistry, Identity: identity, Name: host, Attributes: map[string]any{"host": host, "discoveredFrom": engineName}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		return ref
	}

	containers := append([]ContainerDoc{}, inv.Containers...)
	sort.Slice(containers, func(i, j int) bool { return containerName(containers[i]) < containerName(containers[j]) })
	for _, c := range containers {
		identity := map[string]string{"containerId": containerIDScheme + c.ID}
		ref := contract.CiRef{Type: typeContainer, Identity: identity}
		img, known := images[c.ImageID]
		imageRef := c.Image
		if strings.HasPrefix(imageRef, imageIDPrefix) && known && len(img.RepoTags) > 0 {
			imageRef = img.RepoTags[0]
		}
		netNames := []string{}
		addresses := []string{}
		for name, ep := range c.NetworkSettings.Networks {
			netNames = append(netNames, name)
			for _, a := range []string{ep.IPAddress, ep.GlobalIPv6Address} {
				if a != "" {
					addresses = append(addresses, a)
				}
			}
		}
		sort.Strings(netNames)
		sort.Strings(addresses)
		var pulledFrom []string
		imageSource := imageUnknown
		if known {
			pulledFrom, imageSource = ImageRegistries(img, containerdStore)
		}
		attrs := map[string]any{
			"name": containerName(c), "image": imageRef, "imageId": c.ImageID, "imageSource": imageSource, "pulledFrom": append([]string{}, pulledFrom...), "state": c.State, "status": c.Status,
			"created": time.Unix(c.Created, 0).UTC().Format(time.RFC3339), "ports": PortStrings(c.Ports), "labels": LabelStrings(c.Labels),
			"networks": netNames, "ipAddresses": addresses, "mounts": MountStrings(c.Mounts), "engine": engineName,
		}
		if p := c.Labels[labelComposeProject]; p != "" {
			attrs["composeProject"] = p
			attrs["composeService"] = c.Labels[labelComposeService]
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeContainer, Identity: identity, Name: containerName(c), Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: c.ID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: ref, To: hostRef, Attributes: map[string]any{"state": c.State}, ObservedAt: at})

		for _, host := range pulledFrom {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relBackedBy, From: ref, To: registry(host), Attributes: map[string]any{"image": imageRef, "imageId": c.ImageID, "verified": imageSource == imageFromRegistry}, ObservedAt: at})
		}

		for _, a := range addresses {
			ip := net.ParseIP(a)
			if ip == nil {
				continue
			}
			ipIdentity := map[string]string{"address": ip.String(), "vrfRef": vrf}
			ipRef := contract.CiRef{Type: typeIP, Identity: ipIdentity}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: ip.String(), Attributes: map[string]any{"assignedTo": containerName(c), "role": "container", "engine": engineName}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: ref, To: ipRef, Attributes: map[string]any{}, ObservedAt: at})
			if sn, ok := subnetOf(ip); ok {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInSubnet, From: ipRef, To: sn, Attributes: map[string]any{}, ObservedAt: at})
			}
		}
	}
	return obs
}
