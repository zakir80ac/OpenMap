// REQ-QA-005 REQ-DISC-016 — simulated Linux file servers over SSH for the nas collector in linux mode (the WinRM and
// MOUNT-protocol paths are simulated elsewhere). The servers are the first RHEL and the first Ubuntu "file" host of
// the synthetic estate, each its own SSH daemon with a per-server host key. The daemon answers the collector's
// script with `testparm -s` (the effective smb.conf dump) and `exportfs -v` (the kernel export table, long paths
// wrapped onto a second line exactly as exportfs prints them). The estate records no shares, so the share set is
// defined below and named per server; the expectations use that same set. The collector names shares after its
// target address (it has no way to learn the server's FQDN), so expected names carry the simulator's address.
package naslinux

import (
	"context"
	"fmt"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/sshd"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	// exportfsPathWidth is the column exportfs pads a path to; longer paths wrap onto their own line.
	exportfsPathWidth = 14
	sectionSamba      = "samba"
	sectionNFS        = "nfs"
)

type Vendor struct{}

func (Vendor) ID() string             { return "nas-linux-ssh" }
func (Vendor) Collector() string      { return "nas" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-016"} }

type smbShare struct {
	name, path, comment, validUsers string
	readOnly, available             bool
}

type nfsExport struct {
	path    string
	clients []string // client(options)
}

type fileServer struct {
	ci      *estate.CI
	short   string
	subnet  string
	smb     []smbShare
	exports []nfsExport
	server  *sshd.Server
}

func subnetOf(e *estate.Estate, h *estate.CI) string {
	for _, ip := range e.From(h, "uses_ip") {
		if s := ip.Str("subnet"); s != "" {
			return s
		}
	}
	return "10.0.0.0/8"
}

func newServer(e *estate.Estate, h *estate.CI) *fileServer {
	short := h.Str("hostname")
	if short == "" {
		short = h.Name
	}
	site := strings.ToUpper(h.Str("site"))
	f := &fileServer{ci: h, short: short, subnet: subnetOf(e, h)}
	f.smb = []smbShare{
		{name: "finance", path: "/srv/samba/finance", comment: site + " finance department", validUsers: "@finance", available: true},
		{name: "scans", path: "/srv/samba/scans", comment: site + " scanner drop", validUsers: "@scanners", available: true},
		{name: "archive", path: "/srv/samba/archive", comment: site + " archive (retired)", readOnly: true, available: false},
	}
	rw := "(sync,wdelay,hide,no_subtree_check,sec=sys,rw,secure,root_squash,no_all_squash)"
	ro := "(sync,wdelay,hide,no_subtree_check,sec=sys,ro,secure,root_squash,no_all_squash)"
	f.exports = []nfsExport{
		{path: "/export/home", clients: []string{f.subnet + rw}},
		{path: "/export/backup/" + short, clients: []string{f.subnet + rw, "10.255.0.10" + ro}},
		{path: "/export/iso", clients: []string{"<world>" + ro}},
	}
	return f
}

func (f *fileServer) testparm() string {
	var b strings.Builder
	b.WriteString("# Global parameters\n[global]\n\tlog file = /var/log/samba/log.%m\n\tmax log size = 1000\n\tnetbios name = " + strings.ToUpper(f.short) +
		"\n\tsecurity = USER\n\tserver role = standalone server\n\tworkgroup = BANK\n\tidmap config * : backend = tdb\n\n")
	b.WriteString("[homes]\n\tbrowseable = No\n\tcomment = Home Directories\n\tread only = No\n\tvalid users = %S\n\n")
	b.WriteString("[printers]\n\tbrowseable = No\n\tcomment = All Printers\n\tpath = /var/tmp\n\tprintable = Yes\n\n")
	for _, s := range f.smb {
		fmt.Fprintf(&b, "[%s]\n\tcomment = %s\n\tpath = %s\n", s.name, s.comment, s.path)
		if !s.readOnly {
			b.WriteString("\tread only = No\n")
		}
		if !s.available {
			b.WriteString("\tavailable = No\n")
		}
		if s.validUsers != "" {
			b.WriteString("\tvalid users = " + s.validUsers + "\n")
		}
		b.WriteString("\n")
	}
	return b.String()
}

func (f *fileServer) exportfs() string {
	var b strings.Builder
	for _, x := range f.exports {
		for _, c := range x.clients {
			if len(x.path) > exportfsPathWidth {
				b.WriteString(x.path + "\n\t\t" + c + "\n")
			} else {
				fmt.Fprintf(&b, "%-*s\t%s\n", exportfsPathWidth, x.path, c)
			}
		}
	}
	return b.String()
}

func (f *fileServer) render(script string) string {
	var b strings.Builder
	for _, s := range sshd.Sections(script) {
		switch {
		case s.Key == sectionSamba && strings.Contains(s.Command, "testparm"):
			b.WriteString(sshd.Frame(s.Key, f.testparm()))
		case s.Key == sectionNFS && strings.Contains(s.Command, "exportfs"):
			b.WriteString(sshd.Frame(s.Key, f.exportfs()))
		default:
			b.WriteString(sshd.Frame(s.Key, ""))
		}
	}
	return b.String()
}

func fileServers(e *estate.Estate) []*fileServer {
	var out []*fileServer
	for _, osName := range []string{"Red Hat Enterprise Linux", "Ubuntu"} {
		hosts := e.OfType("host", func(c *estate.CI) bool {
			return c.Str("osName") == osName && strings.Contains(c.Name, "-file-")
		})
		if len(hosts) > 0 {
			out = append(out, newServer(e, hosts[0]))
		}
	}
	return out
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	all := fileServers(e)
	ep := &sim.Endpoint{Host: sim.AdvertiseHost(), State: map[string]any{"servers": all}}
	for _, f := range all {
		srv, err := sshd.Serve(env, sshd.Shell(f.render), sshd.Config{})
		if err != nil {
			_ = ep.Close()
			return nil, err
		}
		f.server = srv
		ep.OnClose(srv.Close)
	}
	return ep, nil
}

func (Vendor) Runs(_ *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	all, _ := ep.State["servers"].([]*fileServer)
	var runs []sim.Run
	for _, f := range all {
		cred := sshd.PasswordCredential(env)
		opts := f.server.Options()
		opts["mode"] = "linux"
		run := sim.Run{Name: f.short, Targets: []sim.Target{f.server.Target(f.short)}, Options: opts, CredentialType: cred.Type, Credential: cred}
		hostRef := strings.ToLower(f.server.Host)
		host := map[string]string{"fqdn": hostRef}
		x := &run.Expect
		for _, s := range f.smb {
			name := `\\` + hostRef + `\` + s.name
			x.CI("nas_share", name)
			x.RelFromRef("contains", "host", host, "nas_share", name)
		}
		for _, n := range f.exports {
			name := hostRef + ":" + n.path
			x.CI("nas_share", name)
			x.RelFromRef("contains", "host", host, "nas_share", name)
		}
		runs = append(runs, run)
	}
	return runs
}
