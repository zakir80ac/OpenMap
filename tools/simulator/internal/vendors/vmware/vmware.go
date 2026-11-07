// REQ-QA-005 REQ-DISC-005 — simulated VMware vCenter (vSphere Automation REST): one vCenter per estate site
// that runs vmware clusters, each on its own HTTPS listener. Session login (Basic → vmware-api-session-id),
// clusters, hosts filtered by cluster, VMs filtered by host (list caps answered like vCenter when a filter is
// missing), VM detail with NIC and disk maps, guest identity and guest networking (unavailable while a VM is
// powered off, as on the real product), datastores and the appliance version. The first site's vCenter speaks
// the 7.0+ `/api` namespace; the second speaks only the 6.5–6.7 `/rest` envelope ({"value": …}, `filter.<field>`
// list filters, maps as [{key, value}] arrays), so the collector's fallback is exercised for real. Clusters,
// hypervisors, VMs and their addresses come from the estate's vmware result; datastores are the estate VMs'
// datastore attribute, sized from the VMs' disks. The estate carries no vCenter release per site: the legacy
// release on the second vCenter is a simulator choice.
package vmware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	platform      = "vmware"
	sessionHeader = "vmware-api-session-id"
	legacyFilter  = "filter."
	bytesPerGiB   = 1 << 30
	mibPerGiB     = 1024
	// datastoreHeadroom sizes a datastore at twice the disks the estate places on it.
	datastoreHeadroom = 2
	// vCenter refuses unfiltered lists above these sizes (vSphere Automation API list limits).
	vmListLimit   = 4000
	hostListLimit = 2500
	// moRef numbering: vCenter assigns domain-c<n>, vm-<n> and datastore-<n> from per-type counters.
	clusterMoBase   = 7
	vmMoBase        = 1001
	datastoreMoBase = 11
	nicKey          = "4000"
	diskKey         = "2000"

	modernVersion = "8.0.3.00400"
	modernBuild   = "24322831"
	legacyVersion = "6.7.0.58000"
	legacyBuild   = "21304657"
	productName   = "VMware vCenter Server"
)

type Vendor struct{}

func (Vendor) ID() string             { return "vmware-vcenter" }
func (Vendor) Collector() string      { return "vmware" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-005"} }

type cluster struct {
	ci    *estate.CI
	moRef string
	hosts []*hostView
}

type hostView struct {
	ci      *estate.CI
	moRef   string
	name    string
	fqdn    string
	cluster *cluster
	vms     []*vmView
}

type vmView struct {
	ci    *estate.CI
	moRef string
	host  *hostView
	ip    *estate.CI
	ds    *datastore
}

type datastore struct {
	name     string
	moRef    string
	capacity int64
	free     int64
}

type vcenter struct {
	site       string
	legacy     bool
	host       string
	clusters   []*cluster
	hosts      []*hostView
	vms        []*vmView
	datastores []*datastore
}

func on(c *estate.CI) bool { return c.Str("powerState") == "poweredOn" }

// build groups the estate's vmware clusters by site: one vCenter per site, in estate order.
func build(e *estate.Estate) []*vcenter {
	var out []*vcenter
	bySite := map[string]*vcenter{}
	clusterN, vmN, dsN := clusterMoBase, vmMoBase, datastoreMoBase
	for _, c := range e.OfType("vm_cluster", func(c *estate.CI) bool { return c.Str("platform") == platform }) {
		site := c.Str("site")
		vc, ok := bySite[site]
		if !ok {
			// Both vCenters are reached on the advertised simulator host (distinct ports); moRef counters run
			// across vCenters, so their target-anchored identities never collide.
			vc = &vcenter{site: site, legacy: len(out) == 1, host: sim.AdvertiseHost()}
			bySite[site] = vc
			out = append(out, vc)
		}
		cl := &cluster{ci: c, moRef: "domain-c" + strconv.Itoa(clusterN)}
		clusterN++
		vc.clusters = append(vc.clusters, cl)
		dsByName := map[string]*datastore{}
		for _, hv := range e.To(c, "member_of") {
			if hv.Type != "hypervisor" {
				continue
			}
			h := &hostView{ci: hv, moRef: hv.ID("moRef"), cluster: cl, name: hv.Name}
			for _, phys := range e.From(hv, "runs_on") {
				if phys.Type == "host" && phys.ID("fqdn") != "" {
					h.fqdn = strings.ToLower(phys.ID("fqdn"))
				}
			}
			// vCenter lists a host under the name it was added with: the server's FQDN.
			if h.fqdn != "" {
				h.name = h.fqdn
			}
			cl.hosts = append(cl.hosts, h)
			vc.hosts = append(vc.hosts, h)
			for _, v := range e.To(hv, "hosted_on") {
				if v.Type != "vm" {
					continue
				}
				vm := &vmView{ci: v, moRef: "vm-" + strconv.Itoa(vmN), host: h}
				vmN++
				for _, ip := range e.From(v, "uses_ip") {
					if ip.Type == "ip_address" {
						vm.ip = ip
					}
				}
				if name := v.Str("datastore"); name != "" {
					ds, ok := dsByName[name]
					if !ok {
						ds = &datastore{name: name}
						dsByName[name] = ds
					}
					ds.capacity += int64(v.Num("diskGb", 0) * bytesPerGiB)
					vm.ds = ds
				}
				h.vms = append(h.vms, vm)
				vc.vms = append(vc.vms, vm)
			}
		}
		names := make([]string, 0, len(dsByName))
		for n := range dsByName {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			ds := dsByName[n]
			ds.moRef = "datastore-" + strconv.Itoa(dsN)
			dsN++
			used := ds.capacity
			ds.capacity = used * datastoreHeadroom
			ds.free = ds.capacity - used
			vc.datastores = append(vc.datastores, ds)
		}
	}
	return out
}

func hexOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func uuidOf(s string) string {
	h := hexOf(s)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// guest maps the estate's guest OS onto vSphere's guest_OS identifier and guest family.
func guest(os, family string) (string, string) {
	l := strings.ToLower(os)
	switch {
	case strings.Contains(l, "ubuntu"):
		return "UBUNTU_64", "LINUX"
	case strings.Contains(l, "red hat") && strings.Contains(l, " 9"):
		return "RHEL_9_64", "LINUX"
	case strings.Contains(l, "red hat"):
		return "RHEL_8_64", "LINUX"
	case strings.Contains(l, "windows server 2022"):
		return "WINDOWS_SERVER_2021", "WINDOWS"
	case strings.Contains(l, "windows"):
		return "WINDOWS_2019SERVER_64", "WINDOWS"
	case family == "windows":
		return "OTHER_64", "WINDOWS"
	default:
		return "OTHER_LINUX_64", "LINUX"
	}
}

func power(c *estate.CI) string {
	if on(c) {
		return "POWERED_ON"
	}
	return "POWERED_OFF"
}

// keyed renders a vAPI map: an object under /api, [{key, value}] under /rest.
func (vc *vcenter) keyed(m map[string]any) any {
	if !vc.legacy {
		return m
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]any, 0, len(keys))
	for _, k := range keys {
		out = append(out, map[string]any{"key": k, "value": m[k]})
	}
	return out
}

func clusterDoc(c *cluster) map[string]any {
	return map[string]any{"cluster": c.moRef, "name": c.ci.Name, "drs_enabled": c.ci.Bool("drsEnabled"), "ha_enabled": c.ci.Bool("haEnabled")}
}

func hostDoc(h *hostView) map[string]any {
	state := "CONNECTED"
	if !strings.EqualFold(h.ci.Str("connectionState"), "connected") {
		state = "DISCONNECTED"
	}
	return map[string]any{"host": h.moRef, "name": h.name, "connection_state": state, "power_state": "POWERED_ON"}
}

func vmSummary(v *vmView) map[string]any {
	return map[string]any{"vm": v.moRef, "name": v.ci.Name, "power_state": power(v.ci), "cpu_count": int(v.ci.Num("vcpus", 1)), "memory_size_MiB": int(v.ci.Num("memoryGb", 1) * mibPerGiB)}
}

func (vc *vcenter) vmDetail(v *vmView) map[string]any {
	c := v.ci
	guestID, _ := guest(c.Str("guestOs"), c.Str("guestOsFamily"))
	hw := strings.ToUpper(strings.ReplaceAll(c.Str("hardwareVersion"), "-", "_"))
	disk := map[string]any{"label": "Hard disk 1", "type": "SCSI", "capacity": int64(c.Num("diskGb", 0) * bytesPerGiB), "backing": map[string]any{"type": "VMDK_FILE"}}
	if v.ds != nil {
		disk["backing"] = map[string]any{"type": "VMDK_FILE", "vmdk_file": "[" + v.ds.name + "] " + c.Name + "/" + c.Name + ".vmdk"}
	}
	nicState := "NOT_CONNECTED"
	if on(c) {
		nicState = "CONNECTED"
	}
	nic := map[string]any{"label": "Network adapter 1", "type": "VMXNET3", "mac_type": "ASSIGNED", "mac_address": c.Str("macAddress"), "state": nicState,
		"backing": map[string]any{"type": "STANDARD_PORTGROUP", "network": "network-" + hexOf(c.Str("network"))[:4], "network_name": c.Str("network")}}
	return map[string]any{
		"name": c.Name, "guest_OS": guestID, "power_state": power(c),
		"hardware": map[string]any{"version": hw, "upgrade_policy": "NEVER", "upgrade_status": "NONE"},
		"identity": map[string]any{"name": c.Name, "instance_uuid": c.ID("instanceUuid"), "bios_uuid": uuidOf("bios/" + c.ID("instanceUuid"))},
		"cpu":      map[string]any{"count": int(c.Num("vcpus", 1)), "cores_per_socket": 1, "hot_add_enabled": false, "hot_remove_enabled": false},
		"memory":   map[string]any{"size_MiB": int(c.Num("memoryGb", 1) * mibPerGiB), "hot_add_enabled": false},
		"nics":     vc.keyed(map[string]any{nicKey: nic}),
		"disks":    vc.keyed(map[string]any{diskKey: disk}),
		"boot":     map[string]any{"type": "EFI"},
	}
}

func guestIdentity(v *vmView) map[string]any {
	c := v.ci
	guestID, family := guest(c.Str("guestOs"), c.Str("guestOsFamily"))
	return map[string]any{"name": guestID, "family": family, "full_name": map[string]any{"default_message": c.Str("guestOs"), "id": "vmsg.guestos." + strings.ToLower(guestID) + ".label", "args": []any{}},
		"host_name": strings.ToLower(c.Str("fqdn")), "ip_address": c.Str("ipAddress")}
}

func guestInterfaces(v *vmView) []any {
	c := v.ci
	prefix := 0
	if v.ip != nil {
		if _, bits, ok := strings.Cut(v.ip.Str("subnet"), "/"); ok {
			prefix, _ = strconv.Atoi(bits)
		}
	}
	addrs := []any{}
	if a := c.Str("ipAddress"); a != "" {
		addrs = append(addrs, map[string]any{"ip_address": a, "prefix_length": prefix, "origin": "STATIC", "state": "PREFERRED"})
	}
	return []any{map[string]any{"nic": nicKey, "mac_address": c.Str("macAddress"), "ip": map[string]any{"ip_addresses": addrs}}}
}

// vapiError is a vSphere Automation error document in either namespace.
func (vc *vcenter) vapiError(w http.ResponseWriter, status int, kind string) {
	if vc.legacy {
		sim.WriteJSON(w, status, map[string]any{"type": "com.vmware.vapi.std.errors." + strings.ToLower(kind), "value": map[string]any{"messages": []any{}}})
		return
	}
	sim.WriteJSON(w, status, map[string]any{"error_type": kind, "messages": []any{}})
}

func (vc *vcenter) write(w http.ResponseWriter, status int, doc any) {
	if vc.legacy {
		doc = map[string]any{"value": doc}
	}
	sim.WriteJSON(w, status, doc)
}

// filters reads list filters in the namespace's spelling; an unknown or misspelt filter is an invalid argument.
func (vc *vcenter) filters(q url.Values, allowed ...string) (map[string]map[string]bool, bool) {
	out := map[string]map[string]bool{}
	for k, vals := range q {
		field := k
		if vc.legacy {
			f, ok := strings.CutPrefix(k, legacyFilter)
			if !ok {
				return nil, false
			}
			field = f
		}
		known := false
		for _, a := range allowed {
			known = known || a == field
		}
		if !known {
			return nil, false
		}
		set := map[string]bool{}
		for _, v := range vals {
			for _, item := range strings.Split(v, ",") {
				set[item] = true
			}
		}
		out[field] = set
	}
	return out, true
}

func (vc *vcenter) handler(env *sim.Env) http.Handler {
	token := env.Token("vcenter-" + strings.ToLower(vc.site))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case vc.legacy && p == "/rest/com/vmware/cis/session":
			p = "/api/session"
		case vc.legacy && strings.HasPrefix(p, "/rest/"):
			p = "/api/" + strings.TrimPrefix(p, "/rest/")
		case vc.legacy || !strings.HasPrefix(p, "/api/"):
			vc.vapiError(w, http.StatusNotFound, "NOT_FOUND")
			return
		}
		if p == "/api/session" {
			switch r.Method {
			case http.MethodPost:
				if !env.BasicOK(r) {
					vc.vapiError(w, http.StatusUnauthorized, "UNAUTHENTICATED")
					return
				}
				// 7.0+ answers 201 Created; the 6.x /rest session service answers 200.
				status := http.StatusCreated
				if vc.legacy {
					status = http.StatusOK
				}
				vc.write(w, status, token)
			case http.MethodDelete:
				if r.Header.Get(sessionHeader) != token {
					vc.vapiError(w, http.StatusUnauthorized, "UNAUTHENTICATED")
					return
				}
				w.WriteHeader(http.StatusNoContent)
			default:
				vc.vapiError(w, http.StatusMethodNotAllowed, "OPERATION_NOT_FOUND")
			}
			return
		}
		if r.Header.Get(sessionHeader) != token {
			vc.vapiError(w, http.StatusUnauthorized, "UNAUTHENTICATED")
			return
		}
		if r.Method != http.MethodGet {
			vc.vapiError(w, http.StatusMethodNotAllowed, "OPERATION_NOT_FOUND")
			return
		}
		vc.get(w, p, r.URL.Query())
	})
}

func (vc *vcenter) get(w http.ResponseWriter, p string, q url.Values) {
	switch p {
	case "/api/appliance/system/version":
		version, build := modernVersion, modernBuild
		if vc.legacy {
			version, build = legacyVersion, legacyBuild
		}
		vc.write(w, http.StatusOK, map[string]any{"version": version, "build": build, "product": productName, "type": "vCenter Server with an embedded Platform Services Controller", "summary": productName + " " + version})
		return
	case "/api/vcenter/cluster":
		f, ok := vc.filters(q, "names")
		if !ok {
			vc.vapiError(w, http.StatusBadRequest, "INVALID_ARGUMENT")
			return
		}
		out := []any{}
		for _, c := range vc.clusters {
			if f["names"] == nil || f["names"][c.ci.Name] {
				out = append(out, clusterDoc(c))
			}
		}
		vc.write(w, http.StatusOK, out)
		return
	case "/api/vcenter/host":
		f, ok := vc.filters(q, "clusters", "names")
		if !ok {
			vc.vapiError(w, http.StatusBadRequest, "INVALID_ARGUMENT")
			return
		}
		if len(f) == 0 && len(vc.hosts) > hostListLimit {
			vc.vapiError(w, http.StatusBadRequest, "UNABLE_TO_ALLOCATE_RESOURCE")
			return
		}
		out := []any{}
		for _, h := range vc.hosts {
			if (f["clusters"] == nil || f["clusters"][h.cluster.moRef]) && (f["names"] == nil || f["names"][h.name]) {
				out = append(out, hostDoc(h))
			}
		}
		vc.write(w, http.StatusOK, out)
		return
	case "/api/vcenter/datastore":
		if _, ok := vc.filters(q, "names"); !ok {
			vc.vapiError(w, http.StatusBadRequest, "INVALID_ARGUMENT")
			return
		}
		out := []any{}
		for _, d := range vc.datastores {
			out = append(out, map[string]any{"datastore": d.moRef, "name": d.name, "type": "VMFS", "capacity": d.capacity, "free_space": d.free})
		}
		vc.write(w, http.StatusOK, out)
		return
	case "/api/vcenter/vm":
		f, ok := vc.filters(q, "hosts", "clusters", "names")
		if !ok {
			vc.vapiError(w, http.StatusBadRequest, "INVALID_ARGUMENT")
			return
		}
		if len(f) == 0 && len(vc.vms) > vmListLimit {
			vc.vapiError(w, http.StatusBadRequest, "UNABLE_TO_ALLOCATE_RESOURCE")
			return
		}
		out := []any{}
		for _, v := range vc.vms {
			if (f["hosts"] == nil || f["hosts"][v.host.moRef]) && (f["clusters"] == nil || f["clusters"][v.host.cluster.moRef]) && (f["names"] == nil || f["names"][v.ci.Name]) {
				out = append(out, vmSummary(v))
			}
		}
		vc.write(w, http.StatusOK, out)
		return
	}
	rest, ok := strings.CutPrefix(p, "/api/vcenter/vm/")
	if !ok {
		vc.vapiError(w, http.StatusNotFound, "NOT_FOUND")
		return
	}
	id, sub, _ := strings.Cut(rest, "/")
	var vm *vmView
	for _, v := range vc.vms {
		if v.moRef == id {
			vm = v
		}
	}
	if vm == nil {
		vc.vapiError(w, http.StatusNotFound, "NOT_FOUND")
		return
	}
	switch sub {
	case "":
		vc.write(w, http.StatusOK, vc.vmDetail(vm))
	case "guest/identity", "guest/networking/interfaces":
		// VMware Tools answers only while the guest runs.
		if !on(vm.ci) {
			vc.vapiError(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE")
			return
		}
		if sub == "guest/identity" {
			vc.write(w, http.StatusOK, guestIdentity(vm))
		} else {
			vc.write(w, http.StatusOK, guestInterfaces(vm))
		}
	default:
		vc.vapiError(w, http.StatusNotFound, "NOT_FOUND")
	}
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	vcs := map[string]*vcenter{}
	keys := []string{}
	for _, vc := range build(e) {
		vcs[vc.site] = vc
		keys = append(keys, vc.site)
	}
	return sim.ServeEach(env, keys, true, func(k string) http.Handler { return vcs[k].handler(env) })
}

func portOf(base string) int {
	u, err := url.Parse(base)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(u.Port())
	return n
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	var runs []sim.Run
	for _, vc := range build(e) {
		name := "vcenter-" + strings.ToLower(vc.site)
		if vc.legacy {
			name += "-rest"
		}
		run := sim.Run{
			Name:           name,
			Targets:        []sim.Target{{Kind: "host", Value: vc.host, Label: name}},
			Options:        map[string]any{"port": portOf(ep.Devices[vc.site]), "verifyTls": true, "caCertPem": env.CA.PEM},
			CredentialType: "password",
			Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}},
		}
		x := &run.Expect
		for _, c := range vc.clusters {
			x.EstateCI(c.ci)
		}
		for _, h := range vc.hosts {
			// vCenter names the hypervisor by the FQDN it was added with; the estate names it by its short name.
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "hypervisor", Name: h.name, Identity: h.ci.Identity})
			x.Rel("member_of", "hypervisor", h.name, "vm_cluster", h.cluster.ci.Name)
			if h.fqdn != "" {
				x.RelToRef("hosted_on", "hypervisor", h.name, "host", map[string]string{"fqdn": h.fqdn})
			}
		}
		for _, d := range vc.datastores {
			x.CI("lun", d.name)
		}
		for _, v := range vc.vms {
			x.EstateCI(v.ci)
			x.Rel("runs_on", "vm", v.ci.Name, "hypervisor", v.host.name)
			if v.ds != nil {
				x.Rel("mounted_on", "vm", v.ci.Name, "lun", v.ds.name)
			}
			// Guest OS and guest addresses come from VMware Tools, which reports only for running VMs.
			if !on(v.ci) {
				continue
			}
			if os := v.ci.Str("guestOs"); os != "" {
				x.CI("operating_system", os)
				x.Rel("installed_on", "operating_system", os, "vm", v.ci.Name)
			}
			if v.ip != nil {
				x.EstateCI(v.ip)
				x.Rel("uses_ip", "vm", v.ci.Name, "ip_address", v.ip.Name)
			}
		}
		runs = append(runs, run)
	}
	return runs
}
