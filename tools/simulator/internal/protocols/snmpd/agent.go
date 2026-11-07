// REQ-QA-005 REQ-DISC-001 REQ-DISC-026 — a simulated SNMP agent on UDP, built on gosnmp's packet
// codec (GoSNMP.SnmpDecodePacket to read requests, SnmpPacket.MarshalMsg to write responses). It answers GET,
// GETNEXT and GETBULK over a MIB tree with the protocol rules device agents follow:
//   - SNMPv1 (RFC 1157): community check, noSuchName with error-index for a missing object or the end of the
//     MIB, no GETBULK, Counter64 objects skipped (RFC 2576 §4.2.1);
//   - SNMPv2c (RFC 3416): per-varbind noSuchObject / noSuchInstance / endOfMibView, GETBULK non-repeaters
//     and max-repetitions, responses truncated to the agent's maximum message size;
//   - SNMPv3 USM (RFC 3414, RFC 7860, RFC 3826): engine ID discovery, unknown engine / user / security
//     level reports, HMAC-MD5/SHA-1/SHA-2 authentication, DES / AES-128/192/256 privacy (Blumenthal and
//     Reeder key extension, as gosnmp implements them), and the 150-second time window.
//
// Requests with a wrong community are dropped, as real agents drop them (snmpInBadCommunityNames).
package snmpd

import (
	"bytes"
	"crypto/hmac"
	"crypto/md5" //nolint:gosec // HMAC-MD5-96 is an SNMPv3 USM authentication protocol (RFC 3414)
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // HMAC-SHA-96 is an SNMPv3 USM authentication protocol (RFC 3414)
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"net"
	"sync"
	"sync/atomic"
	"time"

	g "github.com/gosnmp/gosnmp"
)

const (
	// MaxMessageSize is the agent's msgMaxSize: an Ethernet MTU less IPv4 and UDP headers, the size device
	// agents keep responses to so they are never fragmented. GETBULK responses are cut to fit it.
	MaxMessageSize = 1472
	// datagramSize is the largest UDP payload the agent reads.
	datagramSize = 65535
	// timeWindow is the USM time window in seconds (RFC 3414 §3.2.7).
	timeWindow = 150
	aesSaltLen = 8
	desSaltLen = 4
	// engineIDFormatMAC is the RFC 3411 snmpEngineID format octet for a MAC address.
	engineIDFormatMAC = 3
	// engineIDEnterpriseBit marks an RFC 3411 (post-SNMPv1) engine ID.
	engineIDEnterpriseBit = 0x80000000
	berSequence           = 0x30
	berInteger            = 0x02
	berLongForm           = 0x80
)

// USM statistics and MPD counters reported to managers (RFC 3414 §5, RFC 3412 §5).
const (
	oidUnsupportedSecLevels = ".1.3.6.1.6.3.15.1.1.1.0"
	oidNotInTimeWindows     = ".1.3.6.1.6.3.15.1.1.2.0"
	oidUnknownUserNames     = ".1.3.6.1.6.3.15.1.1.3.0"
	oidUnknownEngineIDs     = ".1.3.6.1.6.3.15.1.1.4.0"
	oidWrongDigests         = ".1.3.6.1.6.3.15.1.1.5.0"
	oidDecryptionErrors     = ".1.3.6.1.6.3.15.1.1.6.0"
	oidUnknownContexts      = ".1.3.6.1.6.3.12.1.1.5.0"
)

// User is the agent's one SNMPv3 USM user.
type User struct {
	Name           string
	Auth           g.SnmpV3AuthProtocol
	AuthPassphrase string
	Priv           g.SnmpV3PrivProtocol
	PrivPassphrase string
}

func (u *User) level() g.SnmpV3MsgFlags {
	switch {
	case u.Auth == g.NoAuth:
		return g.NoAuthNoPriv
	case u.Priv == g.NoPriv:
		return g.AuthNoPriv
	default:
		return g.AuthPriv
	}
}

// Config is what the agent accepts.
type Config struct {
	// Community is the read community for v1 and v2c; empty disables community-based access.
	Community string
	V1, V2c   bool
	// User enables SNMPv3 with this USM user (nil disables v3).
	User *User
	// EngineID is the authoritative snmpEngineID (5 to 32 octets); see EngineID.
	EngineID []byte
	// EngineBoots and EngineTime are snmpEngineBoots and the snmpEngineTime at start.
	EngineBoots uint32
	EngineTime  uint32
}

// EngineID builds an RFC 3411 engine ID from an IANA enterprise number and a MAC address.
func EngineID(enterprise uint32, mac []byte) []byte {
	id := make([]byte, 4, 5+len(mac))
	binary.BigEndian.PutUint32(id, enterprise|engineIDEnterpriseBit)
	return append(append(id, engineIDFormatMAC), mac...)
}

// Stats counts what the agent answered and refused.
type Stats struct {
	Requests, BadCommunity, UnknownEngineIDs, UnknownUserNames, UnsupportedSecLevels, WrongDigests, NotInTimeWindows, DecryptionErrors atomic.Int64
}

// Agent is one listening simulated device.
type Agent struct {
	conn  *net.UDPConn
	mib   *MIB
	cfg   Config
	start time.Time
	Stats Stats

	dec        *g.GoSNMP
	secretKey  []byte
	privKey    []byte
	desCounter atomic.Uint32
	closeOnce  sync.Once
	done       chan struct{}
}

// Listen binds a UDP port on host and serves mib until Close (used by the protocol tests; simulators open
// their socket with sim.ListenUDP and call Serve).
func Listen(host string, mib *MIB, cfg Config) (*Agent, error) {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP(host), Port: 0})
	if err != nil {
		return nil, err
	}
	a, err := Serve(conn, mib, cfg)
	if err != nil {
		_ = conn.Close()
	}
	return a, err
}

// Serve answers SNMP on conn from mib until Close.
func Serve(conn *net.UDPConn, mib *MIB, cfg Config) (*Agent, error) {
	if err := mib.Err(); err != nil {
		return nil, err
	}
	mib.freeze()
	a := &Agent{mib: mib, cfg: cfg, start: time.Now(), done: make(chan struct{})}
	if cfg.User != nil {
		if len(cfg.EngineID) < 5 || len(cfg.EngineID) > 32 {
			return nil, fmt.Errorf("snmpEngineID must be 5 to 32 octets, got %d", len(cfg.EngineID))
		}
		usm := &g.UsmSecurityParameters{
			UserName: cfg.User.Name, AuthoritativeEngineID: string(cfg.EngineID),
			AuthenticationProtocol: cfg.User.Auth, AuthenticationPassphrase: cfg.User.AuthPassphrase,
			PrivacyProtocol: cfg.User.Priv, PrivacyPassphrase: cfg.User.PrivPassphrase,
		}
		if err := usm.InitSecurityKeys(); err != nil {
			return nil, fmt.Errorf("localize USM keys: %w", err)
		}
		a.secretKey, a.privKey = usm.SecretKey, usm.PrivacyKey
		a.dec = &g.GoSNMP{Version: g.Version3, SecurityModel: g.UserSecurityModel, MsgFlags: cfg.User.level(), SecurityParameters: usm}
	}
	a.conn = conn
	go a.serve()
	return a, nil
}

// Port is the UDP port the agent listens on.
func (a *Agent) Port() int { return a.conn.LocalAddr().(*net.UDPAddr).Port }

func (a *Agent) Close() error {
	var err error
	a.closeOnce.Do(func() {
		close(a.done)
		err = a.conn.Close()
	})
	return err
}

func (a *Agent) serve() {
	buf := make([]byte, datagramSize)
	for {
		n, addr, err := a.conn.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-a.done:
				return
			default:
				continue
			}
		}
		out := a.handle(append([]byte(nil), buf[:n]...))
		if out != nil {
			_, _ = a.conn.WriteToUDP(out, addr)
		}
	}
}

func (a *Agent) engineTime() uint32 {
	return a.cfg.EngineTime + uint32(time.Since(a.start)/time.Second)
}

// handle answers one datagram; nil means drop it. Malformed input never takes the agent down.
func (a *Agent) handle(msg []byte) (out []byte) {
	defer func() {
		if recover() != nil {
			out = nil
		}
	}()
	version, ok := peekVersion(msg)
	if !ok {
		return nil
	}
	a.Stats.Requests.Add(1)
	switch version {
	case g.Version1, g.Version2c:
		return a.handleCommunity(msg, version)
	case g.Version3:
		if a.dec == nil {
			return nil
		}
		return a.handleUSM(msg)
	}
	return nil
}

// peekVersion reads the msgVersion INTEGER at the head of an SNMP message.
func peekVersion(msg []byte) (g.SnmpVersion, bool) {
	if len(msg) < 2 || msg[0] != berSequence {
		return 0, false
	}
	i := 2
	if msg[1]&berLongForm != 0 {
		i += int(msg[1] &^ berLongForm)
	}
	if i+2 >= len(msg) || msg[i] != berInteger || msg[i+1] != 1 {
		return 0, false
	}
	return g.SnmpVersion(msg[i+2]), true
}

func (a *Agent) handleCommunity(msg []byte, version g.SnmpVersion) []byte {
	if a.cfg.Community == "" || (version == g.Version1 && !a.cfg.V1) || (version == g.Version2c && !a.cfg.V2c) {
		return nil
	}
	dec := &g.GoSNMP{Version: version}
	req, err := dec.SnmpDecodePacket(msg)
	if err != nil {
		return nil
	}
	if subtle.ConstantTimeCompare([]byte(req.Community), []byte(a.cfg.Community)) != 1 {
		a.Stats.BadCommunity.Add(1)
		return nil
	}
	res, ok := a.process(req, version)
	if !ok {
		return nil
	}
	encode := func(vars []g.SnmpPDU, status g.SNMPError, index uint8) ([]byte, error) {
		p := &g.SnmpPacket{Version: version, Community: req.Community, PDUType: g.GetResponse, RequestID: req.RequestID, Error: status, ErrorIndex: index, Variables: vars}
		return p.MarshalMsg()
	}
	return fit(res, req, version, MaxMessageSize, encode)
}

type result struct {
	vars   []g.SnmpPDU
	status g.SNMPError
	index  uint8
	bulk   bool
	// keep is how many leading varbinds a truncated GETBULK must keep (the non-repeaters).
	keep int
}

// fit encodes the response within max octets: a GETBULK response loses trailing repetitions (RFC 3416
// §4.2.3); any other response that does not fit becomes tooBig.
func fit(res result, req *g.SnmpPacket, version g.SnmpVersion, max int, encode func([]g.SnmpPDU, g.SNMPError, uint8) ([]byte, error)) []byte {
	out, err := encode(res.vars, res.status, res.index)
	if err == nil && len(out) <= max {
		return out
	}
	if res.bulk && len(res.vars) > res.keep+1 {
		lo, hi := res.keep+1, len(res.vars)-1
		var best []byte
		for lo <= hi {
			mid := (lo + hi) / 2
			b, err := encode(res.vars[:mid], res.status, res.index)
			if err == nil && len(b) <= max {
				best, lo = b, mid+1
			} else {
				hi = mid - 1
			}
		}
		if best != nil {
			return best
		}
	}
	var echo []g.SnmpPDU
	if version == g.Version1 {
		echo = nullVars(req.Variables)
	}
	out, err = encode(echo, g.TooBig, 0)
	if err != nil {
		return nil
	}
	return out
}

func nullVars(in []g.SnmpPDU) []g.SnmpPDU {
	out := make([]g.SnmpPDU, len(in))
	for i, v := range in {
		out[i] = g.SnmpPDU{Name: v.Name, Type: g.Null}
	}
	return out
}

// process runs a read request against the MIB. ok is false for PDUs an agent ignores.
func (a *Agent) process(req *g.SnmpPacket, version g.SnmpVersion) (result, bool) {
	v1 := version == g.Version1
	var skip func(*entry) bool
	if v1 {
		skip = func(e *entry) bool { return e.typ == g.Counter64 }
	}
	switch req.PDUType {
	case g.GetRequest:
		vars := make([]g.SnmpPDU, 0, len(req.Variables))
		for i, vb := range req.Variables {
			o, err := ParseOID(vb.Name)
			var e *entry
			if err == nil {
				e = a.mib.get(o)
			}
			if e != nil && (skip == nil || !skip(e)) {
				vars = append(vars, e.pdu())
				continue
			}
			if v1 {
				return result{vars: nullVars(req.Variables), status: g.NoSuchName, index: uint8(i + 1)}, true
			}
			typ := g.NoSuchObject
			if err == nil && a.mib.objectExists(o) {
				typ = g.NoSuchInstance
			}
			vars = append(vars, g.SnmpPDU{Name: vb.Name, Type: typ})
		}
		return result{vars: vars}, true
	case g.GetNextRequest:
		vars := make([]g.SnmpPDU, 0, len(req.Variables))
		for i, vb := range req.Variables {
			o, err := ParseOID(vb.Name)
			var e *entry
			if err == nil {
				e = a.mib.next(o, skip)
			}
			if e != nil {
				vars = append(vars, e.pdu())
				continue
			}
			if v1 {
				return result{vars: nullVars(req.Variables), status: g.NoSuchName, index: uint8(i + 1)}, true
			}
			vars = append(vars, g.SnmpPDU{Name: vb.Name, Type: g.EndOfMibView})
		}
		return result{vars: vars}, true
	case g.GetBulkRequest:
		if v1 {
			return result{}, false
		}
		return a.bulk(req), true
	case g.SetRequest:
		// Read-only access: v1 reports noSuchName (RFC 1157 §4.1.5), v2c and v3 noAccess (RFC 3416 §4.2.5).
		if v1 {
			return result{vars: nullVars(req.Variables), status: g.NoSuchName, index: 1}, true
		}
		return result{vars: nullVars(req.Variables), status: g.NoAccess, index: 1}, true
	}
	return result{}, false
}

// bulk implements GETBULK (RFC 3416 §4.2.3).
func (a *Agent) bulk(req *g.SnmpPacket) result {
	n := int(req.NonRepeaters)
	if n > len(req.Variables) {
		n = len(req.Variables)
	}
	reps := int(req.MaxRepetitions)
	vars := make([]g.SnmpPDU, 0, n+reps*(len(req.Variables)-n))
	for _, vb := range req.Variables[:n] {
		vars = append(vars, a.nextPDU(vb.Name))
	}
	cursor := make([]string, 0, len(req.Variables)-n)
	for _, vb := range req.Variables[n:] {
		cursor = append(cursor, vb.Name)
	}
	if len(cursor) == 0 {
		return result{vars: vars, bulk: true, keep: n}
	}
	for r := 0; r < reps; r++ {
		allEnd := true
		for i, name := range cursor {
			p := a.nextPDU(name)
			vars = append(vars, p)
			if p.Type != g.EndOfMibView {
				cursor[i] = p.Name
				allEnd = false
			}
		}
		// Every column has run off the end of the MIB: further repetitions would only repeat endOfMibView.
		if allEnd {
			break
		}
	}
	return result{vars: vars, bulk: true, keep: n}
}

func (a *Agent) nextPDU(name string) g.SnmpPDU {
	o, err := ParseOID(name)
	if err == nil {
		if e := a.mib.next(o, nil); e != nil {
			return e.pdu()
		}
	}
	return g.SnmpPDU{Name: name, Type: g.EndOfMibView}
}

// ---- SNMPv3 USM ----

func (a *Agent) handleUSM(msg []byte) []byte {
	req, decErr := a.dec.SnmpDecodePacket(append([]byte(nil), msg...))
	if req == nil {
		return nil
	}
	usp, ok := req.SecurityParameters.(*g.UsmSecurityParameters)
	if !ok || usp == nil {
		return nil
	}
	reportable := req.MsgFlags&g.Reportable != 0
	level := req.MsgFlags & g.AuthPriv
	user := a.cfg.User
	// RFC 3414 §3.2: engine, then user, then security level, then digest, then time window, then privacy.
	if usp.AuthoritativeEngineID != string(a.cfg.EngineID) {
		n := a.Stats.UnknownEngineIDs.Add(1)
		return a.report(req, reportable, oidUnknownEngineIDs, n, g.NoAuthNoPriv)
	}
	if usp.UserName != user.Name {
		n := a.Stats.UnknownUserNames.Add(1)
		return a.report(req, reportable, oidUnknownUserNames, n, g.NoAuthNoPriv)
	}
	if level != user.level() {
		n := a.Stats.UnsupportedSecLevels.Add(1)
		return a.report(req, reportable, oidUnsupportedSecLevels, n, g.NoAuthNoPriv)
	}
	if level&g.AuthNoPriv != 0 && !a.authentic(msg, usp.AuthenticationParameters) {
		n := a.Stats.WrongDigests.Add(1)
		return a.report(req, reportable, oidWrongDigests, n, g.NoAuthNoPriv)
	}
	if level&g.AuthNoPriv != 0 {
		now := int64(a.engineTime())
		if usp.AuthoritativeEngineBoots != a.cfg.EngineBoots || abs(int64(usp.AuthoritativeEngineTime)-now) > timeWindow {
			n := a.Stats.NotInTimeWindows.Add(1)
			return a.report(req, reportable, oidNotInTimeWindows, n, g.AuthNoPriv)
		}
	}
	if decErr != nil {
		n := a.Stats.DecryptionErrors.Add(1)
		return a.report(req, reportable, oidDecryptionErrors, n, g.AuthNoPriv&level)
	}
	if (req.ContextEngineID != "" && req.ContextEngineID != string(a.cfg.EngineID)) || req.ContextName != "" {
		return a.report(req, reportable, oidUnknownContexts, 1, level)
	}
	res, ok := a.process(req, g.Version3)
	if !ok {
		return nil
	}
	max := MaxMessageSize
	if req.MsgMaxSize > 0 && int(req.MsgMaxSize) < max {
		max = int(req.MsgMaxSize)
	}
	encode := func(vars []g.SnmpPDU, status g.SNMPError, index uint8) ([]byte, error) {
		return a.marshalV3(req, level, g.GetResponse, vars, status, index)
	}
	return fit(res, req, g.Version3, max, encode)
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

func (a *Agent) report(req *g.SnmpPacket, reportable bool, oid string, count int64, level g.SnmpV3MsgFlags) []byte {
	if !reportable {
		return nil
	}
	vars := []g.SnmpPDU{{Name: oid, Type: g.Counter32, Value: uint32(count)}}
	out, err := a.marshalV3(req, level, g.Report, vars, g.NoError, 0)
	if err != nil {
		return nil
	}
	return out
}

func (a *Agent) marshalV3(req *g.SnmpPacket, level g.SnmpV3MsgFlags, pduType g.PDUType, vars []g.SnmpPDU, status g.SNMPError, index uint8) ([]byte, error) {
	usp := &g.UsmSecurityParameters{
		AuthoritativeEngineID: string(a.cfg.EngineID), AuthoritativeEngineBoots: a.cfg.EngineBoots, AuthoritativeEngineTime: a.engineTime(),
	}
	if reqUsp, ok := req.SecurityParameters.(*g.UsmSecurityParameters); ok {
		usp.UserName = reqUsp.UserName
	}
	if level&g.AuthNoPriv != 0 {
		usp.AuthenticationProtocol = a.cfg.User.Auth
		usp.SecretKey = a.secretKey
	}
	if level&g.AuthPriv == g.AuthPriv {
		usp.PrivacyProtocol = a.cfg.User.Priv
		usp.PrivacyKey = a.privKey
		salt, err := a.salt()
		if err != nil {
			return nil, err
		}
		usp.PrivacyParameters = salt
	}
	p := &g.SnmpPacket{
		Version: g.Version3, MsgFlags: level, SecurityModel: g.UserSecurityModel, SecurityParameters: usp,
		MsgID: req.MsgID, MsgMaxSize: MaxMessageSize, ContextEngineID: string(a.cfg.EngineID), ContextName: req.ContextName,
		PDUType: pduType, RequestID: req.RequestID, Error: status, ErrorIndex: index, Variables: vars,
	}
	return p.MarshalMsg()
}

// salt is msgPrivacyParameters: 64 random bits for AES (RFC 3826 §3.1.2.1); engine boots and a counter
// for DES (RFC 3414 §8.1.1.1).
func (a *Agent) salt() ([]byte, error) {
	if a.cfg.User.Priv == g.DES {
		s := make([]byte, aesSaltLen)
		binary.BigEndian.PutUint32(s, a.cfg.EngineBoots)
		binary.BigEndian.PutUint32(s[desSaltLen:], a.desCounter.Add(1))
		return s, nil
	}
	s := make([]byte, aesSaltLen)
	if _, err := rand.Read(s); err != nil {
		return nil, err
	}
	return s, nil
}

// macLen is the truncated HMAC length per protocol (RFC 3414 §6-7: 96 bits; RFC 7860 §4.2.2).
var macLen = map[g.SnmpV3AuthProtocol]int{g.MD5: 12, g.SHA: 12, g.SHA224: 16, g.SHA256: 24, g.SHA384: 32, g.SHA512: 48}

func hashFor(p g.SnmpV3AuthProtocol) func() hash.Hash {
	switch p {
	case g.MD5:
		return md5.New
	case g.SHA:
		return sha1.New
	case g.SHA224:
		return sha256.New224
	case g.SHA256:
		return sha256.New
	case g.SHA384:
		return sha512.New384
	case g.SHA512:
		return sha512.New
	}
	return nil
}

var errNoDigest = errors.New("no msgAuthenticationParameters")

// authentic verifies msgAuthenticationParameters: the HMAC over the whole message with the parameter
// field zeroed, keyed with the user's key localized to this engine.
func (a *Agent) authentic(msg []byte, params string) bool {
	digest, err := a.digest(msg, []byte(params))
	return err == nil && subtle.ConstantTimeCompare(digest, []byte(params)) == 1
}

func (a *Agent) digest(msg, params []byte) ([]byte, error) {
	want := macLen[a.cfg.User.Auth]
	newHash := hashFor(a.cfg.User.Auth)
	if newHash == nil || len(params) != want {
		return nil, errNoDigest
	}
	field := append([]byte{byte(g.OctetString), byte(want)}, params...)
	at := bytes.Index(msg, field)
	if at < 0 {
		return nil, errNoDigest
	}
	zeroed := append([]byte(nil), msg...)
	for i := at + 2; i < at+2+want; i++ {
		zeroed[i] = 0
	}
	mac := hmac.New(newHash, a.secretKey)
	mac.Write(zeroed)
	return mac.Sum(nil)[:want], nil
}
