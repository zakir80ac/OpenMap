// REQ-QA-005 REQ-DISC-010 — simulated Alibaba Cloud: ECS, RDS and SLB answer RPC-style signed GETs and Container
// Service (ACK) answers ROA-style signed GETs, each product on its own HTTPS listener under the simulated-mode CA.
// Every RPC request's HMAC-SHA1 signature is recomputed from its parameters (percent-encoded canonical query,
// secret + "&"); every ROA request's signature from method, accept, date, the x-acs-* headers and the canonical
// resource. Both reject unknown access keys, stale timestamps and reused nonces with Alibaba's error codes. Lists
// page by PageNumber/PageSize (RDS reports TotalRecordCount) and ACK DescribeClustersV1 by page_number/page_size.
//
// The synthetic estate has no Alibaba Cloud data, so the account below is GENERATED deterministically inside the
// simulator and the expectations come from the same set: one VPC with two VSwitches in me-central-1 (Riyadh), five
// ECS instances (one stopped, one Windows, one with an EIP, one with a public address), three RDS instances, an
// intranet SLB and three ACK clusters, one of them in another region (which the collector must leave out).
package alibaba

import (
	"context"
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // Alibaba Cloud's RPC and ROA signature algorithm is HMAC-SHA1 by specification.
	"encoding/base64"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/cloudsim"
)

const (
	region       = "me-central-1"
	otherRegion  = "me-east-1"
	vpcName      = "prod-vpc"
	keyECS       = "ecs"
	keyRDS       = "rds"
	keySLB       = "slb"
	keyCS        = "cs"
	ecsVersion   = "2014-05-26"
	rdsVersion   = "2014-08-15"
	slbVersion   = "2014-05-15"
	csVersion    = "2015-12-15"
	timestampFmt = "2006-01-02T15:04:05Z"
	idHexLen     = 20
	accountLen   = 16
	keySuffixLen = 18
	firstHost    = 10
	vipHost      = 250
	cpus         = 4
	memoryMb     = 16384
	ackNodes     = 3
)

type Vendor struct{}

func (Vendor) ID() string             { return "alibaba" }
func (Vendor) Collector() string      { return "cloud_alibaba" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-010"} }

var account = cloudsim.Digits("alibaba-account", accountLen)

func accessKeyID(env *sim.Env) string {
	return "LTAI5t" + cloudsim.Hex("alibaba-key"+env.Secret, keySuffixLen)
}

func rid(prefix, seed string) string { return prefix + cloudsim.Hex("alibaba-"+prefix+seed, idHexLen) }

type vswitch struct{ id, name, zone, cidr, prefix string }

type ecs struct {
	id, name, status, vswitch, zone, os, osType, ip, eip, public string
}

type rdsInstance struct{ id, name, engine, version, vswitch, zone string }

type ack struct{ id, name, region string }

type world struct {
	vpcID, vpcCIDR string
	vswitches      []vswitch
	instances      []ecs
	dbs            []rdsInstance
	lbIP, lbID     string
	clusters       []ack
}

func generate() *world {
	b := strconv.Itoa(cloudsim.Byte("alibaba-vpc", 1, 254))
	w := &world{vpcID: rid("vpc-", vpcName), vpcCIDR: "10." + b + ".0.0/16", lbID: rid("lb-", "web")}
	w.vswitches = []vswitch{
		{rid("vsw-", "app"), "app", region + "a", "10." + b + ".1.0/24", "10." + b + ".1."},
		{rid("vsw-", "data"), "data", region + "b", "10." + b + ".2.0/24", "10." + b + ".2."},
	}
	linux, windows := "Alibaba Cloud Linux 3.2104 LTS 64 bit", "Windows Server 2022 Datacenter 64bit"
	pub := func(seed string) string {
		return "47.89." + strconv.Itoa(cloudsim.Byte("alibaba-pub"+seed, 1, 254)) + "." + strconv.Itoa(cloudsim.Byte("alibaba-pub2"+seed, 1, 254))
	}
	specs := []ecs{
		{name: "app-ryd-01", status: "Running", vswitch: "app", os: linux, osType: "linux", eip: pub("app-ryd-01")},
		{name: "app-ryd-02", status: "Running", vswitch: "app", os: linux, osType: "linux"},
		{name: "app-ryd-03", status: "Stopped", vswitch: "app", os: linux, osType: "linux"},
		{name: "win-ryd-01", status: "Running", vswitch: "app", os: windows, osType: "windows", public: pub("win-ryd-01")},
		{name: "batch-ryd-01", status: "Running", vswitch: "data", os: linux, osType: "linux"},
	}
	hosts := map[string]int{}
	for _, s := range specs {
		vs := w.vswitch(s.vswitch)
		s.id, s.zone = rid("i-", s.name), vs.zone
		s.ip = vs.prefix + strconv.Itoa(firstHost+hosts[s.vswitch])
		hosts[s.vswitch]++
		w.instances = append(w.instances, s)
	}
	w.dbs = []rdsInstance{
		{rid("pgm-", "ledger"), "ledger-pg", "PostgreSQL", "16.0", "data", region + "b"},
		{rid("rm-", "cards"), "cards-mysql", "MySQL", "8.0", "data", region + "b"},
		{rid("pgm-", "audit"), "audit-pg", "PostgreSQL", "15.0", "data", region + "b"},
	}
	w.lbIP = w.vswitches[0].prefix + strconv.Itoa(vipHost)
	w.clusters = []ack{{"c" + cloudsim.Hex("ack-pay", idHexLen), "payments-ack", region}, {"c" + cloudsim.Hex("ack-cards", idHexLen), "cards-ack", region}, {"c" + cloudsim.Hex("ack-dr", idHexLen), "dr-ack", otherRegion}}
	return w
}

func (w *world) vswitch(name string) vswitch {
	for _, v := range w.vswitches {
		if v.name == name || v.id == name {
			return v
		}
	}
	return vswitch{}
}

func percentEncode(s string) string {
	e := url.QueryEscape(s)
	e = strings.ReplaceAll(e, "+", "%20")
	e = strings.ReplaceAll(e, "*", "%2A")
	return strings.ReplaceAll(e, "%7E", "~")
}

func hmacSHA1(key, data string) string {
	mac := hmac.New(sha1.New, []byte(key))
	mac.Write([]byte(data))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// nonces remembers every signature nonce, as Alibaba Cloud rejects a nonce reused within its validity window.
type nonces struct {
	mu   sync.Mutex
	seen map[string]bool
}

func (n *nonces) fresh(v string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	if v == "" || n.seen[v] {
		return false
	}
	n.seen[v] = true
	return true
}

func rpcError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	sim.WriteJSON(w, status, map[string]string{"Code": code, "Message": message, "RequestId": cloudsim.UUID("alibaba-req" + r.URL.RawQuery), "HostId": r.Host})
}

// verifyRPC recomputes the RPC signature (Signature Version 1.0) and checks the common parameters.
func verifyRPC(r *http.Request, keyID, secret, version string, seen *nonces, now time.Time) (int, string, string) {
	q := r.URL.Query()
	params := map[string]string{}
	keys := make([]string, 0, len(q))
	for k := range q {
		params[k] = q.Get(k)
		if k != "Signature" {
			keys = append(keys, k)
		}
	}
	if params["AccessKeyId"] != keyID {
		return http.StatusNotFound, "InvalidAccessKeyId.NotFound", "Specified access key is not found."
	}
	if params["SignatureMethod"] != "HMAC-SHA1" || params["SignatureVersion"] != "1.0" || params["Signature"] == "" {
		return http.StatusBadRequest, "IncompleteSignature", "The request signature does not conform to Aliyun standards."
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, percentEncode(k)+"="+percentEncode(params[k]))
	}
	toSign := r.Method + "&" + percentEncode("/") + "&" + percentEncode(strings.Join(parts, "&"))
	if !hmac.Equal([]byte(hmacSHA1(secret+"&", toSign)), []byte(params["Signature"])) {
		return http.StatusBadRequest, "SignatureDoesNotMatch", "Specified signature is not matched with our calculation."
	}
	at, err := time.Parse(timestampFmt, params["Timestamp"])
	if err != nil || !cloudsim.WithinSkew(at, now) {
		return http.StatusBadRequest, "InvalidTimeStamp.Expired", "Specified time stamp or date value is expired."
	}
	if !seen.fresh(params["SignatureNonce"]) {
		return http.StatusBadRequest, "SignatureNonceUsed", "Specified signature nonce was used already."
	}
	if params["Version"] != version || params["Format"] != "JSON" {
		return http.StatusBadRequest, "InvalidVersion", "Specified parameter Version is not valid."
	}
	return 0, "", ""
}

// paged slices a list by PageNumber/PageSize (PageSize capped at cloudsim.PageCap) and returns the page meta.
func paged[T any](q url.Values, all []T) ([]T, int, int) {
	size := cloudsim.Size(q.Get("PageSize"))
	number, err := strconv.Atoi(q.Get("PageNumber"))
	if err != nil || number < 1 {
		number = 1
	}
	start, end, _ := cloudsim.Window(len(all), (number-1)*size, size)
	return all[start:end], number, size
}

func (w *world) ecsDocs(action string, q url.Values) (map[string]any, bool) {
	if q.Get("RegionId") != region {
		empty := &world{}
		return empty.ecsList(action, q)
	}
	return w.ecsList(action, q)
}

func (w *world) ecsList(action string, q url.Values) (map[string]any, bool) {
	switch action {
	case "DescribeInstances":
		docs := []any{}
		for _, i := range w.instances {
			publicIPs := []string{}
			if i.public != "" {
				publicIPs = append(publicIPs, i.public)
			}
			docs = append(docs, map[string]any{"InstanceId": i.id, "InstanceName": i.name, "HostName": i.name, "ZoneId": i.zone, "RegionId": region,
				"InstanceType": "ecs.g7.xlarge", "Status": i.status, "OSName": i.os, "OSType": i.osType, "Cpu": cpus, "Memory": memoryMb,
				"CreationTime": "2026-03-01T08:00Z", "InstanceNetworkType": "vpc",
				"PublicIpAddress": map[string]any{"IpAddress": publicIPs}, "EipAddress": map[string]string{"IpAddress": i.eip},
				"VpcAttributes": map[string]any{"VpcId": w.vpcID, "VSwitchId": w.vswitch(i.vswitch).id, "PrivateIpAddress": map[string]any{"IpAddress": []string{i.ip}}}})
		}
		page, n, size := paged(q, docs)
		return map[string]any{"TotalCount": len(docs), "PageNumber": n, "PageSize": size, "Instances": map[string]any{"Instance": page}}, true
	case "DescribeVpcs":
		docs := []any{}
		if w.vpcID != "" {
			docs = append(docs, map[string]any{"VpcId": w.vpcID, "VpcName": vpcName, "CidrBlock": w.vpcCIDR, "Status": "Available", "RegionId": region})
		}
		page, n, size := paged(q, docs)
		return map[string]any{"TotalCount": len(docs), "PageNumber": n, "PageSize": size, "Vpcs": map[string]any{"Vpc": page}}, true
	case "DescribeVSwitches":
		docs := []any{}
		for _, v := range w.vswitches {
			docs = append(docs, map[string]any{"VSwitchId": v.id, "VSwitchName": v.name, "VpcId": w.vpcID, "CidrBlock": v.cidr, "ZoneId": v.zone, "Status": "Available"})
		}
		page, n, size := paged(q, docs)
		return map[string]any{"TotalCount": len(docs), "PageNumber": n, "PageSize": size, "VSwitches": map[string]any{"VSwitch": page}}, true
	}
	return nil, false
}

func (w *world) rdsDocs(action string, q url.Values) (map[string]any, bool) {
	if action != "DescribeDBInstances" {
		return nil, false
	}
	docs := []any{}
	if q.Get("RegionId") == region {
		for _, d := range w.dbs {
			docs = append(docs, map[string]any{"DBInstanceId": d.id, "DBInstanceDescription": d.name, "Engine": d.engine, "EngineVersion": d.version,
				"DBInstanceStatus": "Running", "DBInstanceClass": "pg.n4.2c.2m", "Category": "HighAvailability", "ZoneId": d.zone, "RegionId": region,
				"VpcId": w.vpcID, "VSwitchId": w.vswitch(d.vswitch).id, "ConnectionString": d.id + ".rds.aliyuncs.com", "DBInstanceNetType": "Intranet"})
		}
	}
	page, n, _ := paged(q, docs)
	return map[string]any{"TotalRecordCount": len(docs), "PageNumber": n, "PageRecordCount": len(page), "Items": map[string]any{"DBInstance": page}}, true
}

func (w *world) slbDocs(action string, q url.Values) (map[string]any, bool) {
	if action != "DescribeLoadBalancers" {
		return nil, false
	}
	docs := []any{}
	if q.Get("RegionId") == region {
		docs = append(docs, map[string]any{"LoadBalancerId": w.lbID, "LoadBalancerName": "web-slb", "LoadBalancerStatus": "active", "Address": w.lbIP,
			"AddressType": "intranet", "LoadBalancerSpec": "slb.s2.small", "VpcId": w.vpcID, "VSwitchId": w.vswitches[0].id, "RegionId": region, "NetworkType": "vpc"})
	}
	page, n, size := paged(q, docs)
	return map[string]any{"TotalCount": len(docs), "PageNumber": n, "PageSize": size, "LoadBalancers": map[string]any{"LoadBalancer": page}}, true
}

func (w *world) rpc(env *sim.Env, version string, docs func(string, url.Values) (map[string]any, bool)) http.Handler {
	seen := &nonces{seen: map[string]bool{}}
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if status, code, msg := verifyRPC(r, accessKeyID(env), env.Secret, version, seen, time.Now()); status != 0 {
			rpcError(rw, r, status, code, msg)
			return
		}
		doc, ok := docs(r.URL.Query().Get("Action"), r.URL.Query())
		if !ok {
			rpcError(rw, r, http.StatusNotFound, "InvalidAction.NotFound", "Specified api is not found, please check your url and method.")
			return
		}
		doc["RequestId"] = cloudsim.UUID("alibaba-req" + r.URL.RawQuery)
		sim.WriteJSON(rw, http.StatusOK, doc)
	})
}

func roaError(w http.ResponseWriter, status int, code, message string) {
	sim.WriteJSON(w, status, map[string]string{"code": code, "message": message})
}

// canonicalResource is the ROA CanonicalizedResource: the path, then the query parameters sorted by name.
func canonicalResource(r *http.Request) string {
	q := r.URL.Query()
	if len(q) == 0 {
		return r.URL.Path
	}
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+q.Get(k))
	}
	return r.URL.Path + "?" + strings.Join(parts, "&")
}

func (w *world) cs(env *sim.Env) http.Handler {
	seen := &nonces{seen: map[string]bool{}}
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		acs := map[string]string{}
		var names []string
		for k, v := range r.Header {
			if lk := strings.ToLower(k); strings.HasPrefix(lk, "x-acs-") {
				acs[lk] = strings.TrimSpace(strings.Join(v, ","))
				names = append(names, lk)
			}
		}
		sort.Strings(names)
		var canonical strings.Builder
		for _, n := range names {
			canonical.WriteString(n + ":" + acs[n] + "\n")
		}
		keyID, sig, _ := strings.Cut(strings.TrimPrefix(r.Header.Get("Authorization"), "acs "), ":")
		if keyID != accessKeyID(env) {
			roaError(rw, http.StatusNotFound, "InvalidAccessKeyId.NotFound", "Specified access key is not found.")
			return
		}
		toSign := r.Method + "\n" + r.Header.Get("Accept") + "\n" + r.Header.Get("Content-MD5") + "\n" + r.Header.Get("Content-Type") + "\n" + r.Header.Get("Date") + "\n" + canonical.String() + canonicalResource(r)
		if acs["x-acs-signature-method"] != "HMAC-SHA1" || !hmac.Equal([]byte(hmacSHA1(env.Secret, toSign)), []byte(sig)) {
			roaError(rw, http.StatusBadRequest, "SignatureDoesNotMatch", "Specified signature is not matched with our calculation.")
			return
		}
		at, err := http.ParseTime(r.Header.Get("Date"))
		if err != nil || !cloudsim.WithinSkew(at, time.Now()) {
			roaError(rw, http.StatusBadRequest, "InvalidTimeStamp.Expired", "Specified time stamp or date value is expired.")
			return
		}
		if !seen.fresh(acs["x-acs-signature-nonce"]) {
			roaError(rw, http.StatusBadRequest, "SignatureNonceUsed", "Specified signature nonce was used already.")
			return
		}
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/clusters" || acs["x-acs-version"] != csVersion {
			roaError(rw, http.StatusNotFound, "InvalidAction.NotFound", "Specified api is not found, please check your url and method.")
			return
		}
		size, err := strconv.Atoi(r.URL.Query().Get("page_size"))
		if err != nil || size <= 0 || size > cloudsim.PageCap {
			size = cloudsim.PageCap
		}
		number, err := strconv.Atoi(r.URL.Query().Get("page_number"))
		if err != nil || number < 1 {
			number = 1
		}
		var docs []any
		for _, c := range w.clusters {
			docs = append(docs, map[string]any{"cluster_id": c.id, "name": c.name, "state": "running", "current_version": "1.32.1-aliyun.1", "size": ackNodes,
				"vpc_id": w.vpcID, "region_id": c.region, "cluster_type": "ManagedKubernetes", "vswitch_id": w.vswitches[0].id})
		}
		start, end, _ := cloudsim.Window(len(docs), (number-1)*size, size)
		sim.WriteJSON(rw, http.StatusOK, map[string]any{"clusters": docs[start:end], "page_info": map[string]int{"page_number": number, "page_size": size, "total_count": len(docs)}})
	})
}

func (Vendor) Start(_ context.Context, _ *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	w := generate()
	handlers := map[string]http.Handler{
		keyECS: w.rpc(env, ecsVersion, w.ecsDocs),
		keyRDS: w.rpc(env, rdsVersion, w.rdsDocs),
		keySLB: w.rpc(env, slbVersion, w.slbDocs),
		keyCS:  w.cs(env),
	}
	return sim.ServeEach(env, []string{keyECS, keyRDS, keySLB, keyCS}, true, func(k string) http.Handler { return handlers[k] })
}

func (Vendor) Runs(_ *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	w := generate()
	run := sim.Run{
		Name:    account,
		Targets: []sim.Target{{Kind: "account", Value: account, Label: "horizon alibaba"}},
		Options: map[string]any{"regionId": region, "ecsUrl": ep.Devices[keyECS], "rdsUrl": ep.Devices[keyRDS], "slbUrl": ep.Devices[keySLB],
			"csUrl": ep.Devices[keyCS], "caCertPem": env.CA.PEM},
		CredentialType: "access_key",
		Credential:     &sim.Credential{Type: "access_key", Fields: map[string]string{"accessKeyId": accessKeyID(env), "accessKeySecret": env.Secret}},
	}
	x := &run.Expect
	x.CI("cloud_account", account)
	x.CI("cloud_resource", vpcName)
	x.Rel("member_of", "cloud_resource", vpcName, "cloud_account", account)
	for _, v := range w.vswitches {
		x.CI("subnet", vpcName+"/"+v.name)
		x.Rel("member_of", "subnet", vpcName+"/"+v.name, "cloud_resource", vpcName)
	}
	for _, i := range w.instances {
		x.CI("vm", i.name)
		x.Rel("member_of", "vm", i.name, "cloud_account", account)
		x.CI("ip_address", i.ip)
		x.Rel("uses_ip", "vm", i.name, "ip_address", i.ip)
		x.Rel("in_subnet", "ip_address", i.ip, "subnet", vpcName+"/"+i.vswitch)
		for _, p := range []string{i.public, i.eip} {
			if p != "" {
				x.CI("ip_address", p)
				x.Rel("uses_ip", "vm", i.name, "ip_address", p)
			}
		}
		x.CI("operating_system", i.os)
		x.Rel("installed_on", "operating_system", i.os, "vm", i.name)
	}
	for _, d := range w.dbs {
		x.CI("database_cluster", d.name)
		x.Rel("member_of", "database_cluster", d.name, "cloud_account", account)
		x.Rel("runs_on", "database_cluster", d.name, "subnet", vpcName+"/"+d.vswitch)
	}
	x.CI("load_balancer", "web-slb")
	x.CI("ip_address", w.lbIP)
	x.Rel("member_of", "load_balancer", "web-slb", "cloud_account", account)
	x.Rel("uses_ip", "load_balancer", "web-slb", "ip_address", w.lbIP)
	for _, c := range w.clusters {
		if c.region != region {
			continue
		}
		x.CI("cloud_resource", c.name)
		x.Rel("member_of", "cloud_resource", c.name, "cloud_account", account)
		x.Rel("runs_on", "cloud_resource", c.name, "cloud_resource", vpcName)
	}
	return []sim.Run{run}
}
