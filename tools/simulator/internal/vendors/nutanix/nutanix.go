// REQ-QA-005 REQ-DISC-008 — simulated Nutanix Prism Central (v3 REST, port 9440 style HTTPS): HTTP Basic
// auth, POST <kind>s/list with length/offset paging (Prism's 500-entity page cap, total_matches) for
// clusters, hosts, VMs and subnets, plus the v2.0 storage-container list. Prism Central manages every estate
// nutanix_ahv cluster and, as on the real product, lists itself as a PRISM_CENTRAL cluster entity. Hosts are
// the estate's AHV hypervisors with the physical server's serial, model and IPMI address (from the estate
// bmc that manages it); VMs carry NICs on managed VLAN subnets (the estate VMs' networks, gateways from the
// estate subnets), disks on storage containers (the estate VMs' datastore attribute) and no Nutanix Guest
// Tools (the estate reports no guest tools for AHV VMs). A powered-off AHV VM is placed on no host, so it
// carries no host_reference.
package nutanix

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	platform     = "nutanix_ahv"
	v3           = "/api/nutanix/v3/"
	v2Containers = "/PrismGateway/services/rest/v2.0/storage_containers/"
	apiVersion   = "3.1"
	// maxPage is Prism's cap on a v3 list page.
	maxPage      = 500
	defaultPage  = 20
	bytesPerGiB  = 1 << 30
	mibPerGiB    = 1024
	headroom     = 2
	vlanBase     = 100
	cvmOffset    = 100
	lastOctetMax = 254
	replication  = 2
	ahvVersion   = "el8.nutanix.20230302.101026"
	pcName       = "prism-central"
	pcVersion    = "pc.2024.3"
)

type Vendor struct{}

func (Vendor) ID() string             { return "nutanix-prism" }
func (Vendor) Collector() string      { return "nutanix_ahv" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-008"} }

func uuidOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	h := hex.EncodeToString(sum[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

type cluster struct {
	ci         *estate.CI
	uuid       string
	hosts      []*hostView
	subnets    []*subnet
	containers []*container
}

type hostView struct {
	ci      *estate.CI
	phys    *estate.CI
	bmc     *estate.CI
	name    string
	cluster *cluster
}

type subnet struct {
	name    string
	uuid    string
	cidr    string
	vlan    int
	gateway string
	ci      *estate.CI
	cluster *cluster
}

type container struct {
	name     string
	uuid     string
	used     int64
	capacity int64
	cluster  *cluster
}

type vmView struct {
	ci      *estate.CI
	host    *hostView
	ip      *estate.CI
	subnet  *subnet
	cont    *container
	cluster *cluster
}

type prism struct {
	clusters []*cluster
	vms      []*vmView
}

func on(c *estate.CI) bool { return c.Str("powerState") == "poweredOn" }

func subnetIndex(e *estate.Estate) map[string]*estate.CI {
	out := map[string]*estate.CI{}
	for _, s := range e.OfType("subnet", nil) {
		if _, dup := out[s.ID("cidr")]; !dup {
			out[s.ID("cidr")] = s
		}
	}
	return out
}

func build(e *estate.Estate) *prism {
	p := &prism{}
	subnets := subnetIndex(e)
	for _, c := range e.OfType("vm_cluster", func(c *estate.CI) bool { return c.Str("platform") == platform }) {
		// Prism's cluster UUID is the estate's clusterId when the estate carries one (it does since the estate adopted
		// the collectors' identities); older estates keyed clusters by name.
		uuid := c.ID("clusterId")
		if !sim.IsUUID(uuid) {
			uuid = uuidOf("nutanix-cluster/" + c.Name)
		}
		cl := &cluster{ci: c, uuid: uuid}
		p.clusters = append(p.clusters, cl)
		byNet := map[string]*subnet{}
		byDs := map[string]*container{}
		var vms []*vmView
		for _, hv := range e.To(c, "member_of") {
			if hv.Type != "hypervisor" {
				continue
			}
			h := &hostView{ci: hv, name: hv.Name, cluster: cl}
			for _, phys := range e.From(hv, "hosted_on") {
				if phys.Type == "host" {
					h.phys = phys
					if f := phys.ID("fqdn"); f != "" {
						h.name = strings.ToLower(f)
					}
					for _, b := range e.To(phys, "manages") {
						if b.Type == "bmc" {
							h.bmc = b
						}
					}
				}
			}
			cl.hosts = append(cl.hosts, h)
			for _, v := range e.To(hv, "runs_on") {
				if v.Type != "vm" {
					continue
				}
				vm := &vmView{ci: v, host: h, cluster: cl}
				for _, ip := range e.From(v, "uses_ip") {
					if ip.Type == "ip_address" {
						vm.ip = ip
					}
				}
				if net := v.Str("network"); net != "" && vm.ip != nil {
					sn, ok := byNet[net]
					if !ok {
						sn = &subnet{name: net, uuid: uuidOf("nutanix-subnet/" + c.Name + "/" + net), cidr: vm.ip.Str("subnet"), cluster: cl}
						if est, found := subnets[sn.cidr]; found {
							sn.ci = est
							sn.gateway = est.Str("gateway")
						}
						byNet[net] = sn
					}
					vm.subnet = sn
				}
				if ds := v.Str("datastore"); ds != "" {
					ct, ok := byDs[ds]
					if !ok {
						ct = &container{name: ds, uuid: uuidOf("nutanix-container/" + c.Name + "/" + ds), cluster: cl}
						byDs[ds] = ct
					}
					ct.used += int64(v.Num("diskGb", 0) * bytesPerGiB)
					vm.cont = ct
				}
				vms = append(vms, vm)
			}
		}
		nets := make([]string, 0, len(byNet))
		for n := range byNet {
			nets = append(nets, n)
		}
		sort.Strings(nets)
		for i, n := range nets {
			byNet[n].vlan = vlanBase + i
			cl.subnets = append(cl.subnets, byNet[n])
		}
		dss := make([]string, 0, len(byDs))
		for n := range byDs {
			dss = append(dss, n)
		}
		sort.Strings(dss)
		for _, n := range dss {
			ct := byDs[n]
			ct.capacity = ct.used * headroom
			cl.containers = append(cl.containers, ct)
		}
		p.vms = append(p.vms, vms...)
	}
	return p
}

func ref(kind, uuid, name string) map[string]any {
	r := map[string]any{"kind": kind, "uuid": uuid}
	if name != "" {
		r["name"] = name
	}
	return r
}

// cvmIP places the controller VM next to the hypervisor on the management network.
func cvmIP(hv string) string {
	ip := net.ParseIP(hv).To4()
	if ip == nil || int(ip[3])+cvmOffset > lastOctetMax {
		return ""
	}
	ip[3] += cvmOffset
	return ip.String()
}

func (p *prism) entities(kind string) []any {
	out := []any{}
	switch kind {
	case "cluster":
		for _, c := range p.clusters {
			servers := []any{}
			for _, h := range c.hosts {
				servers = append(servers, map[string]any{"ip": h.ci.Str("managementIp"), "version": ahvVersion, "type": "AHV"})
			}
			aos := strings.TrimSpace(strings.TrimPrefix(c.ci.Str("product"), "Nutanix AOS"))
			external := ""
			if len(c.hosts) > 0 {
				external = c.hosts[0].ci.Str("managementIp")
			}
			out = append(out, map[string]any{"metadata": map[string]any{"uuid": c.uuid, "kind": "cluster"}, "spec": map[string]any{"name": c.ci.Name},
				"status": map[string]any{"state": "COMPLETE", "name": c.ci.Name, "resources": map[string]any{
					"config":  map[string]any{"software_map": map[string]any{"NOS": map[string]any{"software_type": "NOS", "status": "INSTALLED", "version": aos}}, "build": map[string]any{"version": aos}, "service_list": []string{"AOS"}, "redundancy_factor": replication},
					"network": map[string]any{"external_ip": external},
					"nodes":   map[string]any{"hypervisor_server_list": servers},
				}}})
		}
		// Prism Central lists itself among the clusters it manages.
		out = append(out, map[string]any{"metadata": map[string]any{"uuid": uuidOf("nutanix-pc"), "kind": "cluster"}, "status": map[string]any{"state": "COMPLETE", "name": pcName, "resources": map[string]any{
			"config": map[string]any{"software_map": map[string]any{"PC": map[string]any{"software_type": "PRISM_CENTRAL", "status": "INSTALLED", "version": pcVersion}}, "build": map[string]any{"version": pcVersion}, "service_list": []string{"PRISM_CENTRAL"}},
		}}})
	case "host":
		for _, c := range p.clusters {
			for _, h := range c.hosts {
				res := map[string]any{
					"hypervisor":    map[string]any{"ip": h.ci.Str("managementIp"), "hypervisor_full_name": "AHV " + h.ci.Str("version"), "num_vms": len(p.vmsOn(h))},
					"controller_vm": map[string]any{"ip": cvmIP(h.ci.Str("managementIp"))},
					"num_cpu_cores": int(h.ci.Num("cpuCores", 0)), "memory_capacity_mib": int64(h.ci.Num("memoryGb", 0) * mibPerGiB), "host_type": "HYPER_CONVERGED",
				}
				if h.phys != nil {
					res["serial_number"] = h.phys.ID("serialNumber")
					res["block"] = map[string]any{"block_model": h.phys.Str("model"), "block_serial_number": h.phys.ID("serialNumber")}
					res["num_cpu_sockets"] = int(h.phys.Num("cpuSockets", 0))
					res["cpu_model"] = h.phys.Str("cpuModel")
				}
				if h.bmc != nil {
					res["ipmi"] = map[string]any{"ip": h.bmc.ID("managementIp")}
				}
				out = append(out, map[string]any{"metadata": map[string]any{"uuid": h.ci.ID("moRef"), "kind": "host"},
					"status": map[string]any{"state": "COMPLETE", "name": h.name, "cluster_reference": ref("cluster", c.uuid, c.ci.Name), "resources": res}})
			}
		}
	case "vm":
		for _, v := range p.vms {
			c := v.ci
			state := "OFF"
			if on(c) {
				state = "ON"
			}
			nic := map[string]any{"mac_address": c.Str("macAddress"), "nic_type": "NORMAL_NIC", "is_connected": true, "ip_endpoint_list": []any{}}
			if v.subnet != nil {
				nic["subnet_reference"] = ref("subnet", v.subnet.uuid, v.subnet.name)
				if a := c.Str("ipAddress"); a != "" {
					nic["ip_endpoint_list"] = []any{map[string]any{"ip": a, "type": "ASSIGNED"}}
				}
			}
			disks := []any{map[string]any{"device_properties": map[string]any{"device_type": "CDROM", "disk_address": map[string]any{"adapter_type": "IDE", "device_index": 0}}, "disk_size_bytes": 0}}
			disk := map[string]any{"disk_size_bytes": int64(c.Num("diskGb", 0) * bytesPerGiB), "device_properties": map[string]any{"device_type": "DISK", "disk_address": map[string]any{"adapter_type": "SCSI", "device_index": 0}}}
			if v.cont != nil {
				disk["storage_config"] = map[string]any{"storage_container_reference": ref("storage_container", v.cont.uuid, v.cont.name)}
			}
			disks = append(disks, disk)
			res := map[string]any{"power_state": state, "num_sockets": int(c.Num("vcpus", 1)), "num_vcpus_per_socket": 1, "memory_size_mib": int(c.Num("memoryGb", 1) * mibPerGiB),
				"nic_list": []any{nic}, "disk_list": disks, "machine_type": "PC"}
			// AHV places a VM on a host only while it runs.
			if on(c) {
				res["host_reference"] = ref("host", v.host.ci.ID("moRef"), v.host.name)
			}
			out = append(out, map[string]any{"metadata": map[string]any{"uuid": c.ID("instanceUuid"), "kind": "vm"},
				"status": map[string]any{"state": "COMPLETE", "name": c.Name, "cluster_reference": ref("cluster", v.cluster.uuid, v.cluster.ci.Name), "resources": res}})
		}
	case "subnet":
		for _, c := range p.clusters {
			for _, s := range c.subnets {
				ipc := map[string]any{}
				if addr, bits, ok := strings.Cut(s.cidr, "/"); ok {
					n, _ := strconv.Atoi(bits)
					ipc = map[string]any{"subnet_ip": addr, "prefix_length": n, "default_gateway_ip": s.gateway}
				}
				out = append(out, map[string]any{"metadata": map[string]any{"uuid": s.uuid, "kind": "subnet"},
					"status": map[string]any{"state": "COMPLETE", "name": s.name, "cluster_reference": ref("cluster", c.uuid, c.ci.Name), "resources": map[string]any{"subnet_type": "VLAN", "vlan_id": s.vlan, "ip_config": ipc}}})
			}
		}
	default:
		return nil
	}
	return out
}

func (p *prism) vmsOn(h *hostView) []*vmView {
	var out []*vmView
	for _, v := range p.vms {
		if v.host == h && on(v.ci) {
			out = append(out, v)
		}
	}
	return out
}

func (p *prism) containers() []any {
	out := []any{}
	for _, c := range p.clusters {
		for _, ct := range c.containers {
			out = append(out, map[string]any{"storage_container_uuid": ct.uuid, "cluster_uuid": c.uuid, "name": ct.name, "max_capacity": ct.capacity,
				"usage_stats":        map[string]string{"storage.usage_bytes": strconv.FormatInt(ct.used, 10), "storage.capacity_bytes": strconv.FormatInt(ct.capacity, 10)},
				"replication_factor": replication, "compression_enabled": true})
		}
	}
	return out
}

func prismError(w http.ResponseWriter, status int, msg string) {
	sim.WriteJSON(w, status, map[string]any{"api_version": apiVersion, "code": status, "state": "ERROR", "message_list": []any{map[string]any{"message": msg, "reason": http.StatusText(status)}}})
}

func (p *prism) handler(env *sim.Env) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !env.BasicOK(r) {
			prismError(w, http.StatusUnauthorized, "Authentication required.")
			return
		}
		if r.URL.Path == v2Containers && r.Method == http.MethodGet {
			all := p.containers()
			sim.WriteJSON(w, http.StatusOK, map[string]any{"metadata": map[string]any{"grand_total_entities": len(all), "total_entities": len(all), "count": len(all)}, "entities": all})
			return
		}
		rest, ok := strings.CutPrefix(r.URL.Path, v3)
		kind, isList := strings.CutSuffix(rest, "s/list")
		if !ok || !isList || r.Method != http.MethodPost {
			prismError(w, http.StatusNotFound, "no such endpoint")
			return
		}
		var body struct {
			Kind   string `json:"kind"`
			Length *int   `json:"length"`
			Offset int    `json:"offset"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Kind != kind {
			prismError(w, http.StatusUnprocessableEntity, "kind must match the list endpoint")
			return
		}
		all := p.entities(kind)
		if all == nil {
			prismError(w, http.StatusNotFound, "no such kind")
			return
		}
		length := defaultPage
		if body.Length != nil {
			length = *body.Length
		}
		if length < 1 || length > maxPage {
			prismError(w, http.StatusUnprocessableEntity, "length must be between 1 and "+strconv.Itoa(maxPage))
			return
		}
		offset := min(max(body.Offset, 0), len(all))
		end := min(offset+length, len(all))
		sim.WriteJSON(w, http.StatusOK, map[string]any{"api_version": apiVersion,
			"metadata": map[string]any{"kind": kind, "total_matches": len(all), "length": end - offset, "offset": offset}, "entities": all[offset:end]})
	})
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	ep, _, err := sim.ServeHTTPS(env, build(e).handler(env))
	return ep, err
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	p := build(e)
	if len(p.clusters) == 0 {
		return nil
	}
	run := sim.Run{
		Name:           "prism-central",
		Targets:        []sim.Target{{Kind: "url", Value: ep.URL, Label: pcName}},
		Options:        map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM},
		CredentialType: "password",
		Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}},
	}
	x := &run.Expect
	for _, c := range p.clusters {
		x.EstateCI(c.ci)
		for _, h := range c.hosts {
			// Prism names the host by its hostname (the server's FQDN); the estate names the hypervisor by its short name.
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "hypervisor", Name: h.name, Identity: h.ci.Identity})
			x.Rel("member_of", "hypervisor", h.name, "vm_cluster", c.ci.Name)
			if h.phys != nil {
				x.CIs = append(x.CIs, sim.ExpectCI{Type: "host", Name: h.name, Identity: h.phys.Identity})
				x.Rel("hosted_on", "hypervisor", h.name, "host", h.name)
			}
			if h.bmc != nil {
				x.CI("bmc", "IPMI @ "+h.bmc.ID("managementIp"))
				x.Rel("manages", "bmc", "IPMI @ "+h.bmc.ID("managementIp"), "host", h.name)
			}
		}
		for _, s := range c.subnets {
			if s.ci != nil {
				x.CIs = append(x.CIs, sim.ExpectCI{Type: "subnet", Name: s.name, Identity: s.ci.Identity})
			} else {
				x.CI("subnet", s.name)
			}
			x.CI("vlan", s.name)
			x.Rel("in_vlan", "subnet", s.name, "vlan", s.name)
		}
		for _, ct := range c.containers {
			x.CI("lun", ct.name)
		}
	}
	for _, v := range p.vms {
		x.EstateCI(v.ci)
		if on(v.ci) {
			x.Rel("runs_on", "vm", v.ci.Name, "hypervisor", v.host.name)
		}
		if v.cont != nil {
			x.Rel("mounted_on", "vm", v.ci.Name, "lun", v.cont.name)
		}
		if v.ip != nil && v.subnet != nil {
			x.EstateCI(v.ip)
			x.Rel("uses_ip", "vm", v.ci.Name, "ip_address", v.ip.Name)
			x.Rel("in_subnet", "ip_address", v.ip.Name, "subnet", v.subnet.name)
		}
	}
	return []sim.Run{run}
}
