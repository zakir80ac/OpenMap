// T-322 REQ-DISC-019 — recorded IPv6 flow fixture: softflowd 1.1.0 NetFlow v9 and IPFIX and pmacct
// 1.7.8 sfprobe sFlow v5 exports of real IPv6 traffic (HTTP over TCP and UDP datagrams between two
// containers on a dual-stack lab bridge), captured with tcpdump on the receiver and fed byte-for-byte
// to the collector's Decoder, then Aggregate and Emit. The exports themselves travelled over IPv4; the
// IPv6 traffic the exporters saw (traffic.pcap) is the ground truth.
package netflow

import (
	"encoding/binary"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const ipv6FlowFixture = "softflowd-pmacct-ipv6-1.1.0-1.7.8"

// parseFrame6 decodes Ethernet II / IPv6 (no extension headers) / TCP|UDP for the ground truth. ipLen is
// the whole IPv6 packet (fixed header + payload), which is what the exporters count as octets.
func parseFrame6(p pcapPacket) (ipPacket, bool) {
	d := p.data
	if len(d) < ethernetHeaderLen+ipv6HeaderLen || binary.BigEndian.Uint16(d[12:14]) != ethertypeIPv6 {
		return ipPacket{}, false
	}
	ip := d[ethernetHeaderLen:]
	out := ipPacket{src: net.IP(ip[8:24]).String(), dst: net.IP(ip[24:40]).String(), proto: int(ip[6]), ipLen: ipv6HeaderLen + int(binary.BigEndian.Uint16(ip[4:6])), frameLen: p.origLen}
	l4 := ip[ipv6HeaderLen:]
	if (out.proto == protoTCP || out.proto == protoUDP) && len(l4) >= 4 {
		out.sport = int(binary.BigEndian.Uint16(l4[0:2]))
		out.dport = int(binary.BigEndian.Uint16(l4[2:4]))
	}
	return out, true
}

func groundTruth6(t *testing.T, path string) (ipBytes, frameBytes map[fiveTuple]counters) {
	t.Helper()
	lt, pkts := readPcap(t, path)
	if lt != linkTypeEthernet {
		t.Fatalf("traffic capture link type %d", lt)
	}
	ipBytes, frameBytes = map[fiveTuple]counters{}, map[fiveTuple]counters{}
	for _, p := range pkts {
		ip, ok := parseFrame6(p)
		if !ok {
			t.Fatalf("traffic capture holds a non-IPv6 frame")
		}
		k := fiveTuple{ip.src, ip.dst, ip.sport, ip.dport, ip.proto}
		c := ipBytes[k]
		ipBytes[k] = counters{c.bytes + uint64(ip.ipLen), c.packets + 1}
		f := frameBytes[k]
		frameBytes[k] = counters{f.bytes + uint64(ip.frameLen+sflowFCSBytes), f.packets + 1}
	}
	return ipBytes, frameBytes
}

func TestREQDISC019_T322_RecordedIPv6Fixtures(t *testing.T) {
	dir := filepath.Join(flowFixtureRoot, ipv6FlowFixture)
	if _, err := os.Stat(filepath.Join(dir, "traffic.pcap")); err != nil {
		t.Fatalf("IPv6 flow fixture missing: %v", err)
	}
	exp := flowExpectations[ipv6FlowFixture]
	ipTruth, frameTruth := groundTruth6(t, filepath.Join(dir, "traffic.pcap"))
	for k := range ipTruth {
		if !strings.Contains(k.src, ":") || !strings.Contains(k.dst, ":") {
			t.Fatalf("ground truth must be IPv6 only: %+v", k)
		}
	}
	for _, capture := range []string{"netflow-v9.pcap", "ipfix.pcap", "sflow-v5.pcap"} {
		t.Run(capture, func(t *testing.T) {
			truth := ipTruth
			if capture == "sflow-v5.pcap" {
				truth = frameTruth
			}
			dec := NewDecoder()
			exporter, flows, datagrams := decodeCapture(t, filepath.Join(dir, capture), dec)
			if exporter != exp.exporter || datagrams == 0 || dec.Datagrams != datagrams || dec.Unknown != 0 {
				t.Fatalf("exporter %s datagrams %d decoder %d unknown %d", exporter, datagrams, dec.Datagrams, dec.Unknown)
			}
			got := sumFlows(flows)
			for k, c := range truth {
				if g := got[k]; g != c {
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
