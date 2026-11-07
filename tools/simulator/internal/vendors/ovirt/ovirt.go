// REQ-QA-005 REQ-DISC-009 REQ-DISC-007 — simulated ovirt-engine REST API (API v4 JSON): an Oracle Linux
// Virtualization Manager engine and an oVirt engine, each on its own HTTPS listener. Authentication is HTTP
// Basic with a user@profile account or an SSO bearer token from /ovirt-engine/sso/oauth/token (password
// grant); `Version: 4` is the only API version served; `follow=` inlines NICs with their reported devices
// and disk attachments with their disks exactly as requested, otherwise only links are returned. Numbers are
// strings, lists are wrapped in their singular element name, a VM that is down has no host and no guest
// agent data.
//
// The synthetic estate has no oVirt, OLVM or RHV content, so each engine's inventory is GENERATED here: a
// deterministic set (hash-derived ids, serials and MACs, no randomness) of one data centre, two clusters,
// three KVM hosts per cluster, four VMs per host (the last one down) and an NFS and an iSCSI data domain.
// Expectations come from that same set.
package ovirt

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	apiBase      = "/ovirt-engine/api"
	ssoToken     = "/ovirt-engine/sso/oauth/token"
	apiVersion   = "4"
	authProfile  = "@internal"
	clusters     = 2
	hostsPerCl   = 3
	vmsPerHost   = 4
	bytesPerGiB  = 1 << 30
	hostMemGiB   = 512
	vmMemGiB     = 16
	vmDiskGiB    = 120
	domainGiB    = 20480
	usedPercent  = 40
	percent      = 100
	hostSockets  = 2
	hostCores    = 16
	hostThreads  = 2
	vmSockets    = 4
	subnetStride = 16
	vmIPBase     = 50
	serialLen    = 10
)

type engineSpec struct {
	key       string
	platform  string
	product   string
	vendor    string
	version   string
	major     string
	minor     string
	domain    string
	hostOS    string
	hostOSVer string
	vdsm      string
	libvirt   string
	cpuType   string
	hwVendor  string
	hwModel   string
	guests    []guestOS
	netOctet  int
}

type guestOS struct {
	osType, distribution, family, version string
}

// The two engines: OLVM (platform oracle_vm, the collector's option for Oracle) and upstream oVirt.
var engines = []engineSpec{
	{key: "olvm", platform: "oracle_vm", product: "Oracle Linux Virtualization Manager", vendor: "Oracle", version: "4.5.5-1.0.27.el8", major: "4", minor: "7",
		domain: "olvm.sim.bank.local", hostOS: "OL", hostOSVer: "8.10 - 1.0.el8", vdsm: "4.50.5.1-1.0.12.el8", libvirt: "8.0.0-23.2.0.1.module+el8.10.0+90374+28e0a4e7",
		cpuType: "Secure Intel Icelake Server Family", hwVendor: "Oracle Corporation", hwModel: "ORACLE SERVER X9-2", netOctet: 240,
		guests: []guestOS{{"other_linux", "Oracle Linux Server", "Linux", "8.10"}, {"rhel_9x64", "Oracle Linux Server", "Linux", "9.4"}, {"windows_2022", "Microsoft Windows Server 2022 Standard", "Windows", "10.0.20348"}}},
	{key: "ovirt", platform: "ovirt", product: "oVirt Engine", vendor: "ovirt.org", version: "4.5.6-1.el9", major: "4", minor: "7",
		domain: "ovirt.sim.bank.local", hostOS: "RHEL", hostOSVer: "9 - 2.el9", vdsm: "4.50.5.1-1.el9", libvirt: "10.0.0-6.el9",
		cpuType: "Intel Cascadelake Server Family", hwVendor: "Dell Inc.", hwModel: "PowerEdge R650", netOctet: 241,
		guests: []guestOS{{"rhel_9x64", "CentOS Stream", "Linux", "9"}, {"rhel_8x64", "Rocky Linux", "Linux", "8.10"}, {"windows_2019x64", "Microsoft Windows Server 2019 Standard", "Windows", "10.0.17763"}}},
}

type Vendor struct{}

func (Vendor) ID() string             { return "ovirt-engine" }
func (Vendor) Collector() string      { return "oracle_vm" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-009", "REQ-DISC-007"} }

func hexOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func uuidOf(s string) string {
	h := hexOf(s)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func pad(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

type cluster struct{ id, name string }

type host struct {
	id, name, address, serial, uuid string
	cluster                         *cluster
}

type vm struct {
	id, name, fqdn, mac, ip string
	up                      bool
	host                    *host
	cluster                 *cluster
	guest                   guestOS
	domain                  *domain
	diskID                  string
}

type domain struct {
	id, name, storageType, address, path string
	vms                                  int
}

type engine struct {
	spec     engineSpec
	dcID     string
	dcName   string
	clusters []*cluster
	hosts    []*host
	vms      []*vm
	domains  []*domain
}

func generate(spec engineSpec) *engine {
	en := &engine{spec: spec, dcID: uuidOf(spec.key + "/dc"), dcName: spec.key + "-dc01"}
	nfs := &domain{id: uuidOf(spec.key + "/sd/nfs"), name: spec.key + "-data-nfs", storageType: "nfs", address: "nfs01." + spec.domain, path: "/exports/" + spec.key + "-data"}
	iscsi := &domain{id: uuidOf(spec.key + "/sd/iscsi"), name: spec.key + "-data-iscsi", storageType: "iscsi"}
	en.domains = []*domain{nfs, iscsi}
	n := 0
	for c := 1; c <= clusters; c++ {
		cl := &cluster{id: uuidOf(spec.key + "/cluster/" + strconv.Itoa(c)), name: spec.key + "-cl" + pad(c)}
		en.clusters = append(en.clusters, cl)
		for h := 1; h <= hostsPerCl; h++ {
			hn := spec.key + "-kvm-" + pad((c-1)*hostsPerCl+h)
			ho := &host{id: uuidOf(spec.key + "/host/" + hn), name: hn, address: hn + "." + spec.domain, cluster: cl,
				serial: strings.ToUpper(hexOf(spec.key + "/serial/" + hn)[:serialLen]), uuid: uuidOf(spec.key + "/hw/" + hn)}
			en.hosts = append(en.hosts, ho)
			for v := 1; v <= vmsPerHost; v++ {
				n++
				name := spec.key + "-app-" + pad(n)
				mac := hexOf(spec.key + "/mac/" + name)
				d := nfs
				if n%2 == 0 {
					d = iscsi
				}
				d.vms++
				en.vms = append(en.vms, &vm{id: uuidOf(spec.key + "/vm/" + name), name: name, fqdn: name + "." + spec.domain,
					mac: "56:6f:" + mac[0:2] + ":" + mac[2:4] + ":" + mac[4:6] + ":" + mac[6:8], ip: "10." + strconv.Itoa(spec.netOctet) + "." + strconv.Itoa(c*subnetStride) + "." + strconv.Itoa(vmIPBase+n),
					up: v != vmsPerHost, host: ho, cluster: cl, guest: spec.guests[n%len(spec.guests)], domain: d, diskID: uuidOf(spec.key + "/disk/" + name)})
			}
		}
	}
	return en
}

func gib(n int64) string { return strconv.FormatInt(n*bytesPerGiB, 10) }

func link(kind, id string) map[string]any {
	return map[string]any{"id": id, "href": apiBase + "/" + kind + "/" + id}
}

func (en *engine) root() map[string]any {
	s := en.spec
	parts := strings.SplitN(s.version, ".", 3)
	return map[string]any{
		"product_info": map[string]any{"name": s.product, "vendor": s.vendor, "instance_id": uuidOf(s.key + "/instance"),
			"version": map[string]any{"build": "1", "full_version": s.version, "major": parts[0], "minor": parts[1], "revision": "0"}},
		"summary": map[string]any{"hosts": map[string]any{"active": strconv.Itoa(len(en.hosts)), "total": strconv.Itoa(len(en.hosts))}, "vms": map[string]any{"active": strconv.Itoa(en.running()), "total": strconv.Itoa(len(en.vms))}},
		"link":    []any{map[string]any{"href": apiBase + "/vms", "rel": "vms"}, map[string]any{"href": apiBase + "/hosts", "rel": "hosts"}},
	}
}

func (en *engine) running() int {
	n := 0
	for _, v := range en.vms {
		if v.up {
			n++
		}
	}
	return n
}

func (en *engine) hostsDoc() map[string]any {
	s := en.spec
	out := []any{}
	for _, h := range en.hosts {
		out = append(out, map[string]any{
			"id": h.id, "href": apiBase + "/hosts/" + h.id, "name": h.name, "address": h.address, "status": "up", "type": "rhel",
			"cluster": link("clusters", h.cluster.id), "memory": gib(hostMemGiB), "max_scheduling_memory": gib(hostMemGiB),
			"hardware_information": map[string]any{"serial_number": h.serial, "manufacturer": s.hwVendor, "product_name": s.hwModel, "uuid": strings.ToUpper(h.uuid), "family": "Server"},
			"cpu":                  map[string]any{"name": "Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz", "speed": "2000", "type": s.cpuType, "topology": map[string]any{"sockets": strconv.Itoa(hostSockets), "cores": strconv.Itoa(hostCores), "threads": strconv.Itoa(hostThreads)}},
			"os":                   map[string]any{"type": s.hostOS, "version": map[string]any{"full_version": s.hostOSVer}},
			"version":              map[string]any{"full_version": "vdsm-" + s.vdsm},
			"libvirt_version":      map[string]any{"full_version": "libvirt-" + s.libvirt},
			"network_attachments":  map[string]any{}, "summary": map[string]any{"active": strconv.Itoa(vmsPerHost - 1), "total": strconv.Itoa(vmsPerHost - 1)},
		})
	}
	return map[string]any{"host": out}
}

func (en *engine) vmsDoc(follow map[string]bool) map[string]any {
	out := []any{}
	for _, v := range en.vms {
		status := "down"
		if v.up {
			status = "up"
		}
		doc := map[string]any{
			"id": v.id, "href": apiBase + "/vms/" + v.id, "name": v.name, "status": status, "type": "server",
			"cluster": link("clusters", v.cluster.id), "memory": gib(vmMemGiB),
			"cpu": map[string]any{"architecture": "x86_64", "topology": map[string]any{"sockets": strconv.Itoa(vmSockets), "cores": "1", "threads": "1"}},
			"os":  map[string]any{"type": v.guest.osType},
		}
		if v.up {
			doc["host"] = link("hosts", v.host.id)
			doc["fqdn"] = v.fqdn
			doc["guest_operating_system"] = map[string]any{"architecture": "x86_64", "distribution": v.guest.distribution, "family": v.guest.family, "version": map[string]any{"full_version": v.guest.version}}
		}
		nic := map[string]any{"id": uuidOf(v.id + "/nic"), "name": "nic1", "interface": "virtio", "plugged": "true", "linked": "true", "mac": map[string]any{"address": v.mac}}
		if follow["nics.reported_devices"] {
			devices := []any{}
			if v.up {
				devices = append(devices, map[string]any{"name": "eth0", "type": "network", "mac": map[string]any{"address": v.mac},
					"ips": map[string]any{"ip": []any{map[string]any{"address": v.ip, "version": "v4"}, map[string]any{"address": "fe80::546f:ff:fe00:1", "version": "v6"}}}})
			}
			nic["reported_devices"] = map[string]any{"reported_device": devices}
		}
		if follow["nics"] || follow["nics.reported_devices"] {
			doc["nics"] = map[string]any{"nic": []any{nic}}
		}
		attachment := map[string]any{"id": v.diskID, "bootable": "true", "interface": "virtio_scsi", "active": "true", "disk": link("disks", v.diskID)}
		if follow["disk_attachments.disk"] {
			attachment["disk"] = map[string]any{"id": v.diskID, "href": apiBase + "/disks/" + v.diskID, "name": v.name + "_Disk1", "provisioned_size": gib(vmDiskGiB), "actual_size": gib(vmDiskGiB * usedPercent / percent),
				"format": "cow", "status": "ok", "storage_domains": map[string]any{"storage_domain": []any{link("storagedomains", v.domain.id)}}}
		}
		if follow["disk_attachments"] || follow["disk_attachments.disk"] {
			doc["disk_attachments"] = map[string]any{"disk_attachment": []any{attachment}}
		}
		out = append(out, doc)
	}
	return map[string]any{"vm": out}
}

func (en *engine) domainsDoc() map[string]any {
	out := []any{}
	for _, d := range en.domains {
		used := int64(domainGiB * usedPercent / percent)
		storage := map[string]any{"type": d.storageType}
		if d.storageType == "nfs" {
			storage["address"] = d.address
			storage["path"] = d.path
			storage["nfs_version"] = "v4_2"
		} else {
			storage["volume_group"] = map[string]any{"id": hexOf(d.id)[:serialLen]}
		}
		out = append(out, map[string]any{"id": d.id, "href": apiBase + "/storagedomains/" + d.id, "name": d.name, "type": "data", "status": "active", "master": strconv.FormatBool(d.storageType == "nfs"),
			"available": gib(domainGiB - used), "used": gib(used), "committed": gib(int64(d.vms) * vmDiskGiB), "storage": storage, "storage_format": "v5"})
	}
	return map[string]any{"storage_domain": out}
}

func (en *engine) doc(path string, q url.Values) (any, bool) {
	switch path {
	case apiBase, apiBase + "/":
		return en.root(), true
	case apiBase + "/datacenters":
		return map[string]any{"data_center": []any{map[string]any{"id": en.dcID, "href": apiBase + "/datacenters/" + en.dcID, "name": en.dcName, "status": "up", "local": "false", "storage_format": "v5",
			"version": map[string]any{"major": en.spec.major, "minor": en.spec.minor}}}}, true
	case apiBase + "/clusters":
		out := []any{}
		for _, c := range en.clusters {
			out = append(out, map[string]any{"id": c.id, "href": apiBase + "/clusters/" + c.id, "name": c.name, "data_center": link("datacenters", en.dcID),
				"cpu": map[string]any{"architecture": "x86_64", "type": en.spec.cpuType}, "version": map[string]any{"major": en.spec.major, "minor": en.spec.minor}})
		}
		return map[string]any{"cluster": out}, true
	case apiBase + "/hosts":
		return en.hostsDoc(), true
	case apiBase + "/vms":
		follow := map[string]bool{}
		for _, f := range strings.Split(q.Get("follow"), ",") {
			if f = strings.TrimSpace(f); f != "" {
				follow[f] = true
			}
		}
		return en.vmsDoc(follow), true
	case apiBase + "/storagedomains":
		return en.domainsDoc(), true
	}
	return nil, false
}

func fault(w http.ResponseWriter, status int, reason, detail string) {
	sim.WriteJSON(w, status, map[string]any{"reason": reason, "detail": detail})
}

func (en *engine) handler(env *sim.Env) http.Handler {
	user := env.User + authProfile
	bearer := env.Token("ovirt-sso-" + en.spec.key)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == ssoToken {
			if err := r.ParseForm(); err != nil || r.Method != http.MethodPost || r.Form.Get("grant_type") != "password" ||
				r.Form.Get("username") != user || r.Form.Get("password") != env.Secret {
				sim.WriteJSON(w, http.StatusBadRequest, map[string]any{"error_code": "access_denied", "error": "Cannot authenticate user"})
				return
			}
			sim.WriteJSON(w, http.StatusOK, map[string]any{"access_token": bearer, "token_type": "bearer", "scope": "ovirt-app-api", "exp": "0"})
			return
		}
		u, p, basic := r.BasicAuth()
		if !(basic && u == user && p == env.Secret) && !sim.BearerOK(r, bearer) {
			w.Header().Set("WWW-Authenticate", `Basic realm="RESTAPI"`)
			fault(w, http.StatusUnauthorized, "Unauthorized", "authentication required")
			return
		}
		if v := r.Header.Get("Version"); v != "" && v != apiVersion {
			fault(w, http.StatusBadRequest, "Operation Failed", "API version "+v+" is not supported")
			return
		}
		if r.Method != http.MethodGet {
			fault(w, http.StatusMethodNotAllowed, "Operation Failed", "read-only simulator")
			return
		}
		doc, ok := en.doc(r.URL.Path, r.URL.Query())
		if !ok {
			fault(w, http.StatusNotFound, "Not Found", r.URL.Path)
			return
		}
		sim.WriteJSON(w, http.StatusOK, doc)
	})
}

func (Vendor) Start(_ context.Context, _ *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	keys := make([]string, 0, len(engines))
	byKey := map[string]*engine{}
	for _, s := range engines {
		keys = append(keys, s.key)
		byKey[s.key] = generate(s)
	}
	return sim.ServeEach(env, keys, true, func(k string) http.Handler { return byKey[k].handler(env) })
}

func (Vendor) Runs(_ *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	var runs []sim.Run
	for _, s := range engines {
		en := generate(s)
		run := sim.Run{
			Name:           s.key + "-engine",
			Targets:        []sim.Target{{Kind: "host", Value: ep.Devices[s.key], Label: s.product}},
			Options:        map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM, "platform": s.platform},
			CredentialType: "password",
			Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User + authProfile, "password": env.Secret}},
		}
		x := &run.Expect
		for _, c := range en.clusters {
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "vm_cluster", Name: c.name, Identity: map[string]string{"platform": s.platform, "clusterId": c.id}})
		}
		for _, h := range en.hosts {
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "host", Name: h.address, Identity: map[string]string{"fqdn": h.address, "serialNumber": h.serial, "systemUuid": h.uuid}})
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "hypervisor", Name: h.name, Identity: map[string]string{"platform": s.platform, "hostRef": h.address, "moRef": h.id}})
			x.Rel("member_of", "hypervisor", h.name, "vm_cluster", h.cluster.name)
			x.Rel("hosted_on", "hypervisor", h.name, "host", h.address)
		}
		for _, d := range en.domains {
			if d.storageType == "nfs" {
				x.CI("nas_share", d.name)
			} else {
				x.CI("lun", d.name)
			}
		}
		for _, v := range en.vms {
			identity := map[string]string{"instanceUuid": v.id}
			if v.up {
				identity["hypervisorRef"] = v.host.address
				identity["fqdn"] = v.fqdn
			}
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "vm", Name: v.name, Identity: identity})
			dt := "lun"
			if v.domain.storageType == "nfs" {
				dt = "nas_share"
			}
			x.Rel("mounted_on", "vm", v.name, dt, v.domain.name)
			if !v.up {
				continue
			}
			x.Rel("runs_on", "vm", v.name, "hypervisor", v.host.name)
			osName := v.guest.distribution + " " + v.guest.version
			x.CI("operating_system", osName)
			x.Rel("installed_on", "operating_system", osName, "vm", v.name)
			x.CIs = append(x.CIs, sim.ExpectCI{Type: "ip_address", Name: v.ip, Identity: map[string]string{"address": v.ip, "vrfRef": "default"}})
			x.Rel("uses_ip", "vm", v.name, "ip_address", v.ip)
		}
		runs = append(runs, run)
	}
	return runs
}
