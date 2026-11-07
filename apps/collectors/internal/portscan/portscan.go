// REQ-DISC-020 REQ-DISC-030 — port scan and service fingerprint collector: TCP connect scan over a
// port list, banner grab, TLS probe and service classification from banners. Hosts that answer
// are emitted as `host` when reverse DNS names them and as `unknown` otherwise, so the console can
// label them; every open port becomes a listening_service for the autodiscovery view.
package portscan

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	collectorID        = "port_scan"
	version            = "0.1.0"
	evidenceKind       = "cli_output"
	optionPorts        = "ports"
	optionConnectMs    = "connectTimeoutMs"
	optionBannerMs     = "bannerTimeoutMs"
	optionConcurrency  = "portConcurrency"
	defaultConnectMs   = 1500
	defaultBannerMs    = 1500
	defaultConcurrency = 64
	bannerBytes        = 512
	defaultVrf         = "default"

	typeHost     = "host"
	typeUnknown  = "unknown"
	typeIP       = "ip_address"
	typeListener = "listening_service"
	relUsesIP    = "uses_ip"
	relRunsOn    = "runs_on"
)

// DefaultPorts is the probe set used when the job names none: the services that identify a
// device class (management, web, database, directory, file, hypervisor and BMC ports).
var DefaultPorts = []int{21, 22, 23, 25, 53, 80, 88, 110, 111, 135, 139, 143, 161, 389, 443, 445, 465, 514, 587, 636, 902, 993, 995, 1433, 1521, 2049, 2375, 2379, 3000, 3128, 3268, 3306, 3389, 4443, 5000, 5060, 5432, 5672, 5900, 5985, 5986, 6379, 6443, 7443, 8000, 8006, 8080, 8081, 8443, 8880, 9000, 9090, 9100, 9200, 9440, 10250, 27017}

// tlsFirstPorts speak TLS before any banner, so the probe handshakes instead of waiting for bytes.
var tlsFirstPorts = map[int]bool{443: true, 465: true, 636: true, 902: true, 993: true, 995: true, 3269: true, 4443: true, 5986: true, 6443: true, 7443: true, 8443: true, 9440: true, 10250: true}

// httpPorts receive a HEAD request to coax a Server header out of quiet web servers.
var httpPorts = map[int]bool{80: true, 3000: true, 3128: true, 5000: true, 8000: true, 8006: true, 8080: true, 8081: true, 8880: true, 9000: true, 9090: true, 9100: true, 9200: true}

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "port_scan", Version: version, Language: "go",
		Protocols: []string{"tcp"}, CredentialTypes: []string{"none"},
		TargetKinds: []string{"host", "cidr"}, Emits: []string{typeHost, typeUnknown, typeIP, typeListener},
		ContractVersion: contract.Version,
	}
}

// Port is one open port's probe result.
type Port struct {
	Port    int
	Banner  string
	TLS     bool
	TLSName string // leaf certificate CN or first SAN
	Service string
	Product string
	Version string
	// raw is the banner as received, kept for parsers that need the binary framing printable() hides.
	raw []byte
}

var bannerRules = []struct {
	service string
	re      *regexp.Regexp
}{
	{"ssh", regexp.MustCompile(`^SSH-[\d.]+-(\S+)`)},
	{"http", regexp.MustCompile(`^HTTP/[\d.]+ \d+`)},
	{"smtp", regexp.MustCompile(`^220[ -].*(SMTP|ESMTP|Postfix|Exim|Exchange)`)},
	// Product names before the generic keyword, case-insensitive and leftmost: "220 (vsFTPd 3.0.5)"
	// must yield vsFTPd, not the "FTP" inside it.
	{"ftp", regexp.MustCompile(`(?i)^220[ -].*?(FileZilla|vsftpd|ProFTPD|Pure-FTPd|FTP)`)},
	{"pop3", regexp.MustCompile(`^\+OK`)},
	{"imap", regexp.MustCompile(`^\* OK`)},
	{"mysql", regexp.MustCompile(`^.{4}\n([\d.]+-?[\w.-]*)\.`)},
	{"redis", regexp.MustCompile(`^-(NOAUTH|ERR)`)},
	{"telnet", regexp.MustCompile(`^\xff[\xfb-\xfe]`)},
}

var serverHeader = regexp.MustCompile(`(?im)^Server:\s*([^\r\n]+)`)

// portServices names services whose banner is silent or binary.
var portServices = map[int]string{21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "dns", 80: "http", 88: "kerberos", 110: "pop3", 111: "rpcbind", 135: "msrpc", 139: "netbios", 143: "imap", 161: "snmp", 389: "ldap", 443: "https", 445: "smb", 465: "smtps", 514: "syslog", 587: "submission", 636: "ldaps", 902: "vmware-authd", 993: "imaps", 995: "pop3s", 1433: "mssql", 1521: "oracle", 2049: "nfs", 2375: "docker", 2379: "etcd", 3128: "proxy", 3268: "ldap-gc", 3306: "mysql", 3389: "rdp", 4443: "https-alt", 5060: "sip", 5432: "postgresql", 5672: "amqp", 5900: "vnc", 5985: "winrm", 5986: "winrm-https", 6379: "redis", 6443: "kubernetes-api", 8006: "proxmox", 8080: "http-alt", 8443: "https-alt", 9200: "elasticsearch", 9440: "nutanix-prism", 10250: "kubelet", 27017: "mongodb"}

// httpAPIServices answer Probe's HEAD as plain HTTP without a Server header (OpenSearch and
// Elasticsearch on 9200), so the registered port service, not "http", names them.
var httpAPIServices = map[string]bool{"elasticsearch": true}

// Classify fills Service/Product/Version from the banner and port.
func Classify(p *Port) {
	for _, r := range bannerRules {
		if m := r.re.FindStringSubmatch(p.Banner); m != nil {
			p.Service = r.service
			if len(m) > 1 {
				p.Product = m[1]
			}
			break
		}
	}
	if p.Service == "http" || p.Service == "" && strings.HasPrefix(p.Banner, "HTTP/") {
		p.Service = "http"
		if m := serverHeader.FindStringSubmatch(p.Banner); m != nil {
			p.Product = strings.TrimSpace(m[1])
		}
		if p.Product == "" && httpAPIServices[portServices[p.Port]] {
			p.Service = portServices[p.Port]
		}
	}
	if p.Service == "mysql" {
		if v := mysqlHandshakeVersion(p.raw); v != "" {
			p.Product = v
		}
	}
	if p.Service == "ssh" {
		if i := strings.Index(p.Product, "_"); i > 0 {
			p.Version = p.Product[i+1:]
			p.Product = p.Product[:i]
		}
	}
	if p.Service == "" {
		p.Service = portServices[p.Port]
	}
	if p.TLS && p.Service == "http" {
		p.Service = "https"
	}
	if p.Service == "" {
		p.Service = "unknown"
	}
}

func readBanner(conn net.Conn, timeout time.Duration) string {
	return printable(readRaw(conn, timeout))
}

func readRaw(conn net.Conn, timeout time.Duration) []byte {
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	buf := make([]byte, bannerBytes)
	n, _ := bufio.NewReader(conn).Read(buf)
	return buf[:n]
}

// mysqlHandshakeVersion reads the server version from a MySQL / MariaDB protocol-10 handshake
// (3-byte length, sequence id, 0x0a, NUL-terminated version). printable() turns the terminator and
// the connection id into '.', which the version itself may contain, so the boundary needs the raw bytes.
func mysqlHandshakeVersion(raw []byte) string {
	const headerLen, protocolV10 = 4, 0x0a
	if len(raw) <= headerLen+1 || raw[headerLen] != protocolV10 {
		return ""
	}
	end := bytes.IndexByte(raw[headerLen+1:], 0)
	if end <= 0 {
		return ""
	}
	v := raw[headerLen+1 : headerLen+1+end]
	for _, c := range v {
		if c < ' ' || c >= 0x7f {
			return ""
		}
	}
	return string(v)
}

// printable keeps the banner as text: binary protocol bytes (MySQL, Postgres, RDP) become '.',
// so banners stay safe for JSON, jsonb and the console while the classifier still sees the shape.
func printable(b []byte) string {
	out := make([]rune, 0, len(b))
	for _, c := range b {
		switch {
		case c == '\t' || c == '\n' || c == '\r':
			out = append(out, rune(c))
		case c < ' ' || c == 0x7f:
			out = append(out, '.')
		default:
			out = append(out, rune(c))
		}
	}
	return strings.TrimRight(string(out), "\r\n.")
}

func tlsName(state tls.ConnectionState) string {
	if len(state.PeerCertificates) == 0 {
		return ""
	}
	c := state.PeerCertificates[0]
	if c.Subject.CommonName != "" {
		return c.Subject.CommonName
	}
	if len(c.DNSNames) > 0 {
		return c.DNSNames[0]
	}
	return ""
}

func headRequest(host string) string { return "HEAD / HTTP/1.0\r\nHost: " + host + "\r\n\r\n" }

// Probe connects to one port and gathers a banner or TLS facts. nil means closed or filtered.
func Probe(ctx context.Context, host string, port int, connectTimeout, bannerTimeout time.Duration) *Port {
	d := &net.Dialer{Timeout: connectTimeout}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil
	}
	p := &Port{Port: port}
	if tlsFirstPorts[port] {
		tc := tls.Client(conn, &tls.Config{InsecureSkipVerify: true, ServerName: host, MinVersion: tls.VersionTLS10}) //nolint:gosec // fingerprinting only; certificates are inventoried by the certificate collector.
		_ = tc.SetDeadline(time.Now().Add(bannerTimeout))
		if err := tc.HandshakeContext(ctx); err == nil {
			p.TLS = true
			p.TLSName = tlsName(tc.ConnectionState())
			if httpPorts[port] || port == 443 || port == 8443 || port == 4443 || port == 7443 || port == 9440 || port == 8006 {
				_, _ = tc.Write([]byte(headRequest(host)))
				p.Banner = readBanner(tc, bannerTimeout)
			}
		}
		_ = tc.Close()
		Classify(p)
		return p
	}
	if httpPorts[port] {
		_ = conn.SetWriteDeadline(time.Now().Add(bannerTimeout))
		_, _ = conn.Write([]byte(headRequest(host)))
	}
	p.raw = readRaw(conn, bannerTimeout)
	p.Banner = printable(p.raw)
	_ = conn.Close()
	if p.Banner == "" && !httpPorts[port] {
		// A port no table names may still be a web service (HTTP or HTTPS on 4343, 8834, 9443 ...): such a
		// silent port is asked with HEAD, inside TLS when the handshake succeeds, in clear text otherwise.
		unlisted := portServices[port] == ""
		// Silent service: a TLS handshake tells us whether it is an unlisted TLS port.
		if conn2, err := d.DialContext(ctx, "tcp", addr); err == nil {
			tc := tls.Client(conn2, &tls.Config{InsecureSkipVerify: true, ServerName: host, MinVersion: tls.VersionTLS10}) //nolint:gosec // see above
			_ = tc.SetDeadline(time.Now().Add(bannerTimeout))
			if err := tc.HandshakeContext(ctx); err == nil {
				p.TLS = true
				p.TLSName = tlsName(tc.ConnectionState())
				if unlisted {
					_ = tc.SetDeadline(time.Now().Add(bannerTimeout))
					_, _ = tc.Write([]byte(headRequest(host)))
					p.Banner = readBanner(tc, bannerTimeout)
				}
			}
			_ = tc.Close()
		}
		if unlisted && !p.TLS {
			if conn3, err := d.DialContext(ctx, "tcp", addr); err == nil {
				_ = conn3.SetWriteDeadline(time.Now().Add(bannerTimeout))
				_, _ = conn3.Write([]byte(headRequest(host)))
				p.raw = readRaw(conn3, bannerTimeout)
				p.Banner = printable(p.raw)
				_ = conn3.Close()
			}
		}
	}
	Classify(p)
	return p
}

// Scan probes every port with bounded concurrency and returns the open ones sorted.
func Scan(ctx context.Context, host string, ports []int, concurrency int, connectTimeout, bannerTimeout time.Duration) []Port {
	sem := make(chan struct{}, concurrency)
	var mu sync.Mutex
	var wg sync.WaitGroup
	var open []Port
	for _, port := range ports {
		wg.Add(1)
		sem <- struct{}{}
		go func(port int) {
			defer wg.Done()
			defer func() { <-sem }()
			if p := Probe(ctx, host, port, connectTimeout, bannerTimeout); p != nil {
				mu.Lock()
				open = append(open, *p)
				mu.Unlock()
			}
		}(port)
	}
	wg.Wait()
	sort.Slice(open, func(i, j int) bool { return open[i].Port < open[j].Port })
	return open
}

// Emit turns scan results into observations. `rdns` is the PTR name when one resolved.
func Emit(address, rdns string, open []Port, at time.Time) collector.Observation {
	obs := collector.Observation{}
	var lines []string
	for _, p := range open {
		lines = append(lines, strconv.Itoa(p.Port)+"\t"+p.Service+"\t"+strings.ReplaceAll(p.Banner, "\n", " "))
	}
	obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: []byte(strings.Join(lines, "\n"))})
	services := []string{}
	tlsNames := []string{}
	for _, p := range open {
		services = append(services, p.Service)
		if p.TLSName != "" {
			tlsNames = append(tlsNames, p.TLSName)
		}
	}
	hostType := typeUnknown
	identity := map[string]string{"address": address}
	name := address
	hostRef := address
	if rdns != "" {
		hostType = typeHost
		identity = map[string]string{"fqdn": strings.ToLower(rdns)}
		name = strings.ToLower(rdns)
		hostRef = name
	} else if len(tlsNames) > 0 && net.ParseIP(tlsNames[0]) == nil && strings.Contains(tlsNames[0], ".") {
		name = address + " (" + tlsNames[0] + ")"
	}
	hostCi := contract.ObservedCi{Type: hostType, Identity: identity, Name: name,
		Attributes: map[string]any{"address": address, "reverseDns": rdns, "openPorts": len(open), "services": services, "tlsNames": tlsNames, "classification": guessClass(open), "lastSeenDays": 0},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at}
	obs.Cis = append(obs.Cis, hostCi)
	hostRefCi := contract.CiRef{Type: hostType, Identity: identity}
	ipIdentity := map[string]string{"address": address, "vrfRef": defaultVrf}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: address, Attributes: map[string]any{"assignedTo": name, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
	obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: hostRefCi, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
	for _, p := range open {
		lsIdentity := map[string]string{"hostRef": hostRef, "protocol": "tcp", "port": strconv.Itoa(p.Port)}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: lsIdentity, Name: "tcp/" + strconv.Itoa(p.Port) + " " + p.Service,
			Attributes: map[string]any{"protocol": "tcp", "port": p.Port, "service": p.Service, "product": p.Product, "version": p.Version, "banner": p.Banner, "tls": p.TLS, "tlsName": p.TLSName, "source": collectorID},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: contract.CiRef{Type: typeListener, Identity: lsIdentity}, To: hostRefCi, Attributes: map[string]any{}, ObservedAt: at})
	}
	return obs
}

// guessClass offers a first classification for the unknown-device view from the open port mix.
func guessClass(open []Port) string {
	has := map[string]bool{}
	for _, p := range open {
		has[p.Service] = true
	}
	switch {
	case has["nutanix-prism"]:
		return "nutanix-prism"
	case has["proxmox"]:
		return "proxmox-host"
	case has["vmware-authd"]:
		return "vmware-esxi"
	case has["kubernetes-api"] || has["kubelet"]:
		return "kubernetes-node"
	case has["winrm"] || has["winrm-https"] || has["rdp"] || has["msrpc"]:
		return "windows-host"
	case has["mssql"] || has["postgresql"] || has["mysql"] || has["oracle"] || has["mongodb"] || has["redis"] || has["elasticsearch"]:
		return "database-server"
	case has["snmp"] && has["telnet"]:
		return "network-device"
	case has["ssh"] && has["snmp"]:
		return "network-or-linux-device"
	case has["ssh"]:
		return "linux-host"
	case has["https"] || has["http"]:
		return "web-endpoint"
	case has["ldap"] || has["kerberos"]:
		return "directory-server"
	default:
		return "unclassified"
	}
}

func intList(options map[string]any, key string) []int {
	out := []int{}
	list, ok := options[key].([]any)
	if !ok {
		return out
	}
	for _, v := range list {
		switch n := v.(type) {
		case float64:
			out = append(out, int(n))
		case int:
			out = append(out, n)
		case string:
			if i, err := strconv.Atoi(n); err == nil {
				out = append(out, i)
			}
		}
	}
	return out
}

func intOption(options map[string]any, key string, fallback int) int {
	switch n := options[key].(type) {
	case float64:
		if n > 0 {
			return int(n)
		}
	case int:
		if n > 0 {
			return n
		}
	}
	return fallback
}

func (Collector) Collect(ctx context.Context, target contract.Target, _ *contract.Credential, options map[string]any) (collector.Observation, error) {
	ports := intList(options, optionPorts)
	if len(ports) == 0 {
		ports = DefaultPorts
	}
	connectTimeout := time.Duration(intOption(options, optionConnectMs, defaultConnectMs)) * time.Millisecond
	bannerTimeout := time.Duration(intOption(options, optionBannerMs, defaultBannerMs)) * time.Millisecond
	open := Scan(ctx, target.Value, ports, intOption(options, optionConcurrency, defaultConcurrency), connectTimeout, bannerTimeout)
	if len(open) == 0 {
		return collector.Observation{}, collector.Errorf(contract.ErrUnreachable, true, "%s answered no probe on %d ports", target.Value, len(ports))
	}
	rdns := ""
	if names, err := net.DefaultResolver.LookupAddr(ctx, target.Value); err == nil && len(names) > 0 {
		rdns = strings.TrimSuffix(names[0], ".")
	}
	return Emit(target.Value, rdns, open, time.Now().UTC()), nil
}
