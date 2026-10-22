// T-074 REQ-DISC-004 — the agent's parsers against recorded-shape inputs: os-release, meminfo, /proc/net/tcp and
// tcp6 (hex little-endian addresses, LISTEN filter), dpkg and rpm query lines, lsof listeners, pkgutil plist, and the
// Windows PowerShell JSON; then the emitted host, OS, addresses, listeners and software pairs.
package agent

import (
	"testing"
	"time"
)

func TestLinuxParsers(t *testing.T) {
	name, version, id := ParseOSRelease("NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nID=ubuntu\nPRETTY_NAME=\"Ubuntu 24.04.2 LTS\"\n")
	if name != "Ubuntu" || version != "24.04" || id != "ubuntu" {
		t.Fatalf("os-release wrong: %q %q %q", name, version, id)
	}
	if mib := ParseMeminfo("MemTotal:       16318464 kB\nMemFree:         1234 kB\n"); mib != 15936 {
		t.Fatalf("meminfo wrong: %d", mib)
	}
	tcp := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
		"   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 31337 1 0000000000000000 100 0 0 10 0\n" +
		"   1: 0B00007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 31338 1 0000000000000000 100 0 0 10 0\n" +
		"   2: 0B00007F:0CEA 0C00007F:9C40 01 00000000:00000000 00:00000000 00000000     0        0 31339 1 0000000000000000 100 0 0 10 0\n"
	rows, err := ParseProcNetTCP(tcp, false)
	if err != nil || len(rows) != 2 {
		t.Fatalf("tcp rows wrong: %v %d", err, len(rows))
	}
	if rows[31337].Port != 8080 || rows[31337].Address != "0.0.0.0" || rows[31338].Address != "127.0.0.11" || rows[31338].Port != 3306 {
		t.Fatalf("tcp decode wrong: %+v", rows)
	}
	tcp6 := "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
		"   0: 00000000000000000000000000000000:01BB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4242 1 0000000000000000 100 0 0 10 0\n" +
		"   1: 0000000000000000FFFF00000B00007F:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4243 1 0000000000000000 100 0 0 10 0\n"
	rows6, err := ParseProcNetTCP(tcp6, true)
	if err != nil || len(rows6) != 2 || rows6[4242].Port != 443 || rows6[4242].Address != "::" || rows6[4243].Address != "127.0.0.11" {
		t.Fatalf("tcp6 decode wrong: %v %+v", err, rows6)
	}
	pkgs := ParseDpkg("openssh-server\t1:9.6p1-3ubuntu13\tUbuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>\nnginx\t1.24.0-2ubuntu7\tUbuntu Developers\n\n")
	if len(pkgs) != 2 || pkgs[1].Name != "nginx" || pkgs[1].Version != "1.24.0-2ubuntu7" || pkgs[0].Vendor == "" {
		t.Fatalf("dpkg wrong: %+v", pkgs)
	}
	lsof := "COMMAND   PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n" +
		"sshd      612   root    3u  IPv4 0x1234      0t0  TCP *:22 (LISTEN)\n" +
		"sshd      612   root    4u  IPv6 0x1235      0t0  TCP [::]:22 (LISTEN)\n" +
		"postgres 9001 pgsql    7u  IPv4 0x1236      0t0  TCP 127.0.0.1:5432 (LISTEN)\n"
	ls := ParseLsof(lsof)
	if len(ls) != 3 || ls[0].Port != 22 || ls[0].Process != "sshd" || ls[2].Address != "127.0.0.1" || ls[2].PID != 9001 {
		t.Fatalf("lsof wrong: %+v", ls)
	}
	pk := ParsePkgutil("<array>\n  <string>com.apple.pkg.CLTools_Executables</string>\n  <string>com.microsoft.package.Microsoft_Excel.app</string>\n</array>")
	if len(pk) != 2 || pk[1].Vendor != "microsoft" {
		t.Fatalf("pkgutil wrong: %+v", pk)
	}
}

func TestWindowsAndEmit(t *testing.T) {
	report := `{"ComputerName":"FS-RYD-01","Domain":"bank.local","Manufacturer":"Dell Inc.","Model":"PowerEdge R760","SerialNumber":"7XK2M94","UUID":"4C4C4544-0058-4B10-8032-B4C04F4D3934","Caption":"Microsoft Windows Server 2022 Datacenter","Version":"10.0.20348","BuildNumber":"20348","TotalPhysicalMemory":68719476736,"NumberOfLogicalProcessors":32,"LastBootUpTime":"2026-10-01T06:00:00.0000000+03:00","Listeners":[{"LocalAddress":"0.0.0.0","LocalPort":445,"OwningProcess":4,"ProcessName":"System"},{"LocalAddress":"::","LocalPort":445,"OwningProcess":4,"ProcessName":"System"},{"LocalAddress":"0.0.0.0","LocalPort":3389,"OwningProcess":1180,"ProcessName":"svchost"}],"Software":[{"DisplayName":"Microsoft SQL Server 2022 (64-bit)","DisplayVersion":"16.0.4105.2","Publisher":"Microsoft Corporation","InstallLocation":"C:\\Program Files\\Microsoft SQL Server\\"}]}`
	inv, err := ParseWindows(report)
	if err != nil {
		t.Fatal(err)
	}
	if inv.FQDN != "fs-ryd-01.bank.local" || inv.Serial != "7XK2M94" || inv.MemoryMiB != 65536 || inv.CPUs != 32 || len(inv.Listeners) != 3 || len(inv.Packages) != 1 || inv.UptimeSec <= 0 {
		t.Fatalf("windows inventory wrong: %+v", inv)
	}
	inv.Addresses = []Address{{Interface: "Ethernet0", MAC: "00:50:56:aa:bb:cc", Address: "10.191.4.21", Prefix: 24}}
	inv.PrimaryMAC = "00:50:56:aa:bb:cc"
	inv.CollectedAt = time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC)
	obs := Emit(inv)
	types := map[string]int{}
	for _, ci := range obs.Cis {
		types[ci.Type]++
	}
	// host, os, 1 ip, 2 distinct listener ports (445 once), software + software_instance
	if types[typeHost] != 1 || types[typeOS] != 1 || types[typeIP] != 1 || types[typeListener] != 2 || types[typeSoftware] != 1 || types[typeInstance] != 1 {
		t.Fatalf("unexpected CI mix: %+v", types)
	}
	host := obs.Cis[0]
	if host.Identity["fqdn"] != "fs-ryd-01.bank.local" || host.Identity["serialNumber"] != "7XK2M94" || host.Identity["systemUuid"] != "4c4c4544-0058-4b10-8032-b4c04f4d3934" || host.Identity["primaryMac"] != "00:50:56:aa:bb:cc" {
		t.Fatalf("host identity wrong: %+v", host.Identity)
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relInstalled] != 2 || rels[relUsesIP] != 1 || rels[relRunsOn] != 2 || len(obs.Evidence) != 1 || obs.Evidence[0].Kind != evidenceKind {
		t.Fatalf("relationships or evidence wrong: %+v %d", rels, len(obs.Evidence))
	}
}
