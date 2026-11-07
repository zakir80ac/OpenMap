// REQ-QA-005 REQ-DISC-019 — simulated flow exporters: the estate's communicates_with conversations (a host
// or VM talking to a listening service or a Kubernetes ClusterIP service) are exported to the real netflow
// collector as NetFlow v5, NetFlow v9 (softflowd template layout), IPFIX and sFlow v5 datagrams, one run per
// protocol. The collector listens; the simulator is the exporter (sim.Concurrent) and re-exports every
// conversation each active-timeout interval, as a router does for long-lived flows, until the capture ends.
package netflow

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/flowexport"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	relCommunicates = "communicates_with"
	typeIP          = "ip_address"
	optionListen    = "listenAddress"
	optionPort      = "listenPort"
	optionSeconds   = "captureSeconds"
	// captureSeconds covers several export intervals after the collector binds its socket.
	captureSeconds = 3
	// exportInterval is the simulated active timeout: every conversation is reported again each interval.
	exportInterval = 400 * time.Millisecond
	// pacingBurst datagrams go out back to back before a pause, so a loopback receive buffer never overflows.
	pacingBurst = 8
	pacingPause = time.Millisecond
	// ephemeralFloor is the start of the IANA dynamic port range clients draw source ports from.
	ephemeralFloor = 49152
	portSpan       = 65535 - ephemeralFloor
	sflowRate      = 1000
	protoTCP       = 6
	protoUDP       = 17
	tcpFlagsACKPSH = 0x18
	tcpFlagsSYNACK = 0x1b
	// collectorHost is where verify mode runs the collector (same host as the simulator); serve mode plans
	// replace the listenAddress option with the Discovery Node's address.
	collectorHost = "127.0.0.1"
	bootOffset    = 72 * time.Hour
)

var protocols = []string{"netflow-v5", "netflow-v9", "ipfix", "sflow-v5"}

type Vendor struct{}

func (Vendor) ID() string             { return "flow-exporter" }
func (Vendor) Collector() string      { return "netflow" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-019"} }

// conversation is one estate communicates_with edge resolved to addresses.
type conversation struct {
	rec flowexport.Record
	key string
}

type index struct {
	byUUID   map[string]*estate.CI
	bySerial map[string]*estate.CI
	byFQDN   map[string]*estate.CI
}

func newIndex(e *estate.Estate) *index {
	ix := &index{byUUID: map[string]*estate.CI{}, bySerial: map[string]*estate.CI{}, byFQDN: map[string]*estate.CI{}}
	for _, c := range e.CIs {
		switch c.Type {
		case "vm":
			ix.byUUID[c.ID("instanceUuid")] = c
			ix.byFQDN[strings.ToLower(c.ID("fqdn"))] = c
		case "host":
			ix.bySerial[c.ID("serialNumber")] = c
			ix.byUUID[c.ID("systemUuid")] = c
			ix.byFQDN[strings.ToLower(c.ID("fqdn"))] = c
		}
	}
	return ix
}

func addressOf(c *estate.CI) string {
	switch c.Type {
	case "vm":
		return c.Str("ipAddress")
	case "host":
		return c.Str("primaryIp")
	case "listening_service":
		return c.Str("bindAddress")
	case "k8s_service":
		return c.Str("clusterIp")
	}
	return ""
}

func (ix *index) resolve(e *estate.Estate, ref estate.Ref) string {
	if c := e.Resolve(ref); c != nil {
		if a := addressOf(c); a != "" {
			return a
		}
	}
	id := ref.Identity
	switch ref.Type {
	case "vm", "host":
		for _, c := range []*estate.CI{ix.byUUID[id["instanceUuid"]], ix.byUUID[id["systemUuid"]], ix.bySerial[id["serialNumber"]], ix.byFQDN[strings.ToLower(id["fqdn"])]} {
			if c != nil {
				return addressOf(c)
			}
		}
	case "listening_service":
		for _, c := range []*estate.CI{ix.byUUID[id["hostRef"]], ix.bySerial[id["hostRef"]]} {
			if c != nil {
				return addressOf(c)
			}
		}
	}
	return ""
}

func hash32(s string) uint32 {
	sum := sha256.Sum256([]byte(s))
	return binary.BigEndian.Uint32(sum[:4])
}

func num(attrs map[string]any, key string) uint64 {
	if v, ok := attrs[key].(float64); ok && v > 0 {
		return uint64(v)
	}
	return 0
}

// conversations renders the estate's flow edges. Edges whose source has no address in the estate
// (Kubernetes workloads: pod addresses are not modelled) cannot be exported and are counted as skipped.
func conversations(e *estate.Estate) (out []conversation, skipped int) {
	ix := newIndex(e)
	seen := map[string]bool{}
	for _, r := range e.Rels {
		if r.Type != relCommunicates {
			continue
		}
		src := net.ParseIP(ix.resolve(e, r.From))
		dst := net.ParseIP(ix.resolve(e, r.To))
		dstPort := int(num(r.Attributes, "dstPort"))
		if src == nil || dst == nil || dstPort <= 0 || dstPort >= ephemeralFloor {
			skipped++
			continue
		}
		proto := uint8(protoTCP)
		flags := uint8(tcpFlagsSYNACK)
		if p, _ := r.Attributes["protocol"].(string); strings.EqualFold(p, "udp") {
			proto, flags = protoUDP, 0
		}
		key := src.String() + ">" + dst.String() + ":" + strconv.Itoa(dstPort) + "/" + strconv.Itoa(int(proto))
		if seen[key] {
			continue
		}
		seen[key] = true
		// One record per conversation and interval: the estate's per-flow average volume.
		flows := max(num(r.Attributes, "flows"), 1)
		bytes := max(num(r.Attributes, "bytes")/flows, 1)
		packets := max(num(r.Attributes, "packets")/flows, 1)
		if flags != 0 && packets > 1 {
			flags = tcpFlagsACKPSH | tcpFlagsSYNACK
		}
		srcPort := uint16(ephemeralFloor + int(hash32(key))%portSpan)
		out = append(out, conversation{key: key, rec: flowexport.Record{Src: src, Dst: dst, SrcPort: srcPort, DstPort: uint16(dstPort), Protocol: proto, Bytes: bytes, Packets: packets, TCPFlags: flags}})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].key < out[j].key })
	return out, skipped
}

// freeUDPPort asks the OS for a UDP port and releases it for the collector to bind.
func freeUDPPort() (int, error) {
	pc, port, err := sim.ListenUDP()
	if err != nil {
		return 0, err
	}
	defer pc.Close()
	return port, nil
}

func (Vendor) Start(_ context.Context, e *estate.Estate, _ *sim.Env) (*sim.Endpoint, error) {
	convs, skipped := conversations(e)
	ep := &sim.Endpoint{Host: sim.AdvertiseHost(), State: map[string]any{"conversations": convs, "skipped": skipped}}
	for _, p := range protocols {
		port, err := freeUDPPort()
		if err != nil {
			return nil, err
		}
		ep.State["port:"+p] = port
	}
	return ep, nil
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, _ *sim.Env) []sim.Run {
	convs, _ := ep.State["conversations"].([]conversation)
	if len(convs) == 0 {
		return nil
	}
	ips := map[string]*estate.CI{}
	for _, c := range e.OfType(typeIP, nil) {
		ips[c.Name] = c
	}
	var runs []sim.Run
	for _, p := range protocols {
		run := sim.Run{
			Name:           p,
			Targets:        []sim.Target{{Kind: "flow_source", Value: sim.AdvertiseHost(), Label: "simulated " + p + " exporter"}},
			Options:        map[string]any{optionListen: collectorHost, optionPort: ep.State["port:"+p], optionSeconds: captureSeconds},
			CredentialType: "none",
		}
		seenIP := map[string]bool{}
		expectIP := func(addr string) {
			if seenIP[addr] {
				return
			}
			seenIP[addr] = true
			if c := ips[addr]; c != nil {
				run.Expect.EstateCI(c)
			} else {
				run.Expect.CI(typeIP, addr)
			}
		}
		for _, c := range convs {
			if p == "netflow-v5" && c.rec.Src.To4() == nil {
				continue // v5 carries IPv4 only
			}
			expectIP(c.rec.Src.String())
			expectIP(c.rec.Dst.String())
			run.Expect.Rel(relCommunicates, typeIP, c.rec.Src.String(), typeIP, c.rec.Dst.String())
		}
		runs = append(runs, run)
	}
	return runs
}

// Drive exports the conversations to the collector's listen port every interval until the run ends.
func (Vendor) Drive(ctx context.Context, _ *estate.Estate, ep *sim.Endpoint, run sim.Run, _ *sim.Env) error {
	convs, _ := ep.State["conversations"].([]conversation)
	port, _ := ep.State["port:"+run.Name].(int)
	records := make([]flowexport.Record, 0, len(convs))
	for _, c := range convs {
		records = append(records, c.rec)
	}
	host, _ := run.Options[optionListen].(string)
	to, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return err
	}
	pc, _, err := sim.ListenUDP()
	if err != nil {
		return err
	}
	defer pc.Close()
	agent := pc.LocalAddr().(*net.UDPAddr).IP
	if agent.IsUnspecified() {
		agent = to.IP
	}
	x := &flowexport.Exporter{Boot: time.Now().Add(-bootOffset), SourceID: hash32(run.Name), Agent: agent, SamplingRate: sflowRate}
	tick := time.NewTicker(exportInterval)
	defer tick.Stop()
	for {
		now := time.Now()
		var datagrams [][]byte
		switch run.Name {
		case "netflow-v5":
			datagrams = x.V5(records, now)
		case "netflow-v9":
			datagrams = x.V9(records, now)
		case "ipfix":
			datagrams = x.IPFIX(records, now)
		case "sflow-v5":
			datagrams = x.SFlow(records, now)
		default:
			return fmt.Errorf("unknown flow protocol %q", run.Name)
		}
		for i, d := range datagrams {
			if ctx.Err() != nil {
				return nil
			}
			// Datagrams sent before the collector binds are lost, exactly as with a real exporter.
			_, _ = pc.WriteTo(d, to)
			if (i+1)%pacingBurst == 0 {
				time.Sleep(pacingPause)
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
		}
	}
}
