// REQ-QA-005 REQ-DISC-014 REQ-DISC-016 — simulated NetApp ONTAP REST API (9.14): HTTP Basic auth (401 with an
// ONTAP error body otherwise), /api/cluster, and the nodes, SVMs, aggregates, volumes, LUNs, LUN maps, igroups,
// CIFS shares and IP interfaces collections as {records, num_records, _links.next}. Pages end at max_records or
// when the simulated return_timeout budget (returnTimeoutRecords) is spent, as ONTAP does, and next links carry
// start.<key> cursors with the caller's fields and max_records. The estate has no NetApp cluster, so one AFF HA
// pair is seeded deterministically from its name (NFS and SAN SVMs, datastore and home volumes, a dp mirror, SAN
// LUNs with 12-character serials, CIFS shares including the hidden admin shares). The igroups are named after,
// and the LUNs mapped to, the estate's first VMware hypervisor hosts at the cluster's site, and the data LIFs take
// free addresses in the estate's storage subnet there; the remaining expectations come from the seeded set.
package ontap

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
	clusterName          = "ryd-ntap-01"
	site                 = "RYD"
	storageSubnet        = "10.8.0.0/24"
	naaPrefix            = "naa.600a0980"
	esxHosts             = 4
	esxLuns              = 4
	returnTimeoutRecords = 3
	defaultMaxRecords    = 10000
	lunSerialLen         = 12
	bytesPerGiB          = 1 << 30
	bytesPerTiB          = 1 << 40
	aggrTiB              = 92
	aggrUsedPercent      = 41
	percent              = 100
	datastoreTiB         = 16
	lunTiB               = 4
	sqlLunGiB            = 2048
	homeTiB              = 8
	firstFreeHost        = 20
	maxHostOctet         = 254
)

type Vendor struct{}

func (Vendor) ID() string             { return "netapp-ontap" }
func (Vendor) Collector() string      { return "storage_ontap" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-014", "REQ-DISC-016"} }

func digest(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

func uuidOf(parts ...string) string {
	h := digest(parts...)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// lunSerial is a 12-character ONTAP LUN serial (printable, as `lun show -fields serial` lists them).
func lunSerial(path string) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-]?+/"
	h := digest(clusterName, "lun", path)
	out := make([]byte, lunSerialLen)
	for i := range out {
		n, _ := strconv.ParseUint(h[i*2:i*2+2], 16, 8)
		out[i] = alphabet[int(n)%len(alphabet)]
	}
	return string(out)
}

func named(name, uuid string) map[string]any { return map[string]any{"name": name, "uuid": uuid} }

// cluster is the seeded cluster: every collection's records plus what the collector must make of them.
type cluster struct {
	doc     map[string]any
	records map[string][]map[string]any
	serial  string
	shares  []shareExpect
	luns    []string
	maps    []mapExpect
	ips     []map[string]string
}

type shareExpect struct{ name, protocol, path string }

type mapExpect struct{ lun, fqdn string }

// keys are the cursor fields ONTAP puts in a collection's next link.
var keys = map[string][]string{"protocols/san/lun-maps": {"lun.uuid", "igroup.uuid"}, "protocols/cifs/shares": {"svm.uuid", "name"}}

var collections = []string{"cluster/nodes", "svm/svms", "storage/aggregates", "storage/volumes", "storage/luns", "protocols/san/lun-maps", "protocols/san/igroups", "protocols/cifs/shares", "network/ip/interfaces"}

func esxTargets(e *estate.Estate) []*estate.CI {
	hosts := e.OfType("host", func(c *estate.CI) bool {
		return c.Str("role") == "hypervisor" && c.Str("platform") == "vmware" && c.Str("site") == site && c.ID("fqdn") != ""
	})
	sort.SliceStable(hosts, func(i, j int) bool { return hosts[i].ID("fqdn") < hosts[j].ID("fqdn") })
	if len(hosts) > esxHosts {
		hosts = hosts[:esxHosts]
	}
	return hosts
}

// freeAddresses returns n addresses of the estate storage subnet that no estate ip_address uses, and the VRF the
// estate files that subnet under.
func freeAddresses(e *estate.Estate, n int) ([]string, string) {
	vrf := ""
	for _, s := range e.OfType("subnet", func(c *estate.CI) bool { return c.ID("cidr") == storageSubnet }) {
		vrf = s.ID("vrfRef")
	}
	used := map[string]bool{}
	for _, ip := range e.OfType("ip_address", nil) {
		used[ip.ID("address")] = true
	}
	prefix := strings.TrimSuffix(strings.SplitN(storageSubnet, "/", 2)[0], "0")
	out := []string{}
	for h := firstFreeHost; h <= maxHostOctet && len(out) < n; h++ {
		if a := prefix + strconv.Itoa(h); !used[a] {
			out = append(out, a)
		}
	}
	return out, vrf
}

func build(e *estate.Estate) *cluster {
	c := &cluster{records: map[string][]map[string]any{}}
	put := func(coll string, r map[string]any) { c.records[coll] = append(c.records[coll], r) }
	cu := uuidOf(clusterName)
	c.doc = map[string]any{"name": clusterName, "uuid": cu, "version": map[string]any{"full": "NetApp Release 9.14.1P6: Wed Jul 10 05:27:14 UTC 2024", "generation": 9, "major": 14, "minor": 1},
		"_links": map[string]any{"self": map[string]string{"href": "/api/cluster"}}}
	nodes := []string{clusterName + "-01", clusterName + "-02"}
	for i, n := range nodes {
		serial := "72123400" + strconv.Itoa(1000+i*7+int(digest(n)[0]%10))
		if i == 0 {
			c.serial = serial
		}
		partner := nodes[1-i]
		put("cluster/nodes", map[string]any{"name": n, "uuid": uuidOf(n), "serial_number": serial, "model": "AFF-A400", "state": "up",
			"ha": map[string]any{"partners": []any{named(partner, uuidOf(partner))}}})
	}
	nas, san := "svm_nas_ryd", "svm_san_ryd"
	put("svm/svms", map[string]any{"name": nas, "uuid": uuidOf(nas), "state": "running", "nfs": map[string]bool{"enabled": true}, "cifs": map[string]bool{"enabled": true}, "iscsi": map[string]bool{"enabled": false}, "fcp": map[string]bool{"enabled": false}})
	put("svm/svms", map[string]any{"name": san, "uuid": uuidOf(san), "state": "running", "nfs": map[string]bool{"enabled": false}, "cifs": map[string]bool{"enabled": false}, "iscsi": map[string]bool{"enabled": true}, "fcp": map[string]bool{"enabled": true}})
	aggrs := []string{}
	for i, n := range nodes {
		a := "aggr1_" + strings.ReplaceAll(n, "-", "_")
		aggrs = append(aggrs, a)
		size := int64(aggrTiB) * bytesPerTiB
		put("storage/aggregates", map[string]any{"name": a, "uuid": uuidOf(a), "state": "online", "node": named(n, uuidOf(n)),
			"space": map[string]any{"block_storage": map[string]any{"size": size, "used": size * int64(aggrUsedPercent+i) / percent, "available": size - size*int64(aggrUsedPercent+i)/percent}}})
	}
	volume := func(name, svm, path, typ string, aggr int, tib int64) {
		size := tib * bytesPerTiB
		put("storage/volumes", map[string]any{"name": name, "uuid": uuidOf("vol", svm, name), "state": "online", "type": typ, "style": "flexvol",
			"svm": named(svm, uuidOf(svm)), "aggregates": []any{named(aggrs[aggr], uuidOf(aggrs[aggr]))},
			"space": map[string]any{"size": size, "used": size / 3, "available": size - size/3},
			"nas":   map[string]any{"path": path, "security_style": "unix", "export_policy": named("default", "")}})
	}
	volume(nas+"_root", nas, "/", "rw", 0, 1)
	volume("vmware_ds01", nas, "/vmware_ds01", "rw", 0, datastoreTiB)
	volume("vmware_ds02", nas, "/vmware_ds02", "rw", 1, datastoreTiB)
	volume("home", nas, "/home", "rw", 1, homeTiB)
	volume("vmware_ds01_dr", nas, "/vmware_ds01_dr", "dp", 1, datastoreTiB)
	volume(san+"_root", san, "", "rw", 0, 1)
	volume("esx_lun_vol01", san, "", "rw", 0, datastoreTiB+1)
	volume("sql_lun_vol01", san, "", "rw", 1, lunTiB)
	for _, p := range []string{"/vmware_ds01", "/vmware_ds02", "/home"} {
		c.shares = append(c.shares, shareExpect{nas + ":" + p, "nfs", p})
	}
	lun := func(path, vol, osType string, size int64, mapped bool) {
		put("storage/luns", map[string]any{"name": path, "uuid": uuidOf("lun", path), "serial_number": lunSerial(path), "os_type": osType, "enabled": true,
			"svm": named(san, uuidOf(san)), "space": map[string]any{"size": size, "used": size / 2},
			"status": map[string]any{"state": "online", "mapped": mapped}, "location": map[string]any{"logical_unit": strings.TrimPrefix(path, "/vol/"+vol+"/"), "volume": named(vol, uuidOf("vol", san, vol))}})
		c.luns = append(c.luns, path)
	}
	hosts := esxTargets(e)
	for i := 0; i < esxLuns; i++ {
		lun("/vol/esx_lun_vol01/lun"+strconv.Itoa(i), "esx_lun_vol01", "vmware", int64(lunTiB)*bytesPerTiB, len(hosts) > 0)
	}
	lun("/vol/sql_lun_vol01/lun0", "sql_lun_vol01", "windows_2008", int64(sqlLunGiB)*bytesPerGiB, false)
	for _, h := range hosts {
		g := strings.ToLower(h.ID("fqdn"))
		gid := uuidOf("igroup", g)
		wwpn := "20:00:00:25:b5:" + digest(g)[0:2] + ":" + digest(g)[2:4] + ":" + digest(g)[4:6]
		put("protocols/san/igroups", map[string]any{"name": g, "uuid": gid, "os_type": "vmware", "protocol": "fcp", "svm": named(san, uuidOf(san)),
			"initiators": []any{map[string]string{"name": wwpn}, map[string]string{"name": "20:00:00:25:b5:" + digest(g)[6:8] + ":" + digest(g)[8:10] + ":" + digest(g)[10:12]}}})
		for i := 0; i < esxLuns; i++ {
			path := "/vol/esx_lun_vol01/lun" + strconv.Itoa(i)
			put("protocols/san/lun-maps", map[string]any{"svm": named(san, uuidOf(san)), "lun": named(path, uuidOf("lun", path)), "igroup": named(g, gid), "logical_unit_number": i})
			c.maps = append(c.maps, mapExpect{path, g})
		}
	}
	for _, s := range []struct{ name, path string }{{"home", "/home"}, {"vmware_ds01", "/vmware_ds01"}, {"c$", "/"}, {"ipc$", "/"}} {
		put("protocols/cifs/shares", map[string]any{"name": s.name, "path": s.path, "svm": named(nas, uuidOf(nas))})
		if s.path != "/" {
			c.shares = append(c.shares, shareExpect{nas + `\` + s.name, "smb", `\\` + nas + `\` + s.name})
		}
	}
	addrs, vrf := freeAddresses(e, 3)
	lifs := []struct {
		name, svm string
		services  []string
	}{{"cluster_mgmt", "", []string{"management_core", "management_autosupport", "management_access"}}, {"lif_nas_01", nas, []string{"data_core", "data_nfs", "data_cifs"}}, {"lif_san_iscsi_01", san, []string{"data_core", "data_iscsi"}}}
	for i, l := range lifs {
		if i >= len(addrs) {
			break
		}
		r := map[string]any{"name": l.name, "uuid": uuidOf("lif", l.name), "ip": map[string]string{"address": addrs[i], "netmask": "24", "family": "ipv4"}, "services": l.services, "state": "up", "scope": "svm"}
		if l.svm != "" {
			r["svm"] = named(l.svm, uuidOf(l.svm))
		} else {
			r["scope"] = "cluster"
		}
		put("network/ip/interfaces", r)
		c.ips = append(c.ips, map[string]string{"address": addrs[i], "vrfRef": vrf})
	}
	return c
}

func lookup(r map[string]any, dotted string) string {
	var cur any = r
	for _, p := range strings.Split(dotted, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		cur = m[p]
	}
	s, _ := cur.(string)
	return s
}

func ontapError(w http.ResponseWriter, status int, code, msg string) {
	sim.WriteJSON(w, status, map[string]any{"error": map[string]any{"message": msg, "code": code}})
}

func (c *cluster) page(coll string, q url.Values) map[string]any {
	all := c.records[coll]
	ks := keys[coll]
	if ks == nil {
		ks = []string{"uuid"}
	}
	start := 0
	if q.Has("start." + ks[0]) {
		start = len(all)
		for i, r := range all {
			match := true
			for _, k := range ks {
				if lookup(r, k) != q.Get("start."+k) {
					match = false
				}
			}
			if match {
				start = i
				break
			}
		}
	}
	limit := defaultMaxRecords
	if n, err := strconv.Atoi(q.Get("max_records")); err == nil && n > 0 {
		limit = n
	}
	if limit > returnTimeoutRecords {
		limit = returnTimeoutRecords
	}
	end := start + limit
	if end > len(all) {
		end = len(all)
	}
	self := "/api/" + coll + "?" + q.Encode()
	links := map[string]any{"self": map[string]string{"href": self}}
	if end < len(all) {
		nq := url.Values{}
		for k, v := range q {
			if !strings.HasPrefix(k, "start.") {
				nq[k] = v
			}
		}
		for _, k := range ks {
			nq.Set("start."+k, lookup(all[end], k))
		}
		links["next"] = map[string]string{"href": "/api/" + coll + "?" + nq.Encode()}
	}
	recs := make([]any, 0, end-start)
	for _, r := range all[start:end] {
		recs = append(recs, r)
	}
	return map[string]any{"records": recs, "num_records": len(recs), "_links": links}
}

func (c *cluster) handler(env *sim.Env) http.Handler {
	known := map[string]bool{}
	for _, k := range collections {
		known[k] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !env.BasicOK(r) {
			w.Header().Set("WWW-Authenticate", `Basic realm="ONTAP"`)
			ontapError(w, http.StatusUnauthorized, "6691623", "User is not authorized.")
			return
		}
		if r.Method != http.MethodGet {
			ontapError(w, http.StatusMethodNotAllowed, "3", "Method not allowed.")
			return
		}
		coll := strings.TrimPrefix(strings.TrimSuffix(r.URL.Path, "/"), "/api/")
		switch {
		case coll == "cluster":
			sim.WriteJSON(w, http.StatusOK, c.doc)
		case known[coll]:
			sim.WriteJSON(w, http.StatusOK, c.page(coll, r.URL.Query()))
		default:
			ontapError(w, http.StatusNotFound, "4", "API not found")
		}
	})
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	ep, _, err := sim.ServeHTTPS(env, build(e).handler(env))
	return ep, err
}

func wwn(serial string) string { return naaPrefix + hex.EncodeToString([]byte(serial)) }

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	c := build(e)
	run := sim.Run{
		Name:           clusterName,
		Targets:        []sim.Target{{Kind: "host", Value: ep.URL, Label: clusterName}},
		Options:        map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM},
		CredentialType: "password",
		Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User, "password": env.Secret}},
	}
	x := &run.Expect
	x.CIs = append(x.CIs, sim.ExpectCI{Type: "storage_array", Name: clusterName, Identity: map[string]string{"serialNumber": c.serial}})
	for _, s := range c.shares {
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "nas_share", Name: s.name, Identity: map[string]string{"arrayRef": c.serial, "protocol": s.protocol, "path": s.path}})
		x.Rel("contains", "storage_array", clusterName, "nas_share", s.name)
	}
	for _, l := range c.luns {
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "lun", Name: l, Identity: map[string]string{"arrayRef": c.serial, "wwn": wwn(lunSerial(l))}})
		x.Rel("contains", "storage_array", clusterName, "lun", l)
	}
	for _, m := range c.maps {
		x.RelToRef("presented_to", "lun", m.lun, "host", map[string]string{"fqdn": m.fqdn})
	}
	// The data LIFs sit in the estate's storage subnet, so the estate's VRF is the identity they must merge with.
	for _, ip := range c.ips {
		x.CIs = append(x.CIs, sim.ExpectCI{Type: "ip_address", Name: ip["address"], Identity: ip})
		x.Rel("uses_ip", "storage_array", clusterName, "ip_address", ip["address"])
	}
	return []sim.Run{run}
}
