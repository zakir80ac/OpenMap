// T-307 REQ-DISC-019 — recorded vendor fixtures: export datagrams captured with tcpdump from real
// exporters in the container lab (softflowd 1.1.0 NetFlow v5 / v9 / IPFIX, pmacct 1.7.8 pmacctd
// sfprobe sFlow v5) are fed byte-for-byte to the collector's Decoder, then Aggregate and Emit. The
// traffic the exporters saw was recorded alongside (traffic.pcap) and is the ground truth the
// decoded flows must match. Fixtures live in packages/testing/fixtures/vendor/netflow.
package netflow

import (
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

const flowFixtureRoot = "../../../../packages/testing/fixtures/vendor/netflow"

type pcapPacket struct {
	origLen int
	data    []byte
}

// readPcap reads a classic libpcap file (microsecond or nanosecond magic, either byte order).
func readPcap(t *testing.T, path string) (linkType uint32, packets []pcapPacket) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) < 24 {
		t.Fatalf("%s: short pcap", path)
	}
	var bo binary.ByteOrder
	switch binary.LittleEndian.Uint32(b[0:4]) {
	case 0xa1b2c3d4, 0xa1b23c4d:
		bo = binary.LittleEndian
	case 0xd4c3b2a1, 0x4d3cb2a1:
		bo = binary.BigEndian
	default:
		t.Fatalf("%s: not a pcap file", path)
	}
	linkType = bo.Uint32(b[20:24])
	off := 24
	for off+16 <= len(b) {
		incl := int(bo.Uint32(b[off+8 : off+12]))
		orig := int(bo.Uint32(b[off+12 : off+16]))
		off += 16
		if off+incl > len(b) {
			t.Fatalf("%s: truncated record", path)
		}
		packets = append(packets, pcapPacket{origLen: orig, data: b[off : off+incl]})
		off += incl
	}
	return linkType, packets
}

type ipPacket struct {
	src, dst        string
	proto           int
	sport, dport    int
	ipLen, frameLen int
	udpPayload      []byte
}

const linkTypeEthernet = 1

// sFlow v5 raw packet header records report frame_length including the 4-byte Ethernet FCS that
// tcpdump never sees (pmacct sfprobe sets stripped=4), so sFlow bytes are captured frame length + 4.
const sflowFCSBytes = 4

// parseFrame decodes Ethernet II / IPv4 / TCP|UDP far enough for ground truth and datagram extraction.
func parseFrame(t *testing.T, p pcapPacket) (ipPacket, bool) {
	t.Helper()
	d := p.data
	if len(d) < ethernetHeaderLen+ipv4MinHeaderLen || binary.BigEndian.Uint16(d[12:14]) != ethertypeIPv4 {
		return ipPacket{}, false
	}
	ip := d[ethernetHeaderLen:]
	ihl := int(ip[0]&0x0f) * 4
	out := ipPacket{src: net.IP(ip[12:16]).String(), dst: net.IP(ip[16:20]).String(), proto: int(ip[9]), ipLen: int(binary.BigEndian.Uint16(ip[2:4])), frameLen: p.origLen}
	l4 := ip[ihl:]
	if (out.proto == protoTCP || out.proto == protoUDP) && len(l4) >= 4 {
		out.sport = int(binary.BigEndian.Uint16(l4[0:2]))
		out.dport = int(binary.BigEndian.Uint16(l4[2:4]))
	}
	if out.proto == protoUDP && len(l4) >= 8 {
		out.udpPayload = l4[8 : out.ipLen-ihl]
	}
	return out, true
}

type fiveTuple struct {
	src, dst     string
	sport, dport int
	proto        int
}

type counters struct{ bytes, packets uint64 }

// groundTruth sums IP bytes (what NetFlow counts) and frame bytes (what sFlow raw headers report)
// per unidirectional 5-tuple from the traffic the exporters observed.
func groundTruth(t *testing.T, path string) (ipBytes, frameBytes map[fiveTuple]counters) {
	t.Helper()
	lt, pkts := readPcap(t, path)
	if lt != linkTypeEthernet {
		t.Fatalf("traffic capture link type %d", lt)
	}
	ipBytes, frameBytes = map[fiveTuple]counters{}, map[fiveTuple]counters{}
	for _, p := range pkts {
		ip, ok := parseFrame(t, p)
		if !ok {
			continue
		}
		k := fiveTuple{ip.src, ip.dst, ip.sport, ip.dport, ip.proto}
		c := ipBytes[k]
		ipBytes[k] = counters{c.bytes + uint64(ip.ipLen), c.packets + 1}
		f := frameBytes[k]
		frameBytes[k] = counters{f.bytes + uint64(ip.frameLen+sflowFCSBytes), f.packets + 1}
	}
	return ipBytes, frameBytes
}

// decodeCapture feeds every exported UDP datagram, in capture order, to one Decoder.
func decodeCapture(t *testing.T, path string, d *Decoder) (exporter string, flows []Flow, datagrams int) {
	t.Helper()
	lt, pkts := readPcap(t, path)
	if lt != linkTypeEthernet {
		t.Fatalf("%s: link type %d", path, lt)
	}
	for _, p := range pkts {
		ip, ok := parseFrame(t, p)
		if !ok || ip.proto != protoUDP {
			continue
		}
		exporter = ip.src
		datagrams++
		flows = append(flows, d.Decode(ip.src, ip.udpPayload)...)
	}
	return exporter, flows, datagrams
}

func sumFlows(flows []Flow) map[fiveTuple]counters {
	out := map[fiveTuple]counters{}
	for _, f := range flows {
		k := fiveTuple{f.Src, f.Dst, f.SrcPort, f.DstPort, f.Protocol}
		c := out[k]
		out[k] = counters{c.bytes + f.Bytes, c.packets + f.Packets}
	}
	return out
}

type flowExpect struct {
	captures     []string
	exporter     string
	sflow        bool // byte counts are frame lengths × sampling rate rather than IP lengths
	client       string
	server       string
	httpPort     int
	udpPort      int
	udpDatagrams int
	httpConns    int
}

var flowExpectations = map[string]flowExpect{
	"softflowd-softflowd-1.1.0": {
		captures: []string{"netflow-v5.pcap", "netflow-v9.pcap", "ipfix.pcap"}, exporter: "192.168.128.5",
		client: "192.168.128.5", server: "192.168.128.7", httpPort: 80, udpPort: 5514, udpDatagrams: 4, httpConns: 4,
	},
	"pmacct-pmacctd-sfprobe-1.7.8": {
		captures: []string{"sflow-v5.pcap"}, exporter: "192.168.128.5", sflow: true,
		client: "192.168.128.5", server: "192.168.128.7", httpPort: 80, udpPort: 5514, udpDatagrams: 4, httpConns: 4,
	},
	// IPv6 traffic (T-322 runs it with an IPv6 ground truth; no IPv4 captures for T-307): exports
	// travelled over IPv4 from the exporter's 192.168.144.5.
	ipv6FlowFixture: {
		exporter: "192.168.144.5",
		client:   "fd00:f1ab::5", server: "fd00:f1ab::7", httpPort: 80, udpPort: 5514, udpDatagrams: 4, httpConns: 4,
	},
}

func TestREQDISC019_T307_RecordedVendorFixtures(t *testing.T) {
	entries, err := os.ReadDir(flowFixtureRoot)
	if err != nil {
		t.Fatalf("fixture root: %v", err)
	}
	dirs := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dirs++
		exp, ok := flowExpectations[e.Name()]
		if !ok {
			t.Errorf("fixture %s has no expectation row", e.Name())
			continue
		}
		dir := filepath.Join(flowFixtureRoot, e.Name())
		ipTruth, frameTruth := groundTruth(t, filepath.Join(dir, "traffic.pcap"))
		truth := ipTruth
		if exp.sflow {
			truth = frameTruth
		}
		for _, capture := range exp.captures {
			t.Run(e.Name()+"/"+capture, func(t *testing.T) {
				dec := NewDecoder()
				exporter, flows, datagrams := decodeCapture(t, filepath.Join(dir, capture), dec)
				if exporter != exp.exporter || datagrams == 0 || dec.Datagrams != datagrams || dec.Unknown != 0 {
					t.Fatalf("exporter %s datagrams %d decoder %d unknown %d", exporter, datagrams, dec.Datagrams, dec.Unknown)
				}
				got := sumFlows(flows)
				for k, c := range truth {
					g := got[k]
					if g != c {
						t.Errorf("%+v: decoded bytes/packets %d/%d, traffic capture %d/%d", k, g.bytes, g.packets, c.bytes, c.packets)
					}
				}
				for k := range got {
					if _, ok := truth[k]; !ok {
						t.Errorf("decoded flow %+v not present in the traffic capture", k)
					}
				}
				assertFlowEdges(t, flows, truth, exp)
			})
		}
	}
	if dirs == 0 {
		t.Fatal("no recorded flow fixtures found")
	}
}

func assertFlowEdges(t *testing.T, flows []Flow, truth map[fiveTuple]counters, exp flowExpect) {
	t.Helper()
	var httpBytes, udpBytes uint64
	for k, c := range truth {
		switch {
		case k.proto == protoTCP && (k.sport == exp.httpPort || k.dport == exp.httpPort):
			httpBytes += c.bytes
		case k.proto == protoUDP && k.dport == exp.udpPort:
			udpBytes += c.bytes
		}
	}
	edges := Aggregate(flows, 0)
	window := time.Minute
	obs := Emit(edges, 0, window, NewDecoder(), time.Date(2026, 11, 6, 21, 2, 0, 0, time.UTC))
	type edgeKey struct {
		from, to, proto string
		port            int
	}
	rels := map[edgeKey]map[string]any{}
	for _, r := range obs.Relationships {
		if r.Type != relCommunicates {
			t.Fatalf("unexpected relationship %s", r.Type)
		}
		k := edgeKey{r.From.Identity["address"], r.To.Identity["address"], fmt.Sprint(r.Attributes["protocol"]), r.Attributes["port"].(int)}
		rels[k] = r.Attributes
	}
	keys := make([]string, 0, len(rels))
	for k := range rels {
		keys = append(keys, fmt.Sprintf("%+v", k))
	}
	sort.Strings(keys)
	if len(rels) != 2 {
		t.Fatalf("want exactly the HTTP and UDP conversations as edges, got %d: %v", len(rels), keys)
	}
	httpEdge, ok := rels[edgeKey{exp.client, exp.server, "tcp", exp.httpPort}]
	if !ok || httpEdge["bytes"] != httpBytes {
		t.Fatalf("http edge %s -> %s:%d: %+v (want bytes %d); edges %v", exp.client, exp.server, exp.httpPort, httpEdge, httpBytes, keys)
	}
	udpEdge, ok := rels[edgeKey{exp.client, exp.server, "udp", exp.udpPort}]
	if !ok || udpEdge["bytes"] != udpBytes || udpEdge["flows"] != exp.udpDatagrams && !exp.sflow {
		t.Fatalf("udp edge: %+v (want bytes %d); edges %v", udpEdge, udpBytes, keys)
	}
	if len(obs.Cis) != 2 {
		t.Fatalf("want the client and server ip_address CIs, got %d", len(obs.Cis))
	}
	for _, ci := range obs.Cis {
		if ci.Type != typeIP || ci.Identity["vrfRef"] != defaultVrf || (ci.Identity["address"] != exp.client && ci.Identity["address"] != exp.server) {
			t.Fatalf("ip CI %+v", ci)
		}
	}
}
