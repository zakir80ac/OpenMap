// REQ-QA-005 REQ-DISC-023 — an LDAP v3 server for simulated mode (RFC 4511 over github.com/go-asn1-ber/asn1-ber):
// simple bind, base / one-level / subtree search with the full filter grammar, attribute selection, the simple
// paged results control (RFC 2696, OID 1.2.840.113556.1.4.319), StartTLS (RFC 4513) and implicit TLS (LDAPS).
// Active Directory behaviour is reproduced where a client can observe it: MaxPageSize caps every page (default
// policy 1000), an unpaged search past MaxPageSize ends in sizeLimitExceeded, objectCategory=<name> matches the
// category's schema DN, searches before a bind fail with operationsError 000004DC, and when RequireTLSBind is set a
// simple bind over clear text is refused with strongerAuthRequired (LDAP signing / channel binding policy).
package ldapd

import (
	"crypto/tls"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"

	ber "github.com/go-asn1-ber/asn1-ber"
)

// Application tags of RFC 4511 protocol operations.
const (
	opBindRequest     = 0
	opBindResponse    = 1
	opUnbindRequest   = 2
	opSearchRequest   = 3
	opSearchEntry     = 4
	opSearchDone      = 5
	opAbandonRequest  = 16
	opExtendedRequest = 23
	opExtendedResp    = 24

	// Result codes.
	ResultSuccess              = 0
	ResultOperationsError      = 1
	ResultProtocolError        = 2
	ResultSizeLimitExceeded    = 4
	ResultStrongerAuthRequired = 8
	ResultNoSuchObject         = 32
	ResultInvalidCredentials   = 49
	ResultUnwillingToPerform   = 53

	scopeBase = 0
	scopeOne  = 1

	filterAnd       = 0
	filterOr        = 1
	filterNot       = 2
	filterEquality  = 3
	filterSubstring = 4
	filterGreater   = 5
	filterLess      = 6
	filterPresent   = 7
	filterApprox    = 8
	subInitial      = 0
	subAny          = 1
	subFinal        = 2

	tagControls      = 0
	tagExtName       = 0
	tagExtRespName   = 10
	tagSimpleAuth    = 0
	OIDPagedResults  = "1.2.840.113556.1.4.319"
	OIDStartTLS      = "1.3.6.1.4.1.1466.20037"
	noAttributes     = "1.1"
	allUserAttrs     = "*"
	defaultMaxPage   = 1000
	categoryRDNField = "CN"

	diagNoBind        = "000004DC: LdapErr: DSID-0C090A5C, comment: In order to perform this operation a successful bind must be completed on the connection., data 0, v4563"
	diagBadCreds      = "80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 52e, v4563"
	diagNeedTLS       = "00002028: LdapErr: DSID-0C090259, comment: The server requires binds to turn on integrity checking if SSL\\TLS are not already active on the connection, data 0, v4563"
	diagSizeLimit     = "00002024: SvcErr: DSID-02080490, problem 5008 (ADMIN_LIMIT_EXCEEDED), data -1026"
	diagNoSuchObject  = "0000208D: NameErr: DSID-0310028C, problem 2001 (NO_OBJECT), data 0, best match of:"
	diagTLSActive     = "00000000: LdapErr: DSID-0C091138, comment: TLS or SSL already in effect, data 0, v4563"
	diagUnknownExtOp  = "00000057: LdapErr: DSID-0C090FB4, comment: Error in attribute conversion operation, data 0, v4563"
	diagBadPageCookie = "00000057: LdapErr: DSID-0C090809, comment: Error processing control, data 0, v4563"
)

// Attr is one attribute with its canonical name (as the directory returns it) and values.
type Attr struct {
	Name   string
	Values []string
}

// Entry is one directory object.
type Entry struct {
	DN    string
	Attrs []Attr
}

func (e *Entry) values(name string) ([]string, bool) {
	for _, a := range e.Attrs {
		if strings.EqualFold(a.Name, name) {
			return a.Values, true
		}
	}
	return nil, false
}

// Directory is what the server serves.
type Directory struct {
	RootDSE Entry
	Entries []Entry
	// Bind validates a simple bind (name may be a DN, a UPN or DOMAIN\user, as AD accepts).
	Bind func(name, password string) bool
	// MaxPageSize caps a page (and an unpaged result); 0 means the AD default.
	MaxPageSize int
	// TLS is the server configuration for LDAPS and StartTLS.
	TLS *tls.Config
	// RequireTLSBind refuses simple binds on a connection without TLS.
	RequireTLSBind bool
}

// Server is a running listener.
type Server struct {
	ln    net.Listener
	dir   *Directory
	wg    sync.WaitGroup
	mu    sync.Mutex
	conns map[net.Conn]bool
	// Pages counts paged-results pages served (for diagnostics and tests).
	Pages int
}

// Serve accepts LDAP connections on ln; implicitTLS wraps every connection in TLS first (LDAPS).
func Serve(ln net.Listener, dir *Directory, implicitTLS bool) *Server {
	s := &Server{ln: ln, dir: dir, conns: map[net.Conn]bool{}}
	if implicitTLS {
		s.ln = tls.NewListener(ln, dir.TLS)
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			c, err := s.ln.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			s.conns[c] = true
			s.mu.Unlock()
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				s.session(c, implicitTLS)
				s.mu.Lock()
				delete(s.conns, c)
				s.mu.Unlock()
			}()
		}
	}()
	return s
}

// Close stops accepting, closes open sessions and waits for them.
func (s *Server) Close() error {
	err := s.ln.Close()
	s.mu.Lock()
	for c := range s.conns {
		_ = c.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
	return err
}

type session struct {
	conn    net.Conn
	tls     bool
	bound   bool
	cookies map[string]int
	next    int
}

func (s *Server) session(c net.Conn, implicitTLS bool) {
	defer c.Close()
	ss := &session{conn: c, tls: implicitTLS, cookies: map[string]int{}}
	for {
		p, err := ber.ReadPacket(ss.conn)
		if err != nil {
			return
		}
		if len(p.Children) < 2 {
			return
		}
		id, ok := p.Children[0].Value.(int64)
		if !ok {
			return
		}
		op := p.Children[1]
		var controls []*ber.Packet
		if len(p.Children) > 2 && p.Children[2].ClassType == ber.ClassContext && p.Children[2].Tag == tagControls {
			controls = p.Children[2].Children
		}
		switch op.Tag {
		case opBindRequest:
			s.bind(ss, id, op)
		case opUnbindRequest:
			return
		case opSearchRequest:
			s.search(ss, id, op, controls)
		case opAbandonRequest:
		case opExtendedRequest:
			if !s.extended(ss, id, op) {
				return
			}
		default:
			ss.write(id, result(opExtendedResp, ResultProtocolError, "", "unsupported operation"), nil)
		}
	}
}

func (ss *session) write(id int64, op *ber.Packet, controls []*ber.Packet) {
	msg := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "LDAPMessage")
	msg.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, id, "messageID"))
	msg.AppendChild(op)
	if len(controls) > 0 {
		cs := ber.Encode(ber.ClassContext, ber.TypeConstructed, tagControls, nil, "Controls")
		for _, c := range controls {
			cs.AppendChild(c)
		}
		msg.AppendChild(cs)
	}
	_, _ = ss.conn.Write(msg.Bytes())
}

func octets(v string) *ber.Packet {
	return ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, v, "")
}

func result(tag ber.Tag, code int, matched, diag string) *ber.Packet {
	r := ber.Encode(ber.ClassApplication, ber.TypeConstructed, tag, nil, "LDAPResult")
	r.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagEnumerated, int64(code), "resultCode"))
	r.AppendChild(octets(matched))
	r.AppendChild(octets(diag))
	return r
}

func str(p *ber.Packet) string {
	if s, ok := p.Value.(string); ok {
		return s
	}
	return p.Data.String()
}

func (s *Server) bind(ss *session, id int64, op *ber.Packet) {
	if len(op.Children) < 3 {
		ss.write(id, result(opBindResponse, ResultProtocolError, "", "malformed bind"), nil)
		return
	}
	name := str(op.Children[1])
	auth := op.Children[2]
	if auth.ClassType != ber.ClassContext || auth.Tag != tagSimpleAuth {
		ss.write(id, result(opBindResponse, ResultUnwillingToPerform, "", "only simple binds are offered"), nil)
		return
	}
	if s.dir.RequireTLSBind && !ss.tls {
		ss.write(id, result(opBindResponse, ResultStrongerAuthRequired, "", diagNeedTLS), nil)
		return
	}
	if !s.dir.Bind(name, auth.Data.String()) {
		ss.bound = false
		ss.write(id, result(opBindResponse, ResultInvalidCredentials, "", diagBadCreds), nil)
		return
	}
	ss.bound = true
	ss.write(id, result(opBindResponse, ResultSuccess, "", ""), nil)
}

func (s *Server) extended(ss *session, id int64, op *ber.Packet) bool {
	name := ""
	for _, c := range op.Children {
		if c.ClassType == ber.ClassContext && c.Tag == tagExtName {
			name = c.Data.String()
		}
	}
	resp := func(code int, diag string) *ber.Packet {
		r := result(opExtendedResp, code, "", diag)
		r.AppendChild(ber.NewString(ber.ClassContext, ber.TypePrimitive, tagExtRespName, name, "responseName"))
		return r
	}
	if name != OIDStartTLS {
		ss.write(id, resp(ResultProtocolError, diagUnknownExtOp), nil)
		return true
	}
	if ss.tls {
		ss.write(id, resp(ResultOperationsError, diagTLSActive), nil)
		return true
	}
	ss.write(id, resp(ResultSuccess, ""), nil)
	tc := tls.Server(ss.conn, s.dir.TLS)
	if err := tc.Handshake(); err != nil {
		return false
	}
	ss.conn, ss.tls = tc, true
	return true
}

func normDN(dn string) string {
	parts := strings.Split(dn, ",")
	for i, p := range parts {
		k, v, _ := strings.Cut(strings.TrimSpace(p), "=")
		parts[i] = strings.ToLower(strings.TrimSpace(k)) + "=" + strings.ToLower(strings.TrimSpace(v))
	}
	return strings.Join(parts, ",")
}

func inScope(dn, base string, scope int64) bool {
	d, b := normDN(dn), normDN(base)
	switch scope {
	case scopeBase:
		return d == b
	case scopeOne:
		_, parent, ok := strings.Cut(d, ",")
		return ok && parent == b
	default:
		return d == b || strings.HasSuffix(d, ","+b)
	}
}

// categoryMatches lets objectCategory=person match CN=Person,CN=Schema,... as AD does.
func categoryMatches(stored, want string) bool {
	if strings.EqualFold(stored, want) {
		return true
	}
	if strings.Contains(want, "=") {
		return normDN(stored) == normDN(want)
	}
	first, _, _ := strings.Cut(stored, ",")
	k, v, ok := strings.Cut(first, "=")
	return ok && strings.EqualFold(strings.TrimSpace(k), categoryRDNField) && strings.EqualFold(strings.TrimSpace(v), want)
}

func compare(stored, want string, cmp int) bool {
	a, aerr := strconv.ParseInt(stored, 10, 64)
	b, berr := strconv.ParseInt(want, 10, 64)
	if aerr == nil && berr == nil {
		switch cmp {
		case filterGreater:
			return a >= b
		case filterLess:
			return a <= b
		}
		return a == b
	}
	x, y := strings.ToLower(stored), strings.ToLower(want)
	switch cmp {
	case filterGreater:
		return x >= y
	case filterLess:
		return x <= y
	}
	return x == y
}

func substrings(v string, parts []*ber.Packet) bool {
	v = strings.ToLower(v)
	for _, p := range parts {
		s := strings.ToLower(p.Data.String())
		switch p.Tag {
		case subInitial:
			if !strings.HasPrefix(v, s) {
				return false
			}
			v = v[len(s):]
		case subAny:
			i := strings.Index(v, s)
			if i < 0 {
				return false
			}
			v = v[i+len(s):]
		case subFinal:
			if !strings.HasSuffix(v, s) {
				return false
			}
		}
	}
	return true
}

func match(e *Entry, f *ber.Packet) bool {
	if f.ClassType != ber.ClassContext {
		return false
	}
	switch f.Tag {
	case filterAnd:
		for _, c := range f.Children {
			if !match(e, c) {
				return false
			}
		}
		return true
	case filterOr:
		for _, c := range f.Children {
			if match(e, c) {
				return true
			}
		}
		return false
	case filterNot:
		return len(f.Children) == 1 && !match(e, f.Children[0])
	case filterPresent:
		name := f.Data.String()
		if strings.EqualFold(name, "objectClass") {
			return true
		}
		vals, ok := e.values(name)
		return ok && len(vals) > 0
	case filterEquality, filterApprox, filterGreater, filterLess:
		if len(f.Children) != 2 {
			return false
		}
		name, want := str(f.Children[0]), str(f.Children[1])
		vals, _ := e.values(name)
		for _, v := range vals {
			if strings.EqualFold(name, "objectCategory") && f.Tag == filterEquality && categoryMatches(v, want) {
				return true
			}
			cmp := int(f.Tag)
			if f.Tag == filterApprox {
				cmp = filterEquality
			}
			if compare(v, want, cmp) {
				return true
			}
		}
		return false
	case filterSubstring:
		if len(f.Children) != 2 {
			return false
		}
		vals, _ := e.values(str(f.Children[0]))
		for _, v := range vals {
			if substrings(v, f.Children[1].Children) {
				return true
			}
		}
		return false
	}
	return false
}

func entryPacket(e *Entry, attrs []string) *ber.Packet {
	all := len(attrs) == 0
	wanted := map[string]bool{}
	for _, a := range attrs {
		if a == allUserAttrs {
			all = true
		}
		wanted[strings.ToLower(a)] = true
	}
	if len(attrs) == 1 && attrs[0] == noAttributes {
		all, wanted = false, map[string]bool{}
	}
	r := ber.Encode(ber.ClassApplication, ber.TypeConstructed, opSearchEntry, nil, "SearchResultEntry")
	r.AppendChild(octets(e.DN))
	list := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "attributes")
	for _, a := range e.Attrs {
		if !all && !wanted[strings.ToLower(a.Name)] {
			continue
		}
		pa := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "PartialAttribute")
		pa.AppendChild(octets(a.Name))
		set := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSet, nil, "vals")
		for _, v := range a.Values {
			set.AppendChild(octets(v))
		}
		pa.AppendChild(set)
		list.AppendChild(pa)
	}
	r.AppendChild(list)
	return r
}

func pagingControl(cookie string) *ber.Packet {
	c := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "Control")
	c.AppendChild(octets(OIDPagedResults))
	value := ber.Encode(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, nil, "controlValue")
	seq := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "realSearchControlValue")
	seq.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, int64(0), "size estimate"))
	seq.AppendChild(octets(cookie))
	value.AppendChild(seq)
	c.AppendChild(value)
	return c
}

type paging struct {
	size   int
	cookie string
}

func findPaging(controls []*ber.Packet) (*paging, error) {
	for _, c := range controls {
		if len(c.Children) < 1 || str(c.Children[0]) != OIDPagedResults {
			continue
		}
		v := c.Children[len(c.Children)-1]
		inner, err := ber.DecodePacketErr(v.Data.Bytes())
		if err != nil || len(inner.Children) != 2 {
			return nil, errors.New("malformed paged results control")
		}
		size, _ := inner.Children[0].Value.(int64)
		return &paging{size: int(size), cookie: inner.Children[1].Data.String()}, nil
	}
	return nil, nil
}

func (s *Server) search(ss *session, id int64, op *ber.Packet, controls []*ber.Packet) {
	done := func(code int, diag string, ctl []*ber.Packet) {
		ss.write(id, result(opSearchDone, code, "", diag), ctl)
	}
	if len(op.Children) < 8 {
		done(ResultProtocolError, "malformed search", nil)
		return
	}
	base := str(op.Children[0])
	scope, _ := op.Children[1].Value.(int64)
	filter := op.Children[6]
	var attrs []string
	for _, a := range op.Children[7].Children {
		attrs = append(attrs, str(a))
	}
	if base == "" && scope == scopeBase {
		if match(&s.dir.RootDSE, filter) {
			ss.write(id, entryPacket(&s.dir.RootDSE, attrs), nil)
		}
		done(ResultSuccess, "", nil)
		return
	}
	if !ss.bound {
		done(ResultOperationsError, diagNoBind, nil)
		return
	}
	baseFound := false
	var hits []*Entry
	for i := range s.dir.Entries {
		e := &s.dir.Entries[i]
		if normDN(e.DN) == normDN(base) {
			baseFound = true
		}
		if inScope(e.DN, base, scope) && match(e, filter) {
			hits = append(hits, e)
		}
	}
	if !baseFound {
		done(ResultNoSuchObject, diagNoSuchObject, nil)
		return
	}
	maxPage := s.dir.MaxPageSize
	if maxPage <= 0 {
		maxPage = defaultMaxPage
	}
	pg, err := findPaging(controls)
	if err != nil {
		done(ResultProtocolError, diagBadPageCookie, nil)
		return
	}
	if pg == nil {
		for i, e := range hits {
			if i == maxPage {
				done(ResultSizeLimitExceeded, diagSizeLimit, nil)
				return
			}
			ss.write(id, entryPacket(e, attrs), nil)
		}
		done(ResultSuccess, "", nil)
		return
	}
	offset := 0
	if pg.cookie != "" {
		o, ok := ss.cookies[pg.cookie]
		if !ok {
			done(ResultUnwillingToPerform, diagBadPageCookie, nil)
			return
		}
		delete(ss.cookies, pg.cookie)
		offset = o
	}
	if pg.size == 0 { // the client abandons the paged search
		done(ResultSuccess, "", []*ber.Packet{pagingControl("")})
		return
	}
	end := min(offset+min(pg.size, maxPage), len(hits))
	for _, e := range hits[offset:end] {
		ss.write(id, entryPacket(e, attrs), nil)
	}
	s.mu.Lock()
	s.Pages++
	s.mu.Unlock()
	next := ""
	if end < len(hits) {
		ss.next++
		next = "page-" + strconv.Itoa(ss.next) + "-" + strconv.Itoa(end)
		ss.cookies[next] = end
	}
	done(ResultSuccess, "", []*ber.Packet{pagingControl(next)})
}
