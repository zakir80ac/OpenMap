// REQ-DISC-003 — the fixed, read-only command set run over SSH. Every command tolerates absence
// (|| true) so one missing tool never fails the whole host; parsers treat empty output as "unknown".
package sshlinux

type command struct {
	Key  string
	Line string
}

// Commands are POSIX shell fragments; sudo is used only for dmidecode-equivalents via sysfs which
// does not need it, so the collector never requires root.
var Commands = []command{
	{"hostname", "hostname 2>/dev/null || cat /etc/hostname"},
	{"fqdn", "hostname -f 2>/dev/null || hostname"},
	{"machine_id", "cat /etc/machine-id 2>/dev/null || true"},
	{"os_release", "cat /etc/os-release 2>/dev/null || true"},
	{"kernel", "uname -r"},
	{"arch", "uname -m"},
	{"uptime", "cat /proc/uptime"},
	{"cpuinfo", "cat /proc/cpuinfo"},
	{"meminfo", "grep MemTotal /proc/meminfo"},
	{"dmi", "for k in product_serial product_uuid sys_vendor product_name bios_version; do printf '%s=%s\\n' \"$k\" \"$(cat /sys/class/dmi/id/$k 2>/dev/null)\"; done; printf 'virt=%s\\n' \"$(systemd-detect-virt 2>/dev/null || echo unknown)\""},
	{"ip_addr", "ip addr 2>/dev/null || ifconfig -a 2>/dev/null || true"},
	{"ss", "ss -Hltunp 2>/dev/null || ss -ltunp 2>/dev/null || netstat -ltunp 2>/dev/null || true"},
	{"packages", "if command -v dpkg-query >/dev/null 2>&1; then dpkg-query -W -f='${Package}\\t${Version}\\t${Architecture}\\n'; elif command -v rpm >/dev/null 2>&1; then rpm -qa --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\t%{ARCH}\\n'; elif command -v apk >/dev/null 2>&1; then apk info -v | sed 's/-\\([0-9]\\)/\\t\\1/'; fi 2>/dev/null || true"},
	{"lsblk", "lsblk -dn -o NAME,SIZE,TYPE,MODEL 2>/dev/null || true"},
	{"df", "df -kP -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -kP"},
	// REQ-IPAM-005 (ADR-064): the host firewall as nftables JSON (iptables-nft rules included). Listing the rule set
	// needs CAP_NET_ADMIN, so sudo is tried non-interactively (a sudoers entry for exactly this command) and the
	// collector carries on without it; empty output means the rule set was not readable, not that it is empty.
	{"nft", "sudo -n nft -j list ruleset 2>/dev/null || nft -j list ruleset 2>/dev/null || true"},
}

// Script joins the commands into one shell session with delimiters so a single exec round-trip
// returns everything. The delimiter carries the key so outputs can be split deterministically.
func Script() string {
	s := "set +e; export LC_ALL=C;\n"
	for _, c := range Commands {
		s += "printf '\\n@@OPENMAP:" + c.Key + "@@\\n'; " + c.Line + ";\n"
	}
	return s
}

// Split turns the combined output back into per-command text.
func Split(output string) map[string]string {
	out := map[string]string{}
	const marker = "@@OPENMAP:"
	parts := splitKeep(output, marker)
	for _, p := range parts {
		end := indexOf(p, "@@\n")
		if end < 0 {
			continue
		}
		key := p[:end]
		out[key] = trimRight(p[end+3:])
	}
	return out
}

func splitKeep(s, sep string) []string {
	var out []string
	for {
		i := indexOf(s, sep)
		if i < 0 {
			return out
		}
		s = s[i+len(sep):]
		j := indexOf(s, sep)
		if j < 0 {
			out = append(out, s)
			return out
		}
		out = append(out, s[:j])
	}
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func trimRight(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r' || s[len(s)-1] == ' ') {
		s = s[:len(s)-1]
	}
	return s
}
