// REQ-DISC-011 — Docker Engine collector: reads the Engine API (unix socket, plain TCP or TLS with a
// client certificate) read-only and inventories the engine as a host, its containers, the registries
// their images were pulled from, and the networks and addresses they use. One target = one engine.
// It never inspects containers, so container environment values are never read.
package docker

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID  = "docker_engine"
	version      = "0.1.0"
	evidenceKind = "api_response"

	// Options.
	optionEndpoint    = "endpoint"    // a unix socket path, a tcp host[:port] or an http(s) engine address
	optionVerify      = "verifyTls"   // verify the engine certificate (with caCertPem or the system pool)
	optionCA          = "caCertPem"   // private CA that signed the engine certificate
	optionLabelFilter = "labelFilter" // "key=value" or a list of them; scopes containers, networks and volumes
	// Credential fields of the `certificate` credential type (CREDENTIAL_FIELDS in packages/contracts).
	credTypeCertificate = "certificate"
	credFieldCert       = "certificatePem"
	credFieldKey        = "privateKeyPem"
	credFieldPassphrase = "passphrase"

	schemeUnix  = "unix"
	schemeTCP   = "tcp"
	schemeHTTP  = "http"
	schemeHTTPS = "https"
	// The Engine API's conventional ports: 2375 plain, 2376 TLS (dockerd --tlsverify).
	defaultPlainPort = 2375
	defaultTLSPort   = 2376
	// Host name the HTTP layer uses when the transport dials a unix socket; the engine ignores it.
	unixHTTPHost = "docker"

	// Highest Engine API version this collector is written against (Docker Engine 27); the collector
	// uses min(this, the engine's Api-Version), raised to the engine's MinAPIVersion if needed.
	clientMaxAPIVersion = "1.47"
	headerAPIVersion    = "Api-Version"
	requestTimeout      = 60 * time.Second

	pathPing       = "/_ping"
	pathVersion    = "/version"
	pathInfo       = "/info"
	pathContainers = "/containers/json"
	pathImages     = "/images/json"
	pathNetworks   = "/networks"
	pathVolumes    = "/volumes"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		// Family: the frozen COLLECTOR_FAMILIES enum has no container-engine family; container runtimes
		// belong to the containers/Kubernetes family (REQ-DISC-011 covers Kubernetes, OpenShift and Docker).
		ID: collectorID, Family: "kubernetes", Version: version, Language: "go",
		Protocols: []string{"docker-engine-api"}, CredentialTypes: []string{"none", credTypeCertificate},
		TargetKinds: []string{"url", "host"}, Emits: []string{typeHost, typeOS, typeContainer, typeRegistry, typeSubnet, typeIP},
		ContractVersion: contract.Version,
	}
}

// Engine API documents (only the fields the collector reads).

type VersionDoc struct {
	Platform struct {
		Name string `json:"Name"`
	} `json:"Platform"`
	Version       string `json:"Version"`
	APIVersion    string `json:"ApiVersion"`
	MinAPIVersion string `json:"MinAPIVersion"`
	Os            string `json:"Os"`
	Arch          string `json:"Arch"`
	KernelVersion string `json:"KernelVersion"`
	GitCommit     string `json:"GitCommit"`
}

type InfoDoc struct {
	ID                string   `json:"ID"`
	Name              string   `json:"Name"`
	Containers        int      `json:"Containers"`
	ContainersRunning int      `json:"ContainersRunning"`
	ContainersPaused  int      `json:"ContainersPaused"`
	ContainersStopped int      `json:"ContainersStopped"`
	Images            int      `json:"Images"`
	Driver            string   `json:"Driver"`
	KernelVersion     string   `json:"KernelVersion"`
	OperatingSystem   string   `json:"OperatingSystem"`
	OSVersion         string   `json:"OSVersion"`
	OSType            string   `json:"OSType"`
	Architecture      string   `json:"Architecture"`
	NCPU              int      `json:"NCPU"`
	MemTotal          int64    `json:"MemTotal"`
	ServerVersion     string   `json:"ServerVersion"`
	DefaultRuntime    string   `json:"DefaultRuntime"`
	CgroupDriver      string   `json:"CgroupDriver"`
	CgroupVersion     string   `json:"CgroupVersion"`
	Labels            []string `json:"Labels"`
	// [["driver-type","io.containerd.snapshotter.v1"]] when the engine uses the containerd image store.
	DriverStatus [][]string `json:"DriverStatus"`
	Swarm        struct {
		LocalNodeState string `json:"LocalNodeState"`
		NodeID         string `json:"NodeID"`
	} `json:"Swarm"`
}

type PortDoc struct {
	IP          string `json:"IP"`
	PrivatePort int    `json:"PrivatePort"`
	PublicPort  int    `json:"PublicPort"`
	Type        string `json:"Type"`
}

type EndpointDoc struct {
	NetworkID         string `json:"NetworkID"`
	IPAddress         string `json:"IPAddress"`
	IPPrefixLen       int    `json:"IPPrefixLen"`
	GlobalIPv6Address string `json:"GlobalIPv6Address"`
	MacAddress        string `json:"MacAddress"`
}

type MountDoc struct {
	Type        string `json:"Type"`
	Name        string `json:"Name"`
	Source      string `json:"Source"`
	Destination string `json:"Destination"`
	RW          bool   `json:"RW"`
}

type ContainerDoc struct {
	ID              string            `json:"Id"`
	Names           []string          `json:"Names"`
	Image           string            `json:"Image"`
	ImageID         string            `json:"ImageID"`
	Created         int64             `json:"Created"`
	Ports           []PortDoc         `json:"Ports"`
	Labels          map[string]string `json:"Labels"`
	State           string            `json:"State"`
	Status          string            `json:"Status"`
	NetworkSettings struct {
		Networks map[string]EndpointDoc `json:"Networks"`
	} `json:"NetworkSettings"`
	Mounts []MountDoc `json:"Mounts"`
}

type ImageDoc struct {
	ID          string            `json:"Id"`
	RepoTags    []string          `json:"RepoTags"`
	RepoDigests []string          `json:"RepoDigests"`
	Labels      map[string]string `json:"Labels"`
	Created     int64             `json:"Created"`
	Size        int64             `json:"Size"`
}

type NetworkDoc struct {
	Name     string `json:"Name"`
	ID       string `json:"Id"`
	Driver   string `json:"Driver"`
	Scope    string `json:"Scope"`
	Internal bool   `json:"Internal"`
	IPAM     struct {
		Config []struct {
			Subnet  string `json:"Subnet"`
			Gateway string `json:"Gateway"`
		} `json:"Config"`
	} `json:"IPAM"`
}

type VolumeDoc struct {
	Name   string `json:"Name"`
	Driver string `json:"Driver"`
	Scope  string `json:"Scope"`
}

type volumeList struct {
	Volumes []VolumeDoc `json:"Volumes"`
}

// Inventory is everything one visit read from the engine.
type Inventory struct {
	APIVersion string
	Version    VersionDoc
	Info       InfoDoc
	Containers []ContainerDoc
	Images     []ImageDoc
	Networks   []NetworkDoc
	Volumes    []VolumeDoc
	Raw        [][]byte
}

// Endpoint is a parsed engine address.
type Endpoint struct {
	Scheme string // unix | http | https
	Host   string // host:port for TCP
	Socket string // socket path for unix
}

// ParseEndpoint reads unix:///path, tcp://host[:port], http(s)://host[:port] or a bare host[:port];
// tcp and bare hosts become https when a client certificate is supplied.
func ParseEndpoint(value string, useTLS bool) (Endpoint, error) {
	if strings.HasPrefix(value, schemeUnix+"://") {
		path := strings.TrimPrefix(value, schemeUnix+"://")
		if path == "" {
			return Endpoint{}, collector.Errorf(contract.ErrInternal, false, "unix endpoint %q names no socket", value)
		}
		return Endpoint{Scheme: schemeUnix, Socket: path}, nil
	}
	scheme := schemeHTTP
	if useTLS {
		scheme = schemeHTTPS
	}
	rest := value
	if s, r, ok := strings.Cut(value, "://"); ok {
		rest = r
		switch s {
		case schemeTCP:
		case schemeHTTP, schemeHTTPS:
			scheme = s
		default:
			return Endpoint{}, collector.Errorf(contract.ErrInternal, false, "unsupported engine endpoint scheme %q", s)
		}
	}
	rest = strings.TrimSuffix(rest, "/")
	if rest == "" {
		return Endpoint{}, collector.Errorf(contract.ErrInternal, false, "engine endpoint %q names no host", value)
	}
	if _, _, err := net.SplitHostPort(rest); err != nil {
		port := defaultPlainPort
		if scheme == schemeHTTPS {
			port = defaultTLSPort
		}
		rest = net.JoinHostPort(rest, strconv.Itoa(port))
	}
	return Endpoint{Scheme: scheme, Host: rest}, nil
}

// Client talks to one engine.
type Client struct {
	base   url.URL
	http   *http.Client
	prefix string
	mu     sync.Mutex
	raw    [][]byte
}

// NewClient builds the HTTP client for an endpoint; tlsCfg is used for https endpoints.
func NewClient(ep Endpoint, tlsCfg *tls.Config) *Client {
	transport := &http.Transport{TLSClientConfig: tlsCfg}
	base := url.URL{Scheme: ep.Scheme, Host: ep.Host}
	if ep.Scheme == schemeUnix {
		socket := ep.Socket
		transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, schemeUnix, socket)
		}
		base = url.URL{Scheme: schemeHTTP, Host: unixHTTPHost}
	}
	return &Client{base: base, http: &http.Client{Timeout: requestTimeout, Transport: transport}}
}

func (c *Client) get(ctx context.Context, path string, query url.Values, out any) (http.Header, error) {
	u := c.base
	u.Path = c.prefix + path
	u.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return nil, restjson.Classify(c.base.Host, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return res.Header, restjson.Classify(c.base.Host, err)
	}
	if err := statusError(c.base.Host, path, res.StatusCode); err != nil {
		return res.Header, err
	}
	if out == nil {
		return res.Header, nil
	}
	c.mu.Lock()
	c.raw = append(c.raw, body)
	c.mu.Unlock()
	if err := json.Unmarshal(body, out); err != nil {
		return res.Header, collector.Errorf(contract.ErrParse, false, "%s: invalid JSON at %s: %v", c.base.Host, path, err)
	}
	return res.Header, nil
}

func statusError(host, path string, status int) error {
	switch {
	case status == http.StatusUnauthorized:
		return collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the client certificate (%d) at %s", host, status, path)
	case status == http.StatusForbidden:
		return collector.Errorf(contract.ErrPermissionDenied, false, "%s denied %s (%d)", host, path, status)
	case status == http.StatusNotFound:
		return collector.Errorf(contract.ErrUnsupportedDevice, false, "%s has no %s", host, path)
	case status >= http.StatusInternalServerError:
		return collector.Errorf(contract.ErrUnreachable, true, "%s returned %d for %s", host, status, path)
	case status >= http.StatusBadRequest:
		return collector.Errorf(contract.ErrUnsupportedDevice, false, "%s returned %d for %s", host, status, path)
	}
	return nil
}

// apiVersionLess compares Engine API versions ("1.41" < "1.47").
func apiVersionLess(a, b string) bool {
	am, an := splitAPIVersion(a)
	bm, bn := splitAPIVersion(b)
	if am != bm {
		return am < bm
	}
	return an < bn
}

func splitAPIVersion(v string) (int, int) {
	major, minor, _ := strings.Cut(strings.TrimPrefix(v, "v"), ".")
	ma, _ := strconv.Atoi(major)
	mi, _ := strconv.Atoi(minor)
	return ma, mi
}

// NegotiateAPIVersion picks min(client, server), raised to the server's minimum.
func NegotiateAPIVersion(server, serverMin string) string {
	v := clientMaxAPIVersion
	if server != "" && apiVersionLess(server, v) {
		v = server
	}
	if serverMin != "" && apiVersionLess(v, serverMin) {
		v = serverMin
	}
	return v
}

// LabelFilters reads the labelFilter option ("k=v" or a list) into the Engine API filters parameter.
func LabelFilters(options map[string]any) string {
	var labels []string
	switch v := options[optionLabelFilter].(type) {
	case string:
		if v != "" {
			labels = []string{v}
		}
	case []any:
		for _, item := range v {
			if s, ok := item.(string); ok && s != "" {
				labels = append(labels, s)
			}
		}
	case []string:
		labels = append(labels, v...)
	}
	if len(labels) == 0 {
		return ""
	}
	b, _ := json.Marshal(map[string][]string{"label": labels})
	return string(b)
}

// Walk negotiates the API version and reads the engine, its containers, images, networks and volumes.
// filters (Engine API JSON) scopes containers, networks and volumes; images are always listed in full
// because a container's image need not carry the container's labels.
func Walk(ctx context.Context, c *Client, filters string) (*Inventory, error) {
	inv := &Inventory{}
	header, err := c.get(ctx, pathPing, nil, nil)
	if err != nil {
		return nil, err
	}
	if _, err := c.get(ctx, pathVersion, nil, &inv.Version); err != nil {
		return nil, err
	}
	server := firstNonEmpty(header.Get(headerAPIVersion), inv.Version.APIVersion)
	inv.APIVersion = NegotiateAPIVersion(server, inv.Version.MinAPIVersion)
	c.prefix = "/v" + inv.APIVersion
	scoped := url.Values{}
	if filters != "" {
		scoped.Set("filters", filters)
	}
	all := url.Values{"all": {"1"}}
	if filters != "" {
		all.Set("filters", filters)
	}
	if _, err := c.get(ctx, pathInfo, nil, &inv.Info); err != nil {
		return nil, err
	}
	if _, err := c.get(ctx, pathContainers, all, &inv.Containers); err != nil {
		return nil, err
	}
	if _, err := c.get(ctx, pathImages, nil, &inv.Images); err != nil {
		return nil, err
	}
	if _, err := c.get(ctx, pathNetworks, scoped, &inv.Networks); err != nil {
		return nil, err
	}
	var vols volumeList
	if _, err := c.get(ctx, pathVolumes, scoped, &vols); err != nil {
		return nil, err
	}
	inv.Volumes = vols.Volumes
	c.mu.Lock()
	inv.Raw = append([][]byte{}, c.raw...)
	c.mu.Unlock()
	return inv, nil
}

func tlsConfig(cred *contract.Credential, options map[string]any) (*tls.Config, bool, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: !restjson.BoolOption(options, optionVerify)} //nolint:gosec // engines use private CAs; verifyTls=true or caCertPem enforce the chain.
	if pem := restjson.StringOption(options, optionCA); pem != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(pem)) {
			return nil, false, collector.Errorf(contract.ErrInternal, false, "caCertPem option holds no PEM certificate")
		}
		cfg.RootCAs = pool
		cfg.InsecureSkipVerify = false
	}
	if cred == nil || cred.Type != credTypeCertificate {
		return cfg, false, nil
	}
	if cred.Fields[credFieldPassphrase] != "" {
		return nil, false, collector.Errorf(contract.ErrAuthFailed, false, "encrypted client keys are not supported; store the engine client key unencrypted in the vault")
	}
	pair, err := tls.X509KeyPair([]byte(cred.Fields[credFieldCert]), []byte(cred.Fields[credFieldKey]))
	if err != nil {
		return nil, false, collector.Errorf(contract.ErrAuthFailed, false, "client certificate: %v", err)
	}
	cfg.Certificates = []tls.Certificate{pair}
	return cfg, true, nil
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	cfg, withCert, err := tlsConfig(cred, options)
	if err != nil {
		return collector.Observation{}, err
	}
	ep, err := ParseEndpoint(firstNonEmpty(restjson.StringOption(options, optionEndpoint), target.Value), withCert)
	if err != nil {
		return collector.Observation{}, err
	}
	inv, err := Walk(ctx, NewClient(ep, cfg), LabelFilters(options))
	if err != nil {
		return collector.Observation{}, err
	}
	return Emit(inv, target, time.Now().UTC()), nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
