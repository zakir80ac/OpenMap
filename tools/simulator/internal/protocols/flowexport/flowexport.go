// REQ-QA-005 REQ-DISC-019 — flow export encoders for simulated mode: NetFlow v5 (Cisco export format),
// NetFlow v9 (RFC 3954, template + data flowsets), IPFIX (RFC 7011, template + data sets) and sFlow v5
// (sflow.org sFlow Version 5, flow samples carrying raw packet headers). The v9 / IPFIX templates follow the
// layout softflowd 1.1.0 exports (template 1024 for IPv4 and 2048 for IPv6, first/last switched relative to
// system uptime, an options template announcing the sampling interval), which is the shape the recorded
// packets in packages/testing/fixtures/vendor/netflow show. Values come from the caller (the synthetic estate).
package flowexport

import (
	"encoding/binary"
	"net"
	"time"
)

// Record is one flow an exporter reports.
type Record struct {
	Src, Dst         net.IP
	SrcPort, DstPort uint16
	Protocol         uint8
	Bytes, Packets   uint64
	// TCPFlags is the cumulative OR of TCP flags (0 for UDP).
	TCPFlags uint8
}

func (r Record) v4() bool { return r.Src.To4() != nil && r.Dst.To4() != nil }

const (
	// MaxDatagram keeps every export datagram inside a 1500-byte Ethernet MTU after IP and UDP headers.
	MaxDatagram = 1400

	versionV5    = 5
	versionV9    = 9
	versionIPFIX = 10
	versionSFlow = 5

	v5HeaderLen  = 24
	v5RecordLen  = 48
	v5MaxRecords = 30 // the v5 format caps a datagram at 30 records

	v9HeaderLen    = 20
	ipfixHeaderLen = 16
	setHeaderLen   = 4

	v9TemplateSet       = 0
	v9OptionTemplateSet = 1
	ipfixTemplateSet    = 2
	ipfixOptionSet      = 3

	templateIPv4    = 1024
	templateIPv6    = 2048
	templateOptions = 256

	// Information elements (IANA IPFIX registry; v9 uses the same numbers for these).
	ieOctetDelta     = 1
	iePacketDelta    = 2
	ieProtocol       = 4
	ieTOS            = 5
	ieTCPFlags       = 6
	ieSrcPort        = 7
	ieIPv4Src        = 8
	ieInputIf        = 10
	ieDstPort        = 11
	ieIPv4Dst        = 12
	ieOutputIf       = 14
	ieLastSwitched   = 21
	ieFirstSwitched  = 22
	ieIPv6Src        = 27
	ieIPv6Dst        = 28
	ieSamplingIntvl  = 34
	ieSamplingAlg    = 35
	ieIPVersion      = 60
	ieDirection      = 61
	ieFlowEndReason  = 136
	ieScopeSystem    = 1 // v9 option scope "System"
	ieExportingProc  = 144
	ipv4Version      = 4
	ipv6Version      = 6
	flowEndIdle      = 1
	samplingDeterm   = 1
	unsampled        = 1
	ifIndexIn        = 1
	ifIndexOut       = 2
	flowDurationMs   = 30000
	octetLen         = 1
	shortLen         = 2
	wordLen          = 4
	ipv6Len          = 16
	sflowSampleFlow  = 1
	sflowRecordRaw   = 1
	sflowRecordSwtch = 1001
	sflowHeaderEth   = 1
	sflowAddrIPv4    = 1
	sflowSourceIf    = 1
	sflowSampleCap   = 8 // flow samples per datagram (pmacct sfprobe sends a handful per datagram)
	ethHeaderLen     = 14
	ethTypeIPv4      = 0x0800
	ethTypeIPv6      = 0x86DD
	ipv4HeaderLen    = 20
	ipv6HeaderLen    = 40
	tcpHeaderLen     = 20
	protoTCP         = 6
	protoUDP         = 17
	ipv4VersionIHL   = 0x45
	ipv6VersionWord  = 0x60000000
	tcpDataOffset    = 0x50
	defaultTTL       = 64
	tcpWindow        = 65535
	minFrame         = 64
	maxFrame         = 1518
	vlanDefault      = 1
)

func field(id, length uint16) [2]uint16 { return [2]uint16{id, length} }

// softflowd's data templates (see the recorded netflow-v9.pcap / ipfix.pcap).
var (
	fieldsV4 = [][2]uint16{
		field(ieIPv4Src, wordLen), field(ieIPv4Dst, wordLen), field(ieFirstSwitched, wordLen), field(ieLastSwitched, wordLen),
		field(ieOctetDelta, wordLen), field(iePacketDelta, wordLen), field(ieInputIf, wordLen), field(ieOutputIf, wordLen),
		field(ieDirection, octetLen), field(ieFlowEndReason, octetLen), field(ieSrcPort, shortLen), field(ieDstPort, shortLen),
		field(ieProtocol, octetLen), field(ieTCPFlags, octetLen), field(ieIPVersion, octetLen), field(ieTOS, octetLen),
	}
	fieldsV6 = [][2]uint16{
		field(ieIPv6Src, ipv6Len), field(ieIPv6Dst, ipv6Len), field(ieFirstSwitched, wordLen), field(ieLastSwitched, wordLen),
		field(ieOctetDelta, wordLen), field(iePacketDelta, wordLen), field(ieInputIf, wordLen), field(ieOutputIf, wordLen),
		field(ieDirection, octetLen), field(ieFlowEndReason, octetLen), field(ieSrcPort, shortLen), field(ieDstPort, shortLen),
		field(ieProtocol, octetLen), field(ieTCPFlags, octetLen), field(ieIPVersion, octetLen), field(ieTOS, octetLen),
	}
)

func recordLen(fields [][2]uint16) int {
	n := 0
	for _, f := range fields {
		n += int(f[1])
	}
	return n
}

func put16(b []byte, v uint16) []byte { return binary.BigEndian.AppendUint16(b, v) }
func put32(b []byte, v uint32) []byte { return binary.BigEndian.AppendUint32(b, v) }

func clamp32(v uint64) uint32 {
	if v > uint64(^uint32(0)) {
		return ^uint32(0)
	}
	return uint32(v)
}

// Exporter is one flow exporter's state: boot instant, sequence counters and its observation domain.
type Exporter struct {
	Boot     time.Time
	SourceID uint32
	Agent    net.IP
	// SamplingRate is the sFlow 1-in-N packet sampling rate (1 = every packet).
	SamplingRate uint32
	seq          uint32
	dataSent     uint32
	samples      uint32
}

func (x *Exporter) uptimeMs(now time.Time) uint32 { return uint32(now.Sub(x.Boot).Milliseconds()) }

// V5 encodes records as NetFlow v5 datagrams; IPv6 records are skipped (v5 carries IPv4 only).
func (x *Exporter) V5(records []Record, now time.Time) [][]byte {
	var v4 []Record
	for _, r := range records {
		if r.v4() {
			v4 = append(v4, r)
		}
	}
	var out [][]byte
	up := x.uptimeMs(now)
	for start := 0; start < len(v4); start += v5MaxRecords {
		end := min(start+v5MaxRecords, len(v4))
		batch := v4[start:end]
		b := make([]byte, 0, v5HeaderLen+len(batch)*v5RecordLen)
		b = put16(b, versionV5)
		b = put16(b, uint16(len(batch)))
		b = put32(b, up)
		b = put32(b, uint32(now.Unix()))
		b = put32(b, uint32(now.Nanosecond()))
		b = put32(b, x.seq)
		b = append(b, 0, 0) // engine type, engine id
		b = put16(b, 0)     // sampling interval: unsampled
		for _, r := range batch {
			b = append(b, r.Src.To4()...)
			b = append(b, r.Dst.To4()...)
			b = put32(b, 0) // next hop
			b = put16(b, ifIndexIn)
			b = put16(b, ifIndexOut)
			b = put32(b, clamp32(r.Packets))
			b = put32(b, clamp32(r.Bytes))
			b = put32(b, up-min(up, flowDurationMs))
			b = put32(b, up)
			b = put16(b, r.SrcPort)
			b = put16(b, r.DstPort)
			b = append(b, 0, r.TCPFlags, r.Protocol, 0) // pad1, tcp flags, protocol, tos
			b = put16(b, 0)                             // src AS
			b = put16(b, 0)                             // dst AS
			b = append(b, 0, 0, 0, 0)                   // src mask, dst mask, pad2
		}
		x.seq += uint32(len(batch))
		out = append(out, b)
	}
	return out
}

func templateSet(setID uint16) []byte {
	body := []byte{}
	for _, t := range []struct {
		id     uint16
		fields [][2]uint16
	}{{templateIPv4, fieldsV4}, {templateIPv6, fieldsV6}} {
		body = put16(body, t.id)
		body = put16(body, uint16(len(t.fields)))
		for _, f := range t.fields {
			body = put16(body, f[0])
			body = put16(body, f[1])
		}
	}
	return set(setID, body)
}

// optionSets announces the exporter's sampling configuration the way softflowd does: an options template
// and one options data record. The collector skips both; they are on the wire because exporters send them.
func optionSets(ipfix bool, sourceID uint32) []byte {
	var tpl, data []byte
	if ipfix {
		tpl = put16(tpl, templateOptions)
		tpl = put16(tpl, 3) // field count
		tpl = put16(tpl, 1) // scope field count
		tpl = put16(tpl, ieExportingProc)
		tpl = put16(tpl, wordLen)
		tpl = put16(tpl, ieSamplingIntvl)
		tpl = put16(tpl, wordLen)
		tpl = put16(tpl, ieSamplingAlg)
		tpl = put16(tpl, octetLen)
		data = put32(data, sourceID)
		data = put32(data, unsampled)
		data = append(data, samplingDeterm)
		return append(set(ipfixOptionSet, tpl), set(templateOptions, data)...)
	}
	tpl = put16(tpl, templateOptions)
	tpl = put16(tpl, wordLen) // option scope length (bytes)
	tpl = put16(tpl, 2*wordLen)
	tpl = put16(tpl, ieScopeSystem)
	tpl = put16(tpl, wordLen)
	tpl = put16(tpl, ieSamplingIntvl)
	tpl = put16(tpl, wordLen)
	tpl = put16(tpl, ieSamplingAlg)
	tpl = put16(tpl, octetLen)
	data = put32(data, sourceID)
	data = put32(data, unsampled)
	data = append(data, samplingDeterm)
	return append(set(v9OptionTemplateSet, tpl), set(templateOptions, data)...)
}

// set wraps a body in a flowset header, padding to a 4-byte boundary as RFC 3954 / 7011 allow.
func set(id uint16, body []byte) []byte {
	for (len(body)+setHeaderLen)%wordLen != 0 {
		body = append(body, 0)
	}
	b := put16(nil, id)
	b = put16(b, uint16(len(body)+setHeaderLen))
	return append(b, body...)
}

func dataRecord(r Record, up uint32) []byte {
	var b []byte
	if r.v4() {
		b = append(b, r.Src.To4()...)
		b = append(b, r.Dst.To4()...)
	} else {
		b = append(b, r.Src.To16()...)
		b = append(b, r.Dst.To16()...)
	}
	b = put32(b, up-min(up, flowDurationMs))
	b = put32(b, up)
	b = put32(b, clamp32(r.Bytes))
	b = put32(b, clamp32(r.Packets))
	b = put32(b, ifIndexIn)
	b = put32(b, ifIndexOut)
	b = append(b, 0, flowEndIdle)
	b = put16(b, r.SrcPort)
	b = put16(b, r.DstPort)
	version := byte(ipv4Version)
	if !r.v4() {
		version = ipv6Version
	}
	return append(b, r.Protocol, r.TCPFlags, version, 0)
}

// templated encodes v9 (ipfix=false) or IPFIX datagrams: the first datagram of every export carries the
// templates and options (template refresh), the rest carry data sets grouped by address family.
func (x *Exporter) templated(records []Record, now time.Time, ipfix bool) [][]byte {
	headerLen := v9HeaderLen
	tplSet := uint16(v9TemplateSet)
	if ipfix {
		headerLen = ipfixHeaderLen
		tplSet = ipfixTemplateSet
	}
	up := x.uptimeMs(now)
	type pending struct {
		sets  []byte
		count int // v9: templates + records in the datagram; IPFIX: data records
	}
	var out [][]byte
	flush := func(p pending) {
		if len(p.sets) == 0 {
			return
		}
		b := make([]byte, 0, headerLen+len(p.sets))
		if ipfix {
			b = put16(b, versionIPFIX)
			b = put16(b, uint16(ipfixHeaderLen+len(p.sets)))
			b = put32(b, uint32(now.Unix()))
			b = put32(b, x.dataSent)
			b = put32(b, x.SourceID)
			x.dataSent += uint32(p.count)
		} else {
			b = put16(b, versionV9)
			b = put16(b, uint16(p.count))
			b = put32(b, up)
			b = put32(b, uint32(now.Unix()))
			b = put32(b, x.seq)
			b = put32(b, x.SourceID)
			x.seq++
		}
		out = append(out, append(b, p.sets...))
	}
	first := pending{sets: append(templateSet(tplSet), optionSets(ipfix, x.SourceID)...)}
	if !ipfix {
		first.count = 2 + 1 + 1 // two data templates, one options template, one options record
	}
	flush(first)
	for _, family := range []struct {
		id uint16
		v4 bool
	}{{templateIPv4, true}, {templateIPv6, false}} {
		var cur []byte
		n := 0
		limit := MaxDatagram - headerLen - setHeaderLen - wordLen
		emit := func() {
			if n == 0 {
				return
			}
			flush(pending{sets: set(family.id, cur), count: n})
			cur, n = nil, 0
		}
		for _, r := range records {
			if r.v4() != family.v4 {
				continue
			}
			rec := dataRecord(r, up)
			if len(cur)+len(rec) > limit {
				emit()
			}
			cur = append(cur, rec...)
			n++
		}
		emit()
	}
	return out
}

// V9 encodes NetFlow v9 datagrams.
func (x *Exporter) V9(records []Record, now time.Time) [][]byte {
	return x.templated(records, now, false)
}

// IPFIX encodes IPFIX datagrams.
func (x *Exporter) IPFIX(records []Record, now time.Time) [][]byte {
	return x.templated(records, now, true)
}

// packetHeader renders the sampled packet's Ethernet / IP / L4 headers.
func packetHeader(r Record, frame uint32) []byte {
	var b []byte
	dstMac := []byte{0x00, 0x1b, 0x21, 0x00, 0x00, 0x02}
	srcMac := []byte{0x00, 0x1b, 0x21, 0x00, 0x00, 0x01}
	b = append(b, dstMac...)
	b = append(b, srcMac...)
	ipHeader := uint32(ipv6HeaderLen)
	if r.v4() {
		ipHeader = ipv4HeaderLen
		b = put16(b, ethTypeIPv4)
		ipLen := frame - ethHeaderLen
		b = append(b, ipv4VersionIHL, 0)
		b = put16(b, uint16(ipLen))
		b = put16(b, 0)      // identification
		b = put16(b, 0x4000) // don't fragment
		b = append(b, defaultTTL, r.Protocol)
		b = put16(b, 0) // checksum (header-only sample)
		b = append(b, r.Src.To4()...)
		b = append(b, r.Dst.To4()...)
	} else {
		b = put16(b, ethTypeIPv6)
		b = put32(b, ipv6VersionWord)
		b = put16(b, uint16(frame-ethHeaderLen-ipv6HeaderLen))
		b = append(b, r.Protocol, defaultTTL)
		b = append(b, r.Src.To16()...)
		b = append(b, r.Dst.To16()...)
	}
	b = put16(b, r.SrcPort)
	b = put16(b, r.DstPort)
	if r.Protocol == protoTCP {
		b = put32(b, 1) // sequence
		b = put32(b, 1) // acknowledgement
		b = append(b, tcpDataOffset, r.TCPFlags)
		b = put16(b, tcpWindow)
		b = put32(b, 0) // checksum, urgent pointer
	} else if r.Protocol == protoUDP {
		b = put16(b, uint16(frame-ethHeaderLen-ipHeader))
		b = put16(b, 0)
	}
	return b
}

func pad4(b []byte) []byte {
	for len(b)%wordLen != 0 {
		b = append(b, 0)
	}
	return b
}

func frameLen(r Record) uint32 {
	if r.Packets == 0 {
		return minFrame
	}
	f := r.Bytes / r.Packets
	return uint32(min(max(f, minFrame), maxFrame))
}

func (x *Exporter) flowSample(r Record) []byte {
	rate := max(x.SamplingRate, 1)
	frame := frameLen(r)
	hdr := packetHeader(r, frame)
	raw := put32(nil, sflowHeaderEth)
	raw = put32(raw, frame)
	raw = put32(raw, frame-uint32(len(hdr))) // bytes stripped beyond the sampled header
	raw = put32(raw, uint32(len(hdr)))
	raw = pad4(append(raw, hdr...))
	sw := put32(nil, vlanDefault)
	sw = put32(sw, 0)
	sw = put32(sw, vlanDefault)
	sw = put32(sw, 0)
	x.samples++
	s := put32(nil, x.samples)
	s = put32(s, sflowSourceIf)
	s = put32(s, rate)
	s = put32(s, x.samples*rate) // sample pool
	s = put32(s, 0)              // drops
	s = put32(s, ifIndexIn)
	s = put32(s, ifIndexOut)
	s = put32(s, 2) // records
	s = put32(s, sflowRecordRaw)
	s = put32(s, uint32(len(raw)))
	s = append(s, raw...)
	s = put32(s, sflowRecordSwtch)
	s = put32(s, uint32(len(sw)))
	s = append(s, sw...)
	out := put32(nil, sflowSampleFlow)
	out = put32(out, uint32(len(s)))
	return append(out, s...)
}

// SFlow encodes sFlow v5 datagrams: each record becomes one flow sample of a packet of the record's average
// frame size, so a collector scaling by the sampling rate sees SamplingRate packets per record.
func (x *Exporter) SFlow(records []Record, now time.Time) [][]byte {
	var out [][]byte
	agent := x.Agent.To4()
	for start := 0; start < len(records); start += sflowSampleCap {
		end := min(start+sflowSampleCap, len(records))
		b := put32(nil, versionSFlow)
		b = put32(b, sflowAddrIPv4)
		b = append(b, agent...)
		b = put32(b, x.SourceID)
		x.seq++
		b = put32(b, x.seq)
		b = put32(b, x.uptimeMs(now))
		b = put32(b, uint32(end-start))
		for _, r := range records[start:end] {
			b = append(b, x.flowSample(r)...)
		}
		out = append(out, b)
	}
	return out
}
