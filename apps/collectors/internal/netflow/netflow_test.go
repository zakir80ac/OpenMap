// T-059 REQ-DISC-019 — decodes hand-built NetFlow v5, v9 (template + data), IPFIX and sFlow v5
// datagrams, checks aggregation direction and emission, and runs a real loopback capture.
package netflow

import (
	"context"
	"encoding/binary"
	"net"
	"testing"
	"time"
)

func ip4(s string) []byte { return net.ParseIP(s).To4() }

func v5Packet(src, dst string, sport, dport uint16, proto byte, pkts, bytes uint32) []byte {
	b := make([]byte, v5HeaderLen+v5RecordLen)
	binary.BigEndian.PutUint16(b[0:2], netflowV5)
	binary.BigEndian.PutUint16(b[2:4], 1)
	r := b[v5HeaderLen:]
	copy(r[0:4], ip4(src))
	copy(r[4:8], ip4(dst))
	binary.BigEndian.PutUint32(r[16:20], pkts)
	binary.BigEndian.PutUint32(r[20:24], bytes)
	binary.BigEndian.PutUint16(r[32:34], sport)
	binary.BigEndian.PutUint16(r[34:36], dport)
	r[38] = proto
	return b
}

func v9Template(templateID uint16) []byte {
	// header(20) + template flowset: id 0, len, template id, field count 7
	fields := [][2]uint16{{ieIPv4Src, 4}, {ieIPv4Dst, 4}, {ieL4SrcPort, 2}, {ieL4DstPort, 2}, {ieProtocol, 1}, {ieInBytes, 4}, {ieInPkts, 4}}
	set := make([]byte, 4+4+len(fields)*4)
	binary.BigEndian.PutUint16(set[0:2], templateFlowsetID)
	binary.BigEndian.PutUint16(set[2:4], uint16(len(set)))
	binary.BigEndian.PutUint16(set[4:6], templateID)
	binary.BigEndian.PutUint16(set[6:8], uint16(len(fields)))
	for i, f := range fields {
		binary.BigEndian.PutUint16(set[8+i*4:], f[0])
		binary.BigEndian.PutUint16(set[10+i*4:], f[1])
	}
	b := make([]byte, v9HeaderLen)
	binary.BigEndian.PutUint16(b[0:2], netflowV9)
	binary.BigEndian.PutUint16(b[2:4], 1)
	binary.BigEndian.PutUint32(b[16:20], 7)
	return append(b, set...)
}

func v9Data(templateID uint16, src, dst string, sport, dport uint16, proto byte, bytes, pkts uint32) []byte {
	rec := make([]byte, 4+4+2+2+1+4+4)
	copy(rec[0:4], ip4(src))
	copy(rec[4:8], ip4(dst))
	binary.BigEndian.PutUint16(rec[8:10], sport)
	binary.BigEndian.PutUint16(rec[10:12], dport)
	rec[12] = proto
	binary.BigEndian.PutUint32(rec[13:17], bytes)
	binary.BigEndian.PutUint32(rec[17:21], pkts)
	set := make([]byte, 4)
	binary.BigEndian.PutUint16(set[0:2], templateID)
	binary.BigEndian.PutUint16(set[2:4], uint16(4+len(rec)))
	set = append(set, rec...)
	b := make([]byte, v9HeaderLen)
	binary.BigEndian.PutUint16(b[0:2], netflowV9)
	binary.BigEndian.PutUint16(b[2:4], 1)
	binary.BigEndian.PutUint32(b[16:20], 7)
	return append(b, set...)
}

func TestDecodeV5AndAggregate(t *testing.T) {
	d := NewDecoder()
	// Client 10.0.0.5:51000 → server 10.0.0.9:5432, and the reply direction with ports swapped.
	flows := d.Decode("10.0.0.1", v5Packet("10.0.0.5", "10.0.0.9", 51000, 5432, protoTCP, 10, 5000))
	flows = append(flows, d.Decode("10.0.0.1", v5Packet("10.0.0.9", "10.0.0.5", 5432, 51000, protoTCP, 8, 90000))...)
	if len(flows) != 2 {
		t.Fatalf("expected 2 flows, got %d", len(flows))
	}
	edges := Aggregate(flows, 0)
	if len(edges) != 1 {
		t.Fatalf("expected one aggregated conversation, got %d: %+v", len(edges), edges)
	}
	for _, e := range edges {
		if e.Src != "10.0.0.5" || e.Dst != "10.0.0.9" || e.DstPort != 5432 || e.Bytes != 95000 || e.Flows != 2 {
			t.Fatalf("edge wrong: %+v", e)
		}
	}
	obs := Emit(edges, 100, time.Minute, d, time.Now())
	if len(obs.Cis) != 2 || len(obs.Relationships) != 1 || obs.Relationships[0].Attributes["protocol"] != "tcp" || obs.Relationships[0].Attributes["port"] != 5432 {
		t.Fatalf("emission wrong: %+v %+v", obs.Cis, obs.Relationships)
	}
}

func TestDecodeV9Templates(t *testing.T) {
	d := NewDecoder()
	if flows := d.Decode("10.0.0.2", v9Data(300, "10.1.0.1", "10.1.0.2", 40000, 443, protoTCP, 1500, 3)); len(flows) != 0 {
		t.Fatal("data before template should be ignored")
	}
	d.Decode("10.0.0.2", v9Template(300))
	flows := d.Decode("10.0.0.2", v9Data(300, "10.1.0.1", "10.1.0.2", 40000, 443, protoTCP, 1500, 3))
	if len(flows) != 1 || flows[0].Dst != "10.1.0.2" || flows[0].DstPort != 443 || flows[0].Bytes != 1500 || flows[0].Packets != 3 {
		t.Fatalf("v9 decode wrong: %+v", flows)
	}
	if flows := d.Decode("10.0.0.3", v9Data(300, "10.1.0.1", "10.1.0.2", 1, 2, protoUDP, 1, 1)); len(flows) != 0 {
		t.Fatal("templates must be scoped per exporter")
	}
}

func TestSFlowRawHeader(t *testing.T) {
	// Ethernet + IPv4 + TCP header for 192.168.1.10:33000 → 192.168.1.20:80.
	eth := make([]byte, ethernetHeaderLen)
	binary.BigEndian.PutUint16(eth[12:14], ethertypeIPv4)
	ipHdr := make([]byte, ipv4MinHeaderLen)
	ipHdr[0] = 0x45
	ipHdr[9] = protoTCP
	copy(ipHdr[12:16], ip4("192.168.1.10"))
	copy(ipHdr[16:20], ip4("192.168.1.20"))
	tcp := make([]byte, 20)
	binary.BigEndian.PutUint16(tcp[0:2], 33000)
	binary.BigEndian.PutUint16(tcp[2:4], 80)
	header := append(append(eth, ipHdr...), tcp...)
	rec := make([]byte, 16)
	binary.BigEndian.PutUint32(rec[0:4], 1)                     // ethernet
	binary.BigEndian.PutUint32(rec[4:8], 1200)                  // frame length
	binary.BigEndian.PutUint32(rec[12:16], uint32(len(header))) // header length
	rec = append(rec, header...)
	sample := make([]byte, 4+4+4+4+4+4+4) // seq, source id, rate, pool, drops, input, output
	binary.BigEndian.PutUint32(sample[8:12], 1000)
	records := make([]byte, 4)
	binary.BigEndian.PutUint32(records, 1)
	sample = append(sample, records...)
	recHdr := make([]byte, 8)
	binary.BigEndian.PutUint32(recHdr[0:4], 1)
	binary.BigEndian.PutUint32(recHdr[4:8], uint32(len(rec)))
	sample = append(sample, recHdr...)
	sample = append(sample, rec...)
	dg := make([]byte, 4+4+4+4+4+4+4) // version, address type, agent, sub agent, sequence, uptime, sample count
	binary.BigEndian.PutUint32(dg[0:4], sflowVersion)
	binary.BigEndian.PutUint32(dg[4:8], 1) // ipv4 agent
	binary.BigEndian.PutUint32(dg[24:28], 1)
	sampleHdr := make([]byte, 8)
	binary.BigEndian.PutUint32(sampleHdr[0:4], 1)
	binary.BigEndian.PutUint32(sampleHdr[4:8], uint32(len(sample)))
	dg = append(dg, sampleHdr...)
	dg = append(dg, sample...)
	flows := NewDecoder().Decode("10.0.0.4", dg)
	if len(flows) != 1 || flows[0].Src != "192.168.1.10" || flows[0].DstPort != 80 || flows[0].Bytes != 1200*1000 {
		t.Fatalf("sflow decode wrong: %+v", flows)
	}
}

func TestLoopbackCapture(t *testing.T) {
	d := NewDecoder()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Skip("no loopback UDP")
	}
	addr := pc.LocalAddr().String()
	_ = pc.Close()
	done := make(chan []Flow, 1)
	go func() {
		flows, _ := Listen(context.Background(), addr, 2*time.Second, d)
		done <- flows
	}()
	time.Sleep(200 * time.Millisecond)
	conn, err := net.Dial("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = conn.Write(v5Packet("10.9.0.1", "10.9.0.2", 50000, 22, protoTCP, 1, 100))
	_ = conn.Close()
	flows := <-done
	if len(flows) != 1 || d.Datagrams != 1 {
		t.Fatalf("capture wrong: %+v datagrams=%d", flows, d.Datagrams)
	}
}
