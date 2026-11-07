// REQ-QA-005 REQ-DISC-011 — simulated Docker Engine API over TLS with client-certificate authentication, the
// way `dockerd --tlsverify` serves it on 2376: the engine certificate is issued by the simulated-mode CA and
// the engine accepts only client certificates issued by a per-process client CA generated here (handed to the
// collector as a `certificate` credential). Each engine answers /_ping with its Api-Version header, /version,
// and the versioned /v<api>/info, containers/json?all=1, images/json, networks and volumes endpoints, refusing
// API versions outside [MinAPIVersion, ApiVersion] as dockerd does; label filters are honoured.
//
// The estate has no container engines, so the engines are SEEDED: the first Linux VM (by name) of the estate
// serving a web role and the first serving an api role each run a Docker Engine named by the VM's FQDN, with a
// deterministic container set derived from the VM's application (hash-derived ids and digests, no randomness):
// images pulled from Docker Hub, Quay, the site registry and a locally built image, a compose network, the
// default bridge, a host-network container and an exited one. The first engine uses the classic image store,
// the second the containerd image store. Expectations come from that same set.
package docker

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	idHex          = 64
	shortHex       = 12
	serialBits     = 62
	certLifetime   = 24 * time.Hour
	shutdownWait   = 10 * time.Second
	bridgeSubnet   = "172.17.0.0/16"
	bridgeGateway  = "172.17.0.1"
	bridgePrefix   = 16
	composePrefix  = 24
	composeNetBase = 10
	ipHostBase     = 2
	createdBase    = 1793900000
	createdStep    = 3600
	ncpu           = 8
	memTotal       = 33603923968
	compose        = "com.docker.compose.project"
	composeSvc     = "com.docker.compose.service"
	containerdType = "io.containerd.snapshotter.v1"
	clientCAName   = "OpenMap simulated-mode Docker client CA"
	clientName     = "openmap-collector"
)

type Vendor struct{}

func (Vendor) ID() string             { return "docker-engine" }
func (Vendor) Collector() string      { return "docker_engine" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-011"} }

func hexOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

type image struct {
	id, ref string
	digests []string
	labels  map[string]string
	size    int64
}

type network struct {
	name, id, driver, subnet, gateway string
	prefix                            int
}

type container struct {
	id, name, state, status string
	img                     *image
	net                     *network
	ip                      string
	labels                  map[string]string
	ports                   []map[string]any
	volume                  string
}

type engine struct {
	key, name, os, kernel, version, api, minAPI string
	containerd                                  bool
	images                                      []*image
	networks                                    []*network
	containers                                  []*container
	volumes                                     []string
}

func pickVMs(e *estate.Estate) []*estate.CI {
	vms := e.OfType("vm", func(c *estate.CI) bool { return c.Str("guestOsFamily") == "linux" && c.ID("fqdn") != "" })
	sort.SliceStable(vms, func(i, j int) bool { return vms[i].Name < vms[j].Name })
	var out []*estate.CI
	for _, suffix := range []string{"/web", "/api"} {
		for _, v := range vms {
			if strings.HasSuffix(v.Str("applicationRole"), suffix) {
				out = append(out, v)
				break
			}
		}
	}
	return out
}

func osName(guest string) string {
	if strings.HasPrefix(guest, "Ubuntu") {
		return guest + " LTS"
	}
	return guest
}

func seed(vm *estate.CI, index int) *engine {
	app, tier, _ := strings.Cut(vm.Str("applicationRole"), "/")
	site := strings.ToLower(vm.Str("site"))
	en := &engine{key: vm.Name, name: strings.ToLower(vm.ID("fqdn")), os: osName(vm.Str("guestOs")), kernel: "6.8.0-45-generic",
		version: "27.3.1", api: "1.47", minAPI: "1.24"}
	if index > 0 {
		en.version, en.api, en.containerd = "28.5.1", "1.51", true
	}
	if strings.Contains(strings.ToLower(en.os), "red hat") {
		en.kernel = "5.14.0-427.13.1.el9_4.x86_64"
	}
	mk := func(ref string, pulled bool, labels map[string]string) *image {
		img := &image{id: "sha256:" + hexOf("image/" + ref)[:idHex], ref: ref, labels: labels, size: int64(len(ref)) * createdStep}
		repo := ref
		if i := strings.LastIndex(repo, ":"); i > strings.LastIndex(repo, "/") {
			repo = repo[:i]
		}
		// The classic store records a repo digest only on pull; the containerd store gives every image one.
		if pulled || en.containerd {
			img.digests = []string{repo + "@sha256:" + hexOf("digest/" + ref)[:idHex]}
		}
		en.images = append(en.images, img)
		return img
	}
	project := app + "-" + tier
	composeLabels := func(svc string) map[string]string {
		return map[string]string{compose: project, composeSvc: svc}
	}
	appImg := mk("registry."+site+".bank.local/"+app+"/"+tier+":1."+strconv.Itoa(len(app))+".0", true, map[string]string{"org.opencontainers.image.title": app + "-" + tier})
	var sidecar *image
	if tier == "web" {
		sidecar = mk("nginx:1.27-alpine", true, map[string]string{})
	} else {
		sidecar = mk("redis:7.4-alpine", true, map[string]string{})
	}
	exporter := mk("quay.io/prometheus/node-exporter:v1.8.2", true, map[string]string{})
	tools := mk(project+"/tools:1.0", false, composeLabels("tools"))
	batch := mk("alpine:3.20", true, map[string]string{})

	bridge := &network{name: "bridge", id: hexOf(en.name + "/net/bridge")[:idHex], driver: "bridge", subnet: bridgeSubnet, gateway: bridgeGateway, prefix: bridgePrefix}
	third := composeNetBase + index
	app0 := &network{name: project + "_default", id: hexOf(en.name + "/net/" + project)[:idHex], driver: "bridge",
		subnet: "10.201." + strconv.Itoa(third) + ".0/24", gateway: "10.201." + strconv.Itoa(third) + ".1", prefix: composePrefix}
	host := &network{name: "host", id: hexOf(en.name + "/net/host")[:idHex], driver: "host"}
	none := &network{name: "none", id: hexOf(en.name + "/net/none")[:idHex], driver: "null"}
	en.networks = []*network{bridge, app0, host, none}

	n := 0
	add := func(name string, img *image, net *network, state string, labels map[string]string, ports []map[string]any, volume string) {
		c := &container{id: hexOf(en.name + "/container/" + name)[:idHex], name: name, img: img, net: net, state: state, labels: labels, ports: ports, volume: volume}
		c.status = "Up 3 days"
		if state != "running" {
			c.status = "Exited (0) 2 hours ago"
		}
		if state == "running" && net.subnet != "" {
			base := strings.TrimSuffix(net.gateway, ".1")
			c.ip = base + "." + strconv.Itoa(ipHostBase+n)
			n++
		}
		en.containers = append(en.containers, c)
		if volume != "" {
			en.volumes = append(en.volumes, volume)
		}
	}
	add(project+"-"+tier+"-1", appImg, app0, "running", composeLabels(tier), []map[string]any{{"IP": "0.0.0.0", "PrivatePort": 8443, "PublicPort": 8443, "Type": "tcp"}}, "")
	if tier == "web" {
		add(project+"-proxy-1", sidecar, app0, "running", composeLabels("proxy"), []map[string]any{{"IP": "0.0.0.0", "PrivatePort": 443, "PublicPort": 443, "Type": "tcp"}}, "")
	} else {
		add(project+"-cache-1", sidecar, app0, "running", composeLabels("cache"), []map[string]any{{"PrivatePort": 6379, "Type": "tcp"}}, project+"_cache-data")
	}
	add(project+"-tools-1", tools, app0, "running", composeLabels("tools"), nil, "")
	add("node-exporter", exporter, host, "running", map[string]string{}, nil, "")
	add("probe", batch, bridge, "running", map[string]string{}, nil, "")
	add("batch-once", batch, bridge, "exited", map[string]string{}, nil, "")
	return en
}

func engines(e *estate.Estate) []*engine {
	var out []*engine
	for i, vm := range pickVMs(e) {
		out = append(out, seed(vm, i))
	}
	return out
}

func (en *engine) imageByID() map[string]*image {
	m := map[string]*image{}
	for _, i := range en.images {
		m[i.id] = i
	}
	return m
}

type labelFilter []string

func parseFilters(raw string) (labelFilter, error) {
	if raw == "" {
		return nil, nil
	}
	var f map[string][]string
	if err := json.Unmarshal([]byte(raw), &f); err != nil {
		return nil, err
	}
	return f["label"], nil
}

func (f labelFilter) match(labels map[string]string) bool {
	for _, want := range f {
		k, v, hasValue := strings.Cut(want, "=")
		got, ok := labels[k]
		if !ok || (hasValue && got != v) {
			return false
		}
	}
	return true
}

func (en *engine) doc(path string, q url.Values) (any, error) {
	filter, err := parseFilters(q.Get("filters"))
	if err != nil {
		return nil, err
	}
	switch path {
	case "/info":
		running, stopped := 0, 0
		for _, c := range en.containers {
			if c.state == "running" {
				running++
			} else {
				stopped++
			}
		}
		info := map[string]any{"ID": strings.ToUpper(hexOf(en.name + "/engine")[:shortHex]), "Name": en.name, "Containers": len(en.containers), "ContainersRunning": running, "ContainersPaused": 0, "ContainersStopped": stopped,
			"Images": len(en.images), "Driver": "overlay2", "KernelVersion": en.kernel, "OperatingSystem": en.os, "OSVersion": strings.Fields(en.os + " x")[1], "OSType": "linux", "Architecture": "x86_64",
			"NCPU": ncpu, "MemTotal": memTotal, "ServerVersion": en.version, "DefaultRuntime": "runc", "CgroupDriver": "systemd", "CgroupVersion": "2", "Labels": []string{"provenance=" + sim.Provenance},
			"DriverStatus": [][]string{{"Backing Filesystem", "extfs"}}, "Swarm": map[string]any{"LocalNodeState": "inactive", "NodeID": ""}, "SecurityOptions": []string{"name=seccomp,profile=builtin", "name=cgroupns"}}
		if en.containerd {
			info["Driver"] = "overlayfs"
			info["DriverStatus"] = [][]string{{"driver-type", containerdType}}
		}
		return info, nil
	case "/containers/json":
		if q.Get("all") != "1" && q.Get("all") != "true" {
			return nil, errors.New("this simulator lists containers with all=1 only")
		}
		out := []any{}
		for i, c := range en.containers {
			if !filter.match(c.labels) {
				continue
			}
			ep := map[string]any{"NetworkID": c.net.id, "EndpointID": "", "Gateway": "", "IPAddress": "", "IPPrefixLen": 0, "MacAddress": "", "GlobalIPv6Address": ""}
			if c.ip != "" {
				mac := hexOf(c.id + "/mac")
				ep["EndpointID"], ep["Gateway"], ep["IPAddress"], ep["IPPrefixLen"] = hexOf(c.id + "/ep")[:idHex], c.net.gateway, c.ip, c.net.prefix
				ep["MacAddress"] = "02:42:" + mac[0:2] + ":" + mac[2:4] + ":" + mac[4:6] + ":" + mac[6:8]
			}
			mounts := []any{}
			if c.volume != "" {
				mounts = append(mounts, map[string]any{"Type": "volume", "Name": c.volume, "Source": "/var/lib/docker/volumes/" + c.volume + "/_data", "Destination": "/data", "Driver": "local", "RW": true})
			}
			ports := []any{}
			for _, p := range c.ports {
				ports = append(ports, p)
			}
			out = append(out, map[string]any{"Id": c.id, "Names": []string{"/" + c.name}, "Image": c.img.ref, "ImageID": c.img.id, "Command": "/entrypoint.sh", "Created": createdBase + i*createdStep,
				"Ports": ports, "Labels": c.labels, "State": c.state, "Status": c.status, "HostConfig": map[string]any{"NetworkMode": c.net.name},
				"NetworkSettings": map[string]any{"Networks": map[string]any{c.net.name: ep}}, "Mounts": mounts})
		}
		return out, nil
	case "/images/json":
		out := []any{}
		for i, img := range en.images {
			digests := img.digests
			if digests == nil {
				digests = []string{}
			}
			out = append(out, map[string]any{"Id": img.id, "ParentId": "", "RepoTags": []string{img.ref}, "RepoDigests": digests, "Created": createdBase - i*createdStep, "Size": img.size, "SharedSize": -1, "Labels": img.labels, "Containers": -1})
		}
		return out, nil
	case "/networks":
		out := []any{}
		for _, n := range en.networks {
			labels := map[string]string{}
			if strings.HasSuffix(n.name, "_default") {
				labels[compose] = strings.TrimSuffix(n.name, "_default")
			}
			if !filter.match(labels) {
				continue
			}
			var config any
			if n.subnet != "" {
				config = []any{map[string]any{"Subnet": n.subnet, "Gateway": n.gateway}}
			}
			out = append(out, map[string]any{"Name": n.name, "Id": n.id, "Created": "2026-10-01T00:00:00Z", "Scope": "local", "Driver": n.driver, "EnableIPv6": false, "Internal": false, "Attachable": false,
				"IPAM": map[string]any{"Driver": "default", "Options": map[string]any{}, "Config": config}, "Options": map[string]any{}, "Labels": labels})
		}
		return out, nil
	case "/volumes":
		vols := []any{}
		for _, v := range en.volumes {
			labels := map[string]string{compose: strings.SplitN(v, "_", 2)[0]}
			if !filter.match(labels) {
				continue
			}
			vols = append(vols, map[string]any{"Name": v, "Driver": "local", "Scope": "local", "Mountpoint": "/var/lib/docker/volumes/" + v + "/_data", "Labels": labels, "Options": nil})
		}
		return map[string]any{"Volumes": vols, "Warnings": []string{}}, nil
	}
	return nil, nil
}

func apiLess(a, b string) bool {
	am, an, _ := strings.Cut(a, ".")
	bm, bn, _ := strings.Cut(b, ".")
	ai, _ := strconv.Atoi(am)
	bi, _ := strconv.Atoi(bm)
	if ai != bi {
		return ai < bi
	}
	aj, _ := strconv.Atoi(an)
	bj, _ := strconv.Atoi(bn)
	return aj < bj
}

// versionedPath splits "/v1.47/info" into "1.47" and "info"; "/version" is not versioned.
func versionedPath(path string) (string, string, bool) {
	version, rest, ok := strings.Cut(strings.TrimPrefix(path, "/v"), "/")
	if !ok || !strings.HasPrefix(path, "/v") {
		return "", "", false
	}
	major, minor, dotted := strings.Cut(version, ".")
	if _, err := strconv.Atoi(major); err != nil || !dotted {
		return "", "", false
	}
	if _, err := strconv.Atoi(minor); err != nil {
		return "", "", false
	}
	return version, rest, true
}

func engineError(w http.ResponseWriter, status int, msg string) {
	sim.WriteJSON(w, status, map[string]string{"message": msg})
}

func (en *engine) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Api-Version", en.api)
		h.Set("Docker-Experimental", "false")
		h.Set("Ostype", "linux")
		h.Set("Server", "Docker/"+en.version+" (linux)")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			engineError(w, http.StatusMethodNotAllowed, "the simulator serves reads only")
			return
		}
		path := r.URL.Path
		if version, rest, versioned := versionedPath(path); versioned {
			if apiLess(en.api, version) {
				engineError(w, http.StatusBadRequest, "client version "+version+" is too new. Maximum supported API version is "+en.api)
				return
			}
			if apiLess(version, en.minAPI) {
				engineError(w, http.StatusBadRequest, "client version "+version+" is too old. Minimum supported API version is "+en.minAPI+", please upgrade your client to a newer version")
				return
			}
			path = "/" + rest
		}
		switch path {
		case "/_ping":
			h.Set("Swarm", "inactive")
			h.Set("Builder-Version", "2")
			sim.WriteRaw(w, http.StatusOK, "text/plain; charset=utf-8", []byte("OK"))
			return
		case "/version":
			sim.WriteJSON(w, http.StatusOK, map[string]any{"Platform": map[string]any{"Name": "Docker Engine - Community"}, "Version": en.version, "ApiVersion": en.api, "MinAPIVersion": en.minAPI,
				"Os": "linux", "Arch": "amd64", "KernelVersion": en.kernel, "GitCommit": hexOf("git/" + en.version)[:7], "GoVersion": "go1.22.8",
				"Components": []any{map[string]any{"Name": "Engine", "Version": en.version, "Details": map[string]any{"ApiVersion": en.api, "MinAPIVersion": en.minAPI, "Os": "linux"}}}})
			return
		}
		doc, err := en.doc(path, r.URL.Query())
		if err != nil {
			engineError(w, http.StatusBadRequest, err.Error())
			return
		}
		if doc == nil {
			engineError(w, http.StatusNotFound, "page not found")
			return
		}
		sim.WriteJSON(w, http.StatusOK, doc)
	})
}

// clientPKI issues the client CA dockerd trusts (--tlscacert) and one client certificate for the collector.
type clientPKI struct {
	pool            *x509.CertPool
	certPEM, keyPEM string
}

func newClientPKI() (*clientPKI, error) {
	now := time.Now()
	limit := new(big.Int).Lsh(big.NewInt(1), serialBits)
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	sn, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, err
	}
	caTpl := &x509.Certificate{SerialNumber: sn, Subject: pkix.Name{CommonName: clientCAName, Organization: []string{sim.Provenance}}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(certLifetime),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	caDer, err := x509.CreateCertificate(rand.Reader, caTpl, caTpl, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, err
	}
	caCert, err := x509.ParseCertificate(caDer)
	if err != nil {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	sn2, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, err
	}
	tpl := &x509.Certificate{SerialNumber: sn2, Subject: pkix.Name{CommonName: clientName, Organization: []string{sim.Provenance}}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(certLifetime),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, caCert, &key.PublicKey, caKey)
	if err != nil {
		return nil, err
	}
	keyDer, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	pool.AddCert(caCert)
	return &clientPKI{pool: pool, certPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), keyPEM: string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDer}))}, nil
}

// Start serves each engine's API on a loopback backend (which keeps the shared request log) behind a TLS
// front that, like dockerd --tlsverify, requires a client certificate from the client CA.
func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	pki, err := newClientPKI()
	if err != nil {
		return nil, err
	}
	byKey := map[string]*engine{}
	keys := []string{}
	for _, en := range engines(e) {
		byKey[en.key] = en
		keys = append(keys, en.key)
	}
	group, err := sim.ServeEach(env, keys, false, func(k string) http.Handler { return byKey[k].handler() })
	if err != nil {
		return nil, err
	}
	front := map[string]string{}
	for _, k := range keys {
		backend, err := url.Parse(group.Devices[k])
		if err != nil {
			_ = group.Close()
			return nil, err
		}
		ln, port, err := sim.Listen()
		if err != nil {
			_ = group.Close()
			return nil, err
		}
		cfg := &tls.Config{Certificates: []tls.Certificate{env.CA.Leaf}, ClientCAs: pki.pool, ClientAuth: tls.RequireAndVerifyClientCert, MinVersion: tls.VersionTLS12}
		srv := &http.Server{Handler: httputil.NewSingleHostReverseProxy(backend), ReadHeaderTimeout: shutdownWait}
		go func() { _ = srv.Serve(tls.NewListener(ln, cfg)) }()
		group.OnClose(func() error {
			ctx, cancel := context.WithTimeout(context.Background(), shutdownWait)
			defer cancel()
			if err := srv.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
				return err
			}
			return nil
		})
		front[k] = "tcp://" + sim.Address(port)
	}
	group.Devices = front
	group.State["clientCertPem"] = pki.certPEM
	group.State["clientKeyPem"] = pki.keyPEM
	return group, nil
}

func registryOf(ref string) string {
	first, _, found := strings.Cut(ref, "/")
	if found && (strings.ContainsAny(first, ".:") || first == "localhost") {
		return first
	}
	return "docker.io"
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	certPEM, _ := ep.State["clientCertPem"].(string)
	keyPEM, _ := ep.State["clientKeyPem"].(string)
	var runs []sim.Run
	for _, en := range engines(e) {
		run := sim.Run{
			Name:           en.name,
			Targets:        []sim.Target{{Kind: "url", Value: ep.Devices[en.key], Label: en.name}},
			Options:        map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM},
			CredentialType: "certificate",
			Credential:     &sim.Credential{Type: "certificate", Fields: map[string]string{"certificatePem": certPEM, "privateKeyPem": keyPEM}},
		}
		x := &run.Expect
		x.CI("host", en.name)
		x.CI("operating_system", en.os)
		x.Rel("installed_on", "operating_system", en.os, "host", en.name)
		subnetName := map[*network]string{}
		for _, n := range en.networks {
			if n.subnet != "" {
				subnetName[n] = n.name + " " + n.subnet
				x.CI("subnet", subnetName[n])
			}
		}
		registries := map[string]bool{}
		for _, c := range en.containers {
			x.CI("container", c.name)
			x.Rel("runs_on", "container", c.name, "host", en.name)
			// A pulled image proves its registry; a compose-built image is local in either image store.
			if len(c.img.digests) > 0 && c.img.labels[compose] == "" {
				reg := registryOf(c.img.ref)
				if !registries[reg] {
					registries[reg] = true
					x.CI("container_registry", reg)
				}
				x.Rel("backed_by", "container", c.name, "container_registry", reg)
			}
			if c.ip != "" {
				x.CI("ip_address", c.ip)
				x.Rel("uses_ip", "container", c.name, "ip_address", c.ip)
				x.Rel("in_subnet", "ip_address", c.ip, "subnet", subnetName[c.net])
			}
		}
		runs = append(runs, run)
	}
	return runs
}
