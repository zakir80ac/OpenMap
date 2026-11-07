// REQ-QA-005 REQ-DISC-020 — simulated scan targets for the real port_scan collector. Every unclassified device in
// the estate (cameras, phones, printers, signage, UPS cards, access controllers, access points) and one host per
// distinct listening-service profile in the estate (nginx, IIS, Java, .NET and Node on 443/8443, PostgreSQL,
// Oracle, SQL Server, BIND, Zabbix, Veeam) gets one run: each of its open TCP ports is a banners personality
// (SSH greeting, HTTP / HTTPS with the estate's web-server banner, RTSP, SIP, or a silent service) behind a
// self-signed device certificate where the service speaks TLS. The simulator cannot bind well-known port
// numbers (privileged on Linux, taken by the OS on Windows), so every service listens on an ephemeral port;
// services a scanner can only name by their port number (database listeners, DNS, SIP on 5060) are therefore
// expected as "unknown", and identification by port is left to the recorded fixtures (T-308, T-321). UDP ports
// in the estate (SNMP 161) are outside a TCP connect scan and are not served.
package portscan

import (
	"context"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/banners"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	typeHost     = "host"
	typeUnknown  = "unknown"
	typeIP       = "ip_address"
	typeListener = "listening_service"
	// Probe timeouts: loopback answers in microseconds; silent services cost three banner timeouts each.
	connectTimeoutMs = 1000
	bannerTimeoutMs  = 300
	rdnsTimeout      = 5 * time.Second
	snmpPort         = 161
)

type Vendor struct{}

func (Vendor) ID() string             { return "service-fingerprint" }
func (Vendor) Collector() string      { return "port_scan" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-020"} }

// service is one open port: its estate port number, personality and the service name a scanner can give it.
type service struct {
	estatePort int
	p          banners.Personality
	expect     string
}

type target struct {
	name     string // run name: the device sysName or "<host> <process>/<port>"
	certName string
	services []service
}

func webBanner(c *estate.CI) string { return c.Str("httpBanner") }

func sshBanner(c *estate.CI) string {
	if strings.EqualFold(c.Str("osGuess"), "linux") {
		return "SSH-2.0-OpenSSH_9.2p1 Raspbian-2+deb12u3"
	}
	return "SSH-2.0-dropbear_2022.83"
}

// devicePort maps a device's estate port to the personality real devices of that class present on it.
func devicePort(c *estate.CI, port int) (service, bool) {
	https := banners.Personality{Kind: banners.HTTP, Banner: webBanner(c), TLS: true}
	switch port {
	case snmpPort:
		return service{}, false
	case 22:
		return service{port, banners.Personality{Kind: banners.Greeting, Banner: sshBanner(c)}, "ssh"}, true
	case 80, 631: // web UI, IPP
		return service{port, banners.Personality{Kind: banners.HTTP, Banner: webBanner(c)}, "http"}, true
	case 443, 4343: // web UI, ArubaOS HTTPS management
		return service{port, https, "https"}, true
	case 554:
		return service{port, banners.Personality{Kind: banners.RTSP, Banner: webBanner(c)}, "unknown"}, true
	case 5060:
		return service{port, banners.Personality{Kind: banners.SIP, Banner: c.Str("sysDescr")}, "unknown"}, true
	case 5061:
		return service{port, banners.Personality{Kind: banners.SIP, Banner: c.Str("sysDescr"), TLS: true}, "unknown"}, true
	default: // MQTT 1883, LPD 515, JetDirect 9100, vendor SDK and agent ports: silent to strangers
		return service{port, banners.Personality{Kind: banners.Silent}, "unknown"}, true
	}
}

// hostServer maps a listening service's process to the web server product it announces.
var hostServer = map[string]string{"nginx": "nginx/1.26.2", "w3wp": "Microsoft-IIS/10.0", "dotnet": "Kestrel", "java": "", "node": ""}

func hostPort(l *estate.CI) service {
	port := int(l.Num("port", 0))
	if product, web := hostServer[l.Str("process")]; web {
		return service{port, banners.Personality{Kind: banners.HTTP, Banner: product, TLS: true}, "https"}
	}
	return service{port, banners.Personality{Kind: banners.Silent}, "unknown"}
}

func targets(e *estate.Estate) []target {
	var out []target
	for _, d := range e.OfType(typeUnknown, nil) {
		open, _ := d.Attributes["openPorts"].([]any)
		if len(open) == 0 {
			continue
		}
		t := target{name: d.Name, certName: d.Str("sysName")}
		var ports []int
		for _, v := range open {
			if f, ok := v.(float64); ok {
				ports = append(ports, int(f))
			}
		}
		sort.Ints(ports)
		for _, p := range ports {
			if s, ok := devicePort(d, p); ok {
				t.services = append(t.services, s)
			}
		}
		out = append(out, t)
	}
	fqdns := map[string]string{}
	for _, c := range e.CIs {
		if c.Type == "vm" || c.Type == typeHost {
			for _, k := range []string{"instanceUuid", "serialNumber", "systemUuid"} {
				if v := c.ID(k); v != "" {
					fqdns[v] = strings.ToLower(c.ID("fqdn"))
				}
			}
		}
	}
	seen := map[string]bool{}
	listeners := e.OfType(typeListener, nil)
	sort.SliceStable(listeners, func(i, j int) bool { return listeners[i].Name < listeners[j].Name })
	for _, l := range listeners {
		key := l.Str("process") + "/" + l.Str("port")
		if seen[key] || l.Str("protocol") != "tcp" {
			continue
		}
		seen[key] = true
		cn := fqdns[l.ID("hostRef")]
		if cn == "" {
			cn = l.Str("host")
		}
		out = append(out, target{name: l.Str("host") + " " + key, certName: cn, services: []service{hostPort(l)}})
	}
	return out
}

type served struct {
	port int
	svc  service
}

func (Vendor) Start(_ context.Context, e *estate.Estate, _ *sim.Env) (*sim.Endpoint, error) {
	ep := &sim.Endpoint{Host: sim.AdvertiseHost(), State: map[string]any{}}
	for _, t := range targets(e) {
		cert, err := banners.SelfSigned(t.certName)
		if err != nil {
			_ = ep.Close()
			return nil, err
		}
		var list []served
		for _, s := range t.services {
			ln, port, err := sim.Listen()
			if err != nil {
				_ = ep.Close()
				return nil, err
			}
			p := s.p
			p.Cert = cert
			srv := banners.Serve(ln, p)
			ep.OnClose(srv.Close)
			list = append(list, served{port: port, svc: s})
		}
		ep.State["target:"+t.name] = list
	}
	return ep, nil
}

// reverseName is the PTR name the collector will find for the scanned address ("" when none): the simulator
// cannot serve PTR records for the host it runs on, so the expectation follows the environment's resolver.
func reverseName(host string) string {
	ctx, cancel := context.WithTimeout(context.Background(), rdnsTimeout)
	defer cancel()
	names, err := net.DefaultResolver.LookupAddr(ctx, host)
	if err != nil || len(names) == 0 {
		return ""
	}
	return strings.ToLower(strings.TrimSuffix(names[0], "."))
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, _ *sim.Env) []sim.Run {
	rdns := reverseName(ep.Host)
	var runs []sim.Run
	for _, t := range targets(e) {
		list, _ := ep.State["target:"+t.name].([]served)
		if len(list) == 0 {
			continue
		}
		ports := []any{}
		for _, s := range list {
			ports = append(ports, s.port)
		}
		run := sim.Run{
			Name:           t.name,
			Targets:        []sim.Target{{Kind: "host", Value: ep.Host, Label: t.name}},
			Options:        map[string]any{"ports": ports, "connectTimeoutMs": connectTimeoutMs, "bannerTimeoutMs": bannerTimeoutMs},
			CredentialType: "none",
		}
		hostType, hostName := typeUnknown, ep.Host
		tls := false
		for _, s := range list {
			tls = tls || s.svc.p.TLS
		}
		switch {
		case rdns != "":
			hostType, hostName = typeHost, rdns
		case tls && strings.Contains(t.certName, ".") && net.ParseIP(t.certName) == nil:
			hostName = ep.Host + " (" + t.certName + ")"
		}
		run.Expect.CI(hostType, hostName)
		run.Expect.CI(typeIP, ep.Host)
		run.Expect.Rel("uses_ip", hostType, hostName, typeIP, ep.Host)
		for _, s := range list {
			name := "tcp/" + strconv.Itoa(s.port) + " " + s.svc.expect
			run.Expect.CI(typeListener, name)
			run.Expect.Rel("runs_on", typeListener, name, hostType, hostName)
		}
		runs = append(runs, run)
	}
	return runs
}
