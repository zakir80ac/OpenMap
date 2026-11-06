// REQ-DISC-019 REQ-DEP-002 — flow collector: listens for NetFlow v5, NetFlow v9, IPFIX and sFlow v5
// datagrams for the job's capture window, aggregates conversations per (source, destination,
// destination port, protocol) and emits ip_address CIs joined by communicates_with relationships
// carrying bytes, packets and flow counts. Application dependency mapping builds on these edges.
package netflow

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	collectorID       = "netflow"
	version           = "0.1.0"
	evidenceKind      = "flow_sample"
	optionListen      = "listenAddress" // ip to bind, default all interfaces
	optionPort        = "listenPort"
	optionSeconds     = "captureSeconds"
	optionMinBytes    = "minBytes"
	optionMaxEdges    = "maxEdges"
	defaultPort       = 2055
	defaultSeconds    = 60
	defaultMaxEdges   = 20000
	maxDatagram       = 65535
	defaultVrf        = "default"
	typeIP            = "ip_address"
	relCommunicates   = "communicates_with"
	netflowV5         = 5
	netflowV9         = 9
	ipfixVersion      = 10
	sflowVersion      = 5
	v5HeaderLen       = 24
	v5RecordLen       = 48
	v9HeaderLen       = 20
	ipfixHeaderLen    = 16
	templateFlowsetID = 0
	optionTemplateID  = 1
	ipfixTemplateID   = 2
	ipfixOptionID     = 3
	minDataFlowsetID  = 256
	protoTCP          = 6
	protoUDP          = 17
	ethernetHeaderLen = 14
	ethertypeIPv4     = 0x0800
	ethertypeIPv6     = 0x86DD
	ethertypeVLAN     = 0x8100
	ipv6HeaderLen     = 40
	ipv4MinHeaderLen  = 20
	bitsPerByte       = 8
)

// NetFlow v9 / IPFIX information element ids used for aggregation.
const (
	ieInBytes      = 1
	ieInPkts       = 2
	ieProtocol     = 4
	ieL4SrcPort    = 7
	ieIPv4Src      = 8
	ieL4DstPort    = 11
	ieIPv4Dst      = 12
	ieIPv6Src      = 27
	ieIPv6Dst      = 28
	ieOctetDelta   = 1
	iePacketDelta  = 2
	ieFlowStartMs  = 152
	ieFlowEndMs    = 153
	ieReverseBytes = 23
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "netflow", Version: version, Language: "go",
		Protocols: []string{"netflow-v5", "netflow-v9", "ipfix", "sflow-v5"}, CredentialTypes: []string{"none"},
		TargetKinds: []string{"flow_source"}, Emits: []string{typeIP},
		ContractVersion: contract.Version,
	}
}

// Flow is one decoded flow record.
type Flow struct {
	Exporter string
	Src      string
	Dst      string
	SrcPort  int
	DstPort  int
	Protocol int
	Bytes    uint64
	Packets  uint64
}

type templateField struct {
	id     uint16
	length uint16
}

type templateKey struct {
	exporter string
	sourceID uint32
	id       uint16
}

// Decoder keeps v9/IPFIX templates per exporter and turns datagrams into flows.
type Decoder struct {
	mu        sync.Mutex
	templates map[templateKey][]templateField
	Datagrams int
	Unknown   int
}

func NewDecoder() *Decoder {
	return &Decoder{templates: map[templateKey][]templateField{}}
}

// Decode handles one datagram from an exporter.
func (d *Decoder) Decode(exporter string, b []byte) []Flow {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.Datagrams++
	if len(b) < 4 {
		return nil
	}
	ver := binary.BigEndian.Uint16(b[0:2])
	switch {
	case ver == netflowV5:
		return decodeV5(exporter, b)
	case ver == netflowV9:
		return d.decodeV9(exporter, b)
	case ver == ipfixVersion:
		return d.decodeIPFIX(exporter, b)
	case binary.BigEndian.Uint32(b[0:4]) == sflowVersion:
		return decodeSFlow(exporter, b)
	default:
		d.Unknown++
		return nil
	}
}

func decodeV5(exporter string, b []byte) []Flow {
	if len(b) < v5HeaderLen {
		return nil
	}
	count := int(binary.BigEndian.Uint16(b[2:4]))
	var flows []Flow
	for i := 0; i < count; i++ {
		off := v5HeaderLen + i*v5RecordLen
		if off+v5RecordLen > len(b) {
			break
		}
		r := b[off : off+v5RecordLen]
		flows = append(flows, Flow{
			Exporter: exporter,
			Src:      net.IP(r[0:4]).String(), Dst: net.IP(r[4:8]).String(),
			Packets: uint64(binary.BigEndian.Uint32(r[16:20])), Bytes: uint64(binary.BigEndian.Uint32(r[20:24])),
			SrcPort: int(binary.BigEndian.Uint16(r[32:34])), DstPort: int(binary.BigEndian.Uint16(r[34:36])), Protocol: int(r[38]),
		})
	}
	return flows
}

func (d *Decoder) decodeV9(exporter string, b []byte) []Flow {
	if len(b) < v9HeaderLen {
		return nil
	}
	sourceID := binary.BigEndian.Uint32(b[16:20])
	return d.decodeSets(exporter, sourceID, b[v9HeaderLen:], false)
}

func (d *Decoder) decodeIPFIX(exporter string, b []byte) []Flow {
	if len(b) < ipfixHeaderLen {
		return nil
	}
	length := int(binary.BigEndian.Uint16(b[2:4]))
	if length > len(b) {
		length = len(b)
	}
	domain := binary.BigEndian.Uint32(b[12:16])
	return d.decodeSets(exporter, domain, b[ipfixHeaderLen:length], true)
}

func (d *Decoder) decodeSets(exporter string, sourceID uint32, b []byte, ipfix bool) []Flow {
	var flows []Flow
	for len(b) >= 4 {
		setID := binary.BigEndian.Uint16(b[0:2])
		setLen := int(binary.BigEndian.Uint16(b[2:4]))
		if setLen < 4 || setLen > len(b) {
			break
		}
		body := b[4:setLen]
		switch {
		case setID == templateFlowsetID || setID == ipfixTemplateID:
			d.parseTemplates(exporter, sourceID, body)
		case setID == optionTemplateID || setID == ipfixOptionID:
			// Option templates describe exporter metadata, not flows.
		case setID >= minDataFlowsetID:
			if tpl, ok := d.templates[templateKey{exporter, sourceID, setID}]; ok {
				flows = append(flows, decodeData(exporter, tpl, body, ipfix)...)
			}
		}
		b = b[setLen:]
	}
	return flows
}

func (d *Decoder) parseTemplates(exporter string, sourceID uint32, b []byte) {
	for len(b) >= 4 {
		id := binary.BigEndian.Uint16(b[0:2])
		count := int(binary.BigEndian.Uint16(b[2:4]))
		b = b[4:]
		fields := make([]templateField, 0, count)
		for i := 0; i < count && len(b) >= 4; i++ {
			fid := binary.BigEndian.Uint16(b[0:2])
			flen := binary.BigEndian.Uint16(b[2:4])
			b = b[4:]
			if fid&0x8000 != 0 { // IPFIX enterprise field: skip the enterprise number
				if len(b) < 4 {
					return
				}
				b = b[4:]
				fid &= 0x7fff
			}
			fields = append(fields, templateField{id: fid, length: flen})
		}
		d.templates[templateKey{exporter, sourceID, id}] = fields
	}
}

func recordLen(tpl []templateField) int {
	n := 0
	for _, f := range tpl {
		if f.length == 0xffff {
			return -1 // variable-length records are not aggregated
		}
		n += int(f.length)
	}
	return n
}

func uintField(b []byte) uint64 {
	var v uint64
	for _, c := range b {
		v = v<<bitsPerByte | uint64(c)
	}
	return v
}

func decodeData(exporter string, tpl []templateField, b []byte, _ bool) []Flow {
	rl := recordLen(tpl)
	if rl <= 0 {
		return nil
	}
	var flows []Flow
	for len(b) >= rl {
		f := Flow{Exporter: exporter}
		off := 0
		for _, field := range tpl {
			v := b[off : off+int(field.length)]
			switch field.id {
			case ieIPv4Src:
				if len(v) == net.IPv4len {
					f.Src = net.IP(v).String()
				}
			case ieIPv4Dst:
				if len(v) == net.IPv4len {
					f.Dst = net.IP(v).String()
				}
			case ieIPv6Src:
				if len(v) == net.IPv6len {
					f.Src = net.IP(v).String()
				}
			case ieIPv6Dst:
				if len(v) == net.IPv6len {
					f.Dst = net.IP(v).String()
				}
			case ieL4SrcPort:
				f.SrcPort = int(uintField(v))
			case ieL4DstPort:
				f.DstPort = int(uintField(v))
			case ieProtocol:
				f.Protocol = int(uintField(v))
			case ieInBytes:
				f.Bytes = uintField(v)
			case ieInPkts:
				f.Packets = uintField(v)
			}
			off += int(field.length)
		}
		if f.Src != "" && f.Dst != "" {
			flows = append(flows, f)
		}
		b = b[rl:]
	}
	return flows
}

// decodeSFlow handles sFlow v5 flow samples with raw packet headers (the common switch export).
func decodeSFlow(exporter string, b []byte) []Flow {
	if len(b) < 28 {
		return nil
	}
	off := 4
	addrType := binary.BigEndian.Uint32(b[off : off+4])
	off += 4
	if addrType == 1 {
		off += net.IPv4len
	} else {
		off += net.IPv6len
	}
	off += 4 + 4 + 4 // sub agent id, sequence, uptime
	if off+4 > len(b) {
		return nil
	}
	samples := int(binary.BigEndian.Uint32(b[off : off+4]))
	off += 4
	var flows []Flow
	for i := 0; i < samples && off+8 <= len(b); i++ {
		format := binary.BigEndian.Uint32(b[off : off+4])
		length := int(binary.BigEndian.Uint32(b[off+4 : off+8]))
		off += 8
		if off+length > len(b) {
			break
		}
		sample := b[off : off+length]
		off += length
		if format&0xfff != 1 && format&0xfff != 3 { // flow sample / expanded flow sample
			continue
		}
		flows = append(flows, sflowSample(exporter, sample, format&0xfff == 3)...)
	}
	return flows
}

func sflowSample(exporter string, s []byte, expanded bool) []Flow {
	// sequence(4) source id(4 or 8) rate(4) pool(4) drops(4) input(4 or 8) output(4 or 8) records(4)
	off := 4
	if expanded {
		off += 8 + 4 + 4 + 4 + 8 + 8
	} else {
		off += 4 + 4 + 4 + 4 + 4 + 4
	}
	if off+4 > len(s) {
		return nil
	}
	rate := uint64(1)
	if expanded {
		rate = uint64(binary.BigEndian.Uint32(s[12:16]))
	} else {
		rate = uint64(binary.BigEndian.Uint32(s[8:12]))
	}
	if rate == 0 {
		rate = 1
	}
	records := int(binary.BigEndian.Uint32(s[off : off+4]))
	off += 4
	var flows []Flow
	for i := 0; i < records && off+8 <= len(s); i++ {
		format := binary.BigEndian.Uint32(s[off : off+4])
		length := int(binary.BigEndian.Uint32(s[off+4 : off+8]))
		off += 8
		if off+length > len(s) {
			break
		}
		rec := s[off : off+length]
		off += length
		if format&0xfff != 1 || len(rec) < 16 { // raw packet header
			continue
		}
		protocol := binary.BigEndian.Uint32(rec[0:4])
		frameLen := uint64(binary.BigEndian.Uint32(rec[4:8]))
		headerLen := int(binary.BigEndian.Uint32(rec[12:16]))
		if protocol != 1 || 16+headerLen > len(rec) { // 1 = ethernet
			continue
		}
		if f, ok := parseEthernet(rec[16 : 16+headerLen]); ok {
			f.Exporter = exporter
			f.Bytes = frameLen * rate
			f.Packets = rate
			flows = append(flows, f)
		}
	}
	return flows
}

func parseEthernet(p []byte) (Flow, bool) {
	if len(p) < ethernetHeaderLen {
		return Flow{}, false
	}
	etherType := binary.BigEndian.Uint16(p[12:14])
	off := ethernetHeaderLen
	if etherType == ethertypeVLAN && len(p) >= off+4 {
		etherType = binary.BigEndian.Uint16(p[off+2 : off+4])
		off += 4
	}
	switch etherType {
	case ethertypeIPv4:
		if len(p) < off+ipv4MinHeaderLen {
			return Flow{}, false
		}
		ihl := int(p[off]&0x0f) * 4
		f := Flow{Src: net.IP(p[off+12 : off+16]).String(), Dst: net.IP(p[off+16 : off+20]).String(), Protocol: int(p[off+9])}
		return withPorts(f, p[off+ihl:]), true
	case ethertypeIPv6:
		if len(p) < off+ipv6HeaderLen {
			return Flow{}, false
		}
		f := Flow{Src: net.IP(p[off+8 : off+24]).String(), Dst: net.IP(p[off+24 : off+40]).String(), Protocol: int(p[off+6])}
		return withPorts(f, p[off+ipv6HeaderLen:]), true
	default:
		return Flow{}, false
	}
}

func withPorts(f Flow, l4 []byte) Flow {
	if (f.Protocol == protoTCP || f.Protocol == protoUDP) && len(l4) >= 4 {
		f.SrcPort = int(binary.BigEndian.Uint16(l4[0:2]))
		f.DstPort = int(binary.BigEndian.Uint16(l4[2:4]))
	}
	return f
}

// Edge is an aggregated conversation.
type Edge struct {
	Src, Dst  string
	DstPort   int
	Protocol  int
	Bytes     uint64
	Packets   uint64
	Flows     int
	Exporters map[string]bool
}

// Aggregate folds flows into edges keyed by source, destination, destination port and protocol.
// Server-side ports are assumed to be the lower well-known side: a reply flow (source port below the
// destination port, destination port in a client ephemeral range or the source a well-known port) is
// recorded in the reverse direction so both halves of a conversation fold into one edge.
func Aggregate(flows []Flow, minBytes uint64) map[string]*Edge {
	// Linux clients draw ephemeral ports from 32768 (ip_local_port_range); the IANA / Windows dynamic
	// range (49152) lies above it, so the lower bound covers both.
	const ephemeralPortFloor = 32768
	const wellKnownPortLimit = 1024
	edges := map[string]*Edge{}
	for _, f := range flows {
		src, dst, port := f.Src, f.Dst, f.DstPort
		reply := f.SrcPort > 0 && f.SrcPort < f.DstPort &&
			(f.DstPort >= ephemeralPortFloor || f.SrcPort < wellKnownPortLimit && f.DstPort >= wellKnownPortLimit)
		if reply {
			src, dst, port = f.Dst, f.Src, f.SrcPort
		}
		key := src + ">" + dst + ":" + strconv.Itoa(port) + "/" + strconv.Itoa(f.Protocol)
		e, ok := edges[key]
		if !ok {
			e = &Edge{Src: src, Dst: dst, DstPort: port, Protocol: f.Protocol, Exporters: map[string]bool{}}
			edges[key] = e
		}
		e.Bytes += f.Bytes
		e.Packets += f.Packets
		e.Flows++
		e.Exporters[f.Exporter] = true
	}
	for k, e := range edges {
		if e.Bytes < minBytes {
			delete(edges, k)
		}
	}
	return edges
}

func protoName(p int) string {
	switch p {
	case protoTCP:
		return "tcp"
	case protoUDP:
		return "udp"
	case 1:
		return "icmp"
	case 58:
		return "icmpv6"
	default:
		return strconv.Itoa(p)
	}
}

// Emit converts edges into ip_address CIs and communicates_with relationships (largest edges first).
func Emit(edges map[string]*Edge, maxEdges int, window time.Duration, decoder *Decoder, at time.Time) collector.Observation {
	obs := collector.Observation{}
	list := make([]*Edge, 0, len(edges))
	for _, e := range edges {
		list = append(list, e)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Bytes > list[j].Bytes })
	if maxEdges > 0 && len(list) > maxEdges {
		list = list[:maxEdges]
	}
	summary := map[string]any{"datagrams": decoder.Datagrams, "unknownVersions": decoder.Unknown, "edges": len(list), "captureSeconds": int(window.Seconds())}
	if raw, err := json.Marshal(summary); err == nil {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: raw})
	}
	seen := map[string]bool{}
	ipRef := func(addr string) contract.CiRef {
		identity := map[string]string{"address": addr, "vrfRef": defaultVrf}
		if !seen[addr] {
			seen[addr] = true
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: identity, Name: addr, Attributes: map[string]any{"seenInFlows": true, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		}
		return contract.CiRef{Type: typeIP, Identity: identity}
	}
	for _, e := range list {
		exporters := make([]string, 0, len(e.Exporters))
		for x := range e.Exporters {
			exporters = append(exporters, x)
		}
		sort.Strings(exporters)
		from := ipRef(e.Src)
		to := ipRef(e.Dst)
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relCommunicates, From: from, To: to,
			Attributes: map[string]any{"protocol": protoName(e.Protocol), "port": e.DstPort, "bytes": e.Bytes, "packets": e.Packets, "flows": e.Flows, "bytesPerSecond": float64(e.Bytes) / window.Seconds(), "exporters": exporters, "windowSeconds": int(window.Seconds())},
			ObservedAt: at})
	}
	return obs
}

// Listen captures datagrams on addr for the window and returns decoded flows.
func Listen(ctx context.Context, addr string, window time.Duration, decoder *Decoder) ([]Flow, error) {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return nil, collector.Errorf(contract.ErrInternal, false, "listen %s: %v", addr, err)
	}
	defer pc.Close()
	deadline := time.Now().Add(window)
	if dl, ok := ctx.Deadline(); ok && dl.Before(deadline) {
		deadline = dl
	}
	buf := make([]byte, maxDatagram)
	var flows []Flow
	for {
		_ = pc.SetReadDeadline(deadline)
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				return flows, nil
			}
			if ctx.Err() != nil {
				return flows, nil
			}
			return flows, err
		}
		exporter := from.String()
		if h, _, err := net.SplitHostPort(exporter); err == nil {
			exporter = h
		}
		flows = append(flows, decoder.Decode(exporter, buf[:n])...)
	}
}

func intOption(options map[string]any, key string, fallback int) int {
	switch v := options[key].(type) {
	case float64:
		if v > 0 {
			return int(v)
		}
	case int:
		if v > 0 {
			return v
		}
	case string:
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func (Collector) Collect(ctx context.Context, target contract.Target, _ *contract.Credential, options map[string]any) (collector.Observation, error) {
	listen, _ := options[optionListen].(string)
	port := intOption(options, optionPort, defaultPort)
	window := time.Duration(intOption(options, optionSeconds, defaultSeconds)) * time.Second
	decoder := NewDecoder()
	flows, err := Listen(ctx, net.JoinHostPort(listen, strconv.Itoa(port)), window, decoder)
	if err != nil {
		return collector.Observation{}, err
	}
	if decoder.Datagrams == 0 {
		return collector.Observation{}, collector.Errorf(contract.ErrUnreachable, true, "no flow datagrams received from %s on udp/%d in %s", target.Value, port, window)
	}
	edges := Aggregate(flows, uint64(intOption(options, optionMinBytes, 0)))
	obs := Emit(edges, intOption(options, optionMaxEdges, defaultMaxEdges), window, decoder, time.Now().UTC())
	obs.Evidence[0].Data = append(obs.Evidence[0].Data, []byte("\nflowSource="+strings.ToLower(target.Value))...)
	return obs, nil
}
