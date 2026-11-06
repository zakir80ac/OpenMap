// REQ-CMDB-014 (ADR-037) — parts inside a Linux host from read-only sources: CPU sockets from /proc/cpuinfo, block
// devices from lsblk key=value pairs (bytes, model, serial, transport), physical NICs from /sys/class/net (those with a
// backing device), Fibre Channel HBAs from /sys/class/fc_host and memory modules from dmidecode when it is readable
// (it needs root; without it memory modules are simply not reported).
package sshlinux

import (
	"sort"
	"strconv"
	"strings"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

// The part-inventory commands; appended to Commands so one exec round-trip still returns everything.
var componentCommands = []command{
	{"lsblk_pairs", "lsblk -dbn -P -o NAME,SIZE,TYPE,MODEL,SERIAL,VENDOR,ROTA,TRAN,REV 2>/dev/null || true"},
	{"nics", "for d in /sys/class/net/*; do [ -e \"$d/device\" ] || continue; printf '%s\\t%s\\t%s\\t%s\\n' \"${d##*/}\" \"$(cat \"$d/address\" 2>/dev/null)\" \"$(cat \"$d/speed\" 2>/dev/null)\" \"$(basename \"$(readlink \"$d/device/driver\" 2>/dev/null)\" 2>/dev/null)\"; done 2>/dev/null || true"},
	{"fc_hosts", "for h in /sys/class/fc_host/*; do [ -e \"$h/port_name\" ] || continue; printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \"${h##*/}\" \"$(cat \"$h/port_name\")\" \"$(cat \"$h/node_name\" 2>/dev/null)\" \"$(cat \"$h/speed\" 2>/dev/null)\" \"$(cat \"$h/port_state\" 2>/dev/null)\"; done 2>/dev/null || true"},
	{"dmi_memory", "dmidecode -t 17 2>/dev/null || true"},
}

func init() {
	Commands = append(Commands, componentCommands...)
}

// Block device types that are physical media; partitions, loop, rom and device-mapper volumes are not parts.
var diskTypes = map[string]bool{"disk": true}

// ParseCPUSockets groups /proc/cpuinfo processors by physical id: one part per socket with its model, cores and threads.
func ParseCPUSockets(text string) []contract.Component {
	type socket struct {
		model   string
		vendor  string
		cores   int
		threads int
	}
	sockets := map[string]*socket{}
	order := []string{}
	cur := map[string]string{}
	flush := func() {
		if len(cur) == 0 {
			return
		}
		id := cur["physical id"]
		if id == "" {
			id = "0"
		}
		s, ok := sockets[id]
		if !ok {
			s = &socket{}
			sockets[id] = s
			order = append(order, id)
		}
		s.threads++
		if s.model == "" {
			s.model = cur["model name"]
		}
		if s.vendor == "" {
			s.vendor = cur["vendor_id"]
		}
		if c, err := strconv.Atoi(cur["cpu cores"]); err == nil && c > s.cores {
			s.cores = c
		}
		cur = map[string]string{}
	}
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if ok {
			cur[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	flush()
	out := make([]contract.Component, 0, len(order))
	for _, id := range order {
		s := sockets[id]
		details := map[string]any{"threads": s.threads}
		if s.cores > 0 {
			details["cores"] = s.cores
		}
		out = append(out, contract.Component{Kind: contract.ComponentCPU, Slot: id, Model: s.model, Manufacturer: s.vendor, Details: details})
	}
	return out
}

// parsePairs reads one lsblk -P line: KEY="value" KEY2="value two".
func parsePairs(line string) map[string]string {
	out := map[string]string{}
	for line = strings.TrimSpace(line); line != ""; line = strings.TrimSpace(line) {
		eq := strings.Index(line, "=\"")
		if eq < 0 {
			break
		}
		key := line[:eq]
		rest := line[eq+2:]
		end := strings.Index(rest, "\"")
		if end < 0 {
			break
		}
		out[key] = strings.TrimSpace(rest[:end])
		line = rest[end+1:]
	}
	return out
}

// ParseBlockDevices reads `lsblk -dbn -P` output into disk parts (whole disks only).
func ParseBlockDevices(text string) []contract.Component {
	out := []contract.Component{}
	for _, line := range strings.Split(text, "\n") {
		p := parsePairs(line)
		if p["NAME"] == "" || !diskTypes[p["TYPE"]] {
			continue
		}
		c := contract.Component{Kind: contract.ComponentDisk, Slot: p["NAME"], Model: p["MODEL"], Manufacturer: p["VENDOR"], SerialNumber: p["SERIAL"], Firmware: p["REV"]}
		if size, err := strconv.ParseFloat(p["SIZE"], 64); err == nil {
			c.CapacityBytes = size
		}
		details := map[string]any{}
		if p["TRAN"] != "" {
			details["transport"] = p["TRAN"]
		}
		switch p["ROTA"] {
		case "1":
			details["media"] = "hdd"
		case "0":
			details["media"] = "ssd"
		}
		if len(details) > 0 {
			c.Details = details
		}
		out = append(out, c)
	}
	return out
}

// ParseNICs reads the nics command: name, MAC, speed in Mb/s (-1 or empty when down) and driver, tab-separated.
func ParseNICs(text string) []contract.Component {
	out := []contract.Component{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Split(strings.TrimRight(line, "\r"), "\t")
		if len(f) < 2 || f[0] == "" {
			continue
		}
		details := map[string]any{}
		if f[1] != "" {
			details["mac"] = f[1]
		}
		if len(f) > 2 {
			if speed, err := strconv.Atoi(f[2]); err == nil && speed > 0 {
				details["speedMbps"] = speed
			}
		}
		c := contract.Component{Kind: contract.ComponentNIC, Slot: f[0], Details: details}
		if len(f) > 3 {
			c.Model = f[3]
		}
		out = append(out, c)
	}
	return out
}

// ParseFCHosts reads the fc_hosts command: host, WWPN, WWNN, speed and port state, tab-separated.
func ParseFCHosts(text string) []contract.Component {
	out := []contract.Component{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Split(strings.TrimRight(line, "\r"), "\t")
		if len(f) < 2 || f[0] == "" || f[1] == "" {
			continue
		}
		details := map[string]any{"wwpn": f[1]}
		if len(f) > 2 && f[2] != "" {
			details["wwnn"] = f[2]
		}
		if len(f) > 3 && f[3] != "" {
			details["speed"] = f[3]
		}
		if len(f) > 4 && f[4] != "" {
			details["portState"] = f[4]
		}
		out = append(out, contract.Component{Kind: contract.ComponentHBA, Slot: f[0], Details: details})
	}
	return out
}

var memoryUnits = map[string]float64{"KB": 1 << 10, "MB": 1 << 20, "GB": 1 << 30, "TB": 1 << 40}

func memorySize(v string) (float64, bool) {
	f := strings.Fields(v)
	if len(f) != 2 {
		return 0, false
	}
	n, err := strconv.ParseFloat(f[0], 64)
	unit, ok := memoryUnits[strings.ToUpper(f[1])]
	if err != nil || !ok {
		return 0, false
	}
	return n * unit, true
}

func dmiValue(v string) string {
	v = strings.TrimSpace(v)
	switch strings.ToLower(v) {
	case "", "not specified", "unknown", "no dimm", "not provided", "to be filled by o.e.m.":
		return ""
	}
	return v
}

// ParseDMIMemory reads `dmidecode -t 17`: one part per populated Memory Device, slot from its locator.
func ParseDMIMemory(text string) []contract.Component {
	out := []contract.Component{}
	var cur map[string]string
	flush := func() {
		if cur == nil {
			return
		}
		size, ok := memorySize(cur["Size"])
		slot := dmiValue(cur["Locator"])
		if ok && slot != "" {
			if bank := dmiValue(cur["Bank Locator"]); bank != "" {
				slot = bank + " " + slot
			}
			c := contract.Component{Kind: contract.ComponentMemory, Slot: slot, Manufacturer: dmiValue(cur["Manufacturer"]), SerialNumber: dmiValue(cur["Serial Number"]), PartNumber: dmiValue(cur["Part Number"]), CapacityBytes: size}
			details := map[string]any{}
			if t := dmiValue(cur["Type"]); t != "" {
				details["type"] = t
			}
			if s := dmiValue(cur["Speed"]); s != "" {
				details["speed"] = s
			}
			if len(details) > 0 {
				c.Details = details
			}
			out = append(out, c)
		}
		cur = nil
	}
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "Memory Device" {
			flush()
			cur = map[string]string{}
			continue
		}
		if cur == nil {
			continue
		}
		if trimmed == "" {
			flush()
			continue
		}
		if k, v, ok := strings.Cut(trimmed, ":"); ok {
			cur[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	flush()
	return out
}

// Components assembles every part the outputs show, in a stable order (kind, then slot).
func Components(parts map[string]string) []contract.Component {
	out := []contract.Component{}
	out = append(out, ParseCPUSockets(parts["cpuinfo"])...)
	out = append(out, ParseDMIMemory(parts["dmi_memory"])...)
	out = append(out, ParseBlockDevices(parts["lsblk_pairs"])...)
	out = append(out, ParseNICs(parts["nics"])...)
	out = append(out, ParseFCHosts(parts["fc_hosts"])...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].Slot < out[j].Slot
	})
	return out
}
