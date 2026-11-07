// REQ-QA-005 REQ-DISC-023 — a simulated Active Directory domain controller (LDAP v3 over LDAPS and over StartTLS
// with LDAP signing enforced) for the real ldap collector. Computer objects are the estate's Windows hosts and
// Windows VMs; service accounts are derived from the estate (an MSSQLSvc SPN account per SQL Server listener, an
// HTTP SPN account per IIS listener, one account per application in OU=Service Accounts without SPN). The estate
// has no user_account CIs, so people come from a seeded, deterministic set of 1200 users (names drawn by index
// from fixed lists, timestamps hashed from the sAMAccountName); with the built-in Administrator, Guest and krbtgt
// accounts. 1200 users and 1000+ computers exceed the collector's 999-entry page, so paging runs for real.
package directory

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/protocols/ldapd"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	typeUser    = "user_account"
	typeService = "service_account"
	typeHost    = "host"
	seededUsers = 1200
	serviceOU   = "OU=Service Accounts"
	// userAccountControl values (MS-ADTS 2.2.16).
	uacNormal          = 512
	uacDisabled        = 514
	uacNormalNoExpire  = 66048
	uacGuest           = 66082
	uacWorkstation     = 4096
	disabledEvery      = 17
	neverExpireEvery   = 23
	globalSecurityType = "-2147483646"
	// FILETIME is 100 ns ticks since 1601-01-01.
	filetimeEpochSeconds = 11644473600
	filetimeTicks        = 10000000
	dayTicks             = 24 * 3600 * filetimeTicks
	pwdAgeDays           = 180
	logonAgeDays         = 14
	createdSpanDays      = 1500
	groupsPerUser        = 3
	ridBase              = 1100
	ridAdministrator     = 500
	ridGuest             = 501
	ridKrbtgt            = 502
	ridDomainUsers       = "513"
	ridDomainComputers   = "515"
	computerRIDSpan      = 1 << 24
	sidRevision          = 1
	sidSubAuthorities    = 5
	sidNTAuthority       = 5
	sidDomainPrefix      = 21
	guidLen              = 16
	generalizedTime      = "20060102150405.0Z"
	sqlPort              = "1433"
	domainFunctionality  = "7" // Windows Server 2016 functional level
	// maxPageSize is the default MaxPageSize of the AD LDAP policy.
	maxPageSize = 1000
)

// reference is the estate's observation instant; seeded timestamps are relative to it so runs are reproducible.
var reference = time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)

var firstNames = []string{"Abdullah", "Aisha", "Ahmed", "Amal", "Ali", "Dana", "Faisal", "Fatimah", "Hassan", "Hind",
	"Ibrahim", "Joud", "Khalid", "Lama", "Majed", "Maha", "Mohammed", "Nora", "Nasser", "Noura",
	"Omar", "Rana", "Saad", "Reem", "Salman", "Sara", "Sultan", "Shahad", "Turki", "Wafa",
	"Yousef", "Lina", "Ziyad", "Hessa", "Bandar", "Arwa", "Fahad", "Ghada", "Waleed", "Huda"}

var lastNames = []string{"Al-Qahtani", "Al-Otaibi", "Al-Ghamdi", "Al-Zahrani", "Al-Dossari", "Al-Harbi", "Al-Shehri", "Al-Mutairi",
	"Al-Anazi", "Al-Shammari", "Al-Subaie", "Al-Malki", "Al-Rashidi", "Al-Juhani", "Al-Omari", "Al-Hamdan",
	"Al-Saud", "Al-Faisal", "Al-Sulaiman", "Al-Amri", "Al-Bishi", "Al-Asmari", "Al-Yami", "Al-Khaldi",
	"Al-Tamimi", "Al-Huwaish", "Al-Ruwaili", "Al-Shamrani", "Al-Mansour", "Al-Hajri", "Al-Marri", "Al-Kathiri",
	"Al-Sahli", "Al-Balawi", "Al-Shahrani", "Al-Qarni", "Al-Saleh", "Al-Mubarak", "Al-Najjar", "Al-Fahad"}

var departments = []string{"Retail Banking", "Corporate Banking", "Treasury", "Risk", "Compliance", "Finance", "Human Resources",
	"Group Technology", "Operations", "Internal Audit", "Legal", "Digital Channels"}

var titles = []string{"Analyst", "Senior Analyst", "Officer", "Manager", "Senior Manager", "Engineer", "Specialist", "Head of Unit"}

type Vendor struct{}

func (Vendor) ID() string             { return "active-directory" }
func (Vendor) Collector() string      { return "ldap" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-023"} }

func hash(s string) uint64 {
	sum := sha256.Sum256([]byte(s))
	return binary.BigEndian.Uint64(sum[:8])
}

func filetime(t time.Time) string {
	return strconv.FormatInt((t.Unix()+filetimeEpochSeconds)*filetimeTicks, 10)
}

func ago(key string, days int) time.Time {
	return reference.Add(-time.Duration(hash(key)%uint64(days*dayTicks/filetimeTicks)) * time.Second)
}

func sid(domain string, rid uint32) string {
	b := []byte{sidRevision, sidSubAuthorities, 0, 0, 0, 0, 0, sidNTAuthority}
	h := sha256.Sum256([]byte(domain))
	subs := []uint32{sidDomainPrefix, binary.LittleEndian.Uint32(h[0:4]), binary.LittleEndian.Uint32(h[4:8]), binary.LittleEndian.Uint32(h[8:12]), rid}
	for _, s := range subs {
		b = binary.LittleEndian.AppendUint32(b, s)
	}
	return string(b)
}

func guid(dn string) string {
	sum := sha256.Sum256([]byte(dn))
	return string(sum[:guidLen])
}

// domain is the estate's DNS domain (the forward zone, else the suffix of a host FQDN).
func domain(e *estate.Estate) string {
	for _, z := range e.OfType("dns_zone", nil) {
		if n := strings.ToLower(z.Name); !strings.HasSuffix(n, ".arpa") {
			return n
		}
	}
	for _, h := range e.OfType(typeHost, nil) {
		if _, d, ok := strings.Cut(h.ID("fqdn"), "."); ok {
			return strings.ToLower(d)
		}
	}
	return ""
}

func baseDN(dom string) string {
	parts := strings.Split(dom, ".")
	for i, p := range parts {
		parts[i] = "DC=" + p
	}
	return strings.Join(parts, ",")
}

// osVersions maps a Windows Server release to the operatingSystemVersion AD records for it.
var osVersions = map[string]string{"2025": "10.0 (26100)", "2022": "10.0 (20348)", "2019": "10.0 (17763)", "2016": "10.0 (14393)", "2012 R2": "6.3 (9600)"}

type computer struct {
	fqdn, os, created string
	ci                *estate.CI
	vm                bool
}

func computers(e *estate.Estate) []computer {
	var out []computer
	for _, h := range e.OfType(typeHost, func(c *estate.CI) bool { return strings.Contains(c.Str("osName"), "Windows") }) {
		out = append(out, computer{fqdn: strings.ToLower(h.ID("fqdn")), os: h.Str("osName") + " " + h.Str("osVersion"), created: h.Str("purchaseDate"), ci: h})
	}
	for _, v := range e.OfType("vm", func(c *estate.CI) bool { return c.Str("guestOsFamily") == "windows" }) {
		out = append(out, computer{fqdn: strings.ToLower(v.ID("fqdn")), os: v.Str("guestOs"), created: v.Str("createdAt"), ci: v, vm: true})
	}
	return out
}

type account struct {
	sam, display, ou string
	spns             []string
	uac              int
	rid              uint32
	mail, dept, ttl  string
	groups           []string
}

type model struct {
	domain, base string
	users        []account
	services     []account
	builtin      []account
	computers    []computer
	groups       []string
	bindDN       string
}

func build(e *estate.Estate, env *sim.Env) *model {
	m := &model{domain: domain(e)}
	m.base = baseDN(m.domain)
	if m.domain == "" {
		return m
	}
	m.computers = computers(e)
	for _, a := range e.OfType("application", nil) {
		m.groups = append(m.groups, "APP-"+a.Name+"-Users", "APP-"+a.Name+"-Admins")
	}
	rid := uint32(ridBase)
	nextRID := func() uint32 { rid++; return rid }
	seen := map[string]bool{}
	for i := 0; i < seededUsers; i++ {
		first := firstNames[i%len(firstNames)]
		last := lastNames[(i/len(firstNames)+i%len(firstNames))%len(lastNames)]
		stem := strings.ToLower(first + "." + strings.ReplaceAll(strings.TrimPrefix(last, "Al-"), "-", ""))
		sam := stem
		for n := 2; seen[sam]; n++ {
			sam = stem + strconv.Itoa(n)
		}
		seen[sam] = true
		uac := uacNormal
		switch {
		case i%disabledEvery == disabledEvery-1:
			uac = uacDisabled
		case i%neverExpireEvery == neverExpireEvery-1:
			uac = uacNormalNoExpire
		}
		var groups []string
		if len(m.groups) > 0 {
			for g := 0; g < groupsPerUser; g++ {
				groups = append(groups, m.groups[(hash(sam)+uint64(g*len(m.groups)/groupsPerUser))%uint64(len(m.groups))])
			}
		}
		m.users = append(m.users, account{sam: sam, display: first + " " + last, ou: "OU=Staff,OU=Bank", uac: uac, rid: nextRID(),
			mail: sam + "@" + m.domain, dept: departments[hash(sam+"d")%uint64(len(departments))], ttl: titles[hash(sam+"t")%uint64(len(titles))], groups: groups})
	}
	short := func(host string) string { h, _, _ := strings.Cut(strings.ToLower(host), "."); return h }
	var ls []*estate.CI
	ls = append(ls, e.OfType("listening_service", nil)...)
	sort.SliceStable(ls, func(i, j int) bool { return ls[i].Name < ls[j].Name })
	for _, l := range ls {
		host := short(l.Str("host"))
		if seen["svc:"+l.Str("process")+host] {
			continue
		}
		seen["svc:"+l.Str("process")+host] = true
		fqdn := host + "." + m.domain
		switch l.Str("process") {
		case "sqlservr":
			m.services = append(m.services, account{sam: "svc-sql-" + host, ou: serviceOU, uac: uacNormalNoExpire, rid: nextRID(),
				spns: []string{"MSSQLSvc/" + fqdn + ":" + sqlPort, "MSSQLSvc/" + fqdn}})
		case "w3wp":
			m.services = append(m.services, account{sam: "svc-iis-" + host, ou: serviceOU, uac: uacNormalNoExpire, rid: nextRID(),
				spns: []string{"HTTP/" + fqdn, "HTTP/" + host}})
		}
	}
	for _, a := range e.OfType("application", nil) {
		m.services = append(m.services, account{sam: "svc-" + a.Name, display: "", ou: serviceOU, uac: uacNormalNoExpire, rid: nextRID()})
	}
	m.services = append(m.services, account{sam: env.User, ou: serviceOU, uac: uacNormalNoExpire, rid: nextRID()})
	m.bindDN = "CN=" + env.User + "," + serviceOU + "," + m.base
	m.builtin = []account{
		{sam: "Administrator", ou: "CN=Users", uac: uacNormalNoExpire, rid: ridAdministrator, groups: []string{"Domain Admins", "Enterprise Admins"}},
		{sam: "Guest", ou: "CN=Users", uac: uacGuest, rid: ridGuest},
		{sam: "krbtgt", ou: "CN=Users", uac: uacDisabled, rid: ridKrbtgt, spns: []string{"kadmin/changepw"}},
	}
	return m
}

func attr(name string, values ...string) ldapd.Attr { return ldapd.Attr{Name: name, Values: values} }

func (m *model) groupDN(g string) string {
	if g == "Domain Admins" || g == "Enterprise Admins" {
		return "CN=" + g + ",CN=Users," + m.base
	}
	return "CN=" + g + ",OU=Groups,OU=Bank," + m.base
}

func (m *model) category(name string) string {
	return "CN=" + name + ",CN=Schema,CN=Configuration," + m.base
}

func (m *model) userEntry(a account) ldapd.Entry {
	cn := a.sam
	if a.display != "" {
		cn = a.display
	}
	dn := "CN=" + cn + "," + a.ou + "," + m.base
	created := ago(a.sam+"c", createdSpanDays)
	e := ldapd.Entry{DN: dn, Attrs: []ldapd.Attr{
		attr("objectClass", "top", "person", "organizationalPerson", "user"),
		attr("cn", cn),
		attr("sAMAccountName", a.sam),
		attr("userPrincipalName", a.sam+"@"+m.domain),
		attr("userAccountControl", strconv.Itoa(a.uac)),
		attr("objectCategory", m.category("Person")),
		attr("objectSid", sid(m.domain, a.rid)),
		attr("objectGUID", guid(dn)),
		attr("primaryGroupID", ridDomainUsers),
		attr("whenCreated", created.Format(generalizedTime)),
		attr("pwdLastSet", filetime(ago(a.sam+"p", pwdAgeDays))),
		attr("lastLogonTimestamp", filetime(ago(a.sam+"l", logonAgeDays))),
	}}
	if a.display != "" {
		e.Attrs = append(e.Attrs, attr("displayName", a.display), attr("givenName", strings.Fields(a.display)[0]))
	}
	if a.mail != "" {
		e.Attrs = append(e.Attrs, attr("mail", a.mail), attr("department", a.dept), attr("title", a.ttl))
	}
	if len(a.spns) > 0 {
		e.Attrs = append(e.Attrs, attr("servicePrincipalName", a.spns...))
	}
	if len(a.groups) > 0 {
		var dns []string
		for _, g := range a.groups {
			dns = append(dns, m.groupDN(g))
		}
		e.Attrs = append(e.Attrs, attr("memberOf", dns...))
	}
	return e
}

func generalized(date string, fallbackKey string) string {
	for _, layout := range []string{time.RFC3339Nano, time.DateOnly} {
		if t, err := time.Parse(layout, date); err == nil {
			return t.UTC().Format(generalizedTime)
		}
	}
	return ago(fallbackKey, createdSpanDays).Format(generalizedTime)
}

func (m *model) computerEntry(c computer) ldapd.Entry {
	host, _, _ := strings.Cut(c.fqdn, ".")
	name := strings.ToUpper(host)
	ou := "OU=Servers,OU=Bank"
	if c.vm {
		ou = "OU=Virtual Servers,OU=Bank"
	}
	dn := "CN=" + name + "," + ou + "," + m.base
	version := ""
	for release, v := range osVersions {
		if strings.HasSuffix(c.os, release) {
			version = v
		}
	}
	return ldapd.Entry{DN: dn, Attrs: []ldapd.Attr{
		attr("objectClass", "top", "person", "organizationalPerson", "user", "computer"),
		attr("cn", name),
		attr("sAMAccountName", name+"$"),
		attr("dNSHostName", c.fqdn),
		attr("operatingSystem", c.os+" Datacenter"),
		attr("operatingSystemVersion", version),
		attr("userAccountControl", strconv.Itoa(uacWorkstation)),
		attr("objectCategory", m.category("Computer")),
		attr("objectSid", sid(m.domain, uint32(ridBase+hash(c.fqdn)%computerRIDSpan))),
		attr("objectGUID", guid(dn)),
		attr("primaryGroupID", ridDomainComputers),
		attr("whenCreated", generalized(c.created, c.fqdn)),
		attr("lastLogonTimestamp", filetime(ago(c.fqdn+"l", logonAgeDays))),
		attr("servicePrincipalName", "HOST/"+c.fqdn, "HOST/"+name, "RestrictedKrbHost/"+c.fqdn, "RestrictedKrbHost/"+name),
	}}
}

func (m *model) directory(env *sim.Env) *ldapd.Directory {
	b := m.base
	container := func(dn string, class ...string) ldapd.Entry {
		rdn, _, _ := strings.Cut(dn, ",")
		_, v, _ := strings.Cut(rdn, "=")
		return ldapd.Entry{DN: dn + "," + b, Attrs: []ldapd.Attr{attr("objectClass", append([]string{"top"}, class...)...), attr("name", v)}}
	}
	d := &ldapd.Directory{MaxPageSize: maxPageSize, TLS: env.CA.ServerConfig(), RequireTLSBind: true}
	d.RootDSE = ldapd.Entry{DN: "", Attrs: []ldapd.Attr{
		attr("defaultNamingContext", b),
		attr("rootDomainNamingContext", b),
		attr("namingContexts", b, "CN=Configuration,"+b, "CN=Schema,CN=Configuration,"+b, "DC=DomainDnsZones,"+b, "DC=ForestDnsZones,"+b),
		attr("configurationNamingContext", "CN=Configuration,"+b),
		attr("schemaNamingContext", "CN=Schema,CN=Configuration,"+b),
		attr("dnsHostName", "dc01."+m.domain),
		attr("supportedLDAPVersion", "3", "2"),
		attr("supportedControl", ldapd.OIDPagedResults),
		attr("supportedExtension", ldapd.OIDStartTLS),
		attr("supportedSASLMechanisms", "GSSAPI", "GSS-SPNEGO", "EXTERNAL", "DIGEST-MD5"),
		attr("domainFunctionality", domainFunctionality),
		attr("forestFunctionality", domainFunctionality),
		attr("domainControllerFunctionality", domainFunctionality),
		attr("isGlobalCatalogReady", "TRUE"),
	}}
	head := ldapd.Entry{DN: b, Attrs: []ldapd.Attr{attr("objectClass", "top", "domain", "domainDNS"), attr("name", strings.Split(m.domain, ".")[0])}}
	d.Entries = append(d.Entries, head,
		container("CN=Users", "container"), container("OU=Bank", "organizationalUnit"), container("OU=Staff,OU=Bank", "organizationalUnit"),
		container("OU=Groups,OU=Bank", "organizationalUnit"), container("OU=Servers,OU=Bank", "organizationalUnit"),
		container("OU=Virtual Servers,OU=Bank", "organizationalUnit"), container(serviceOU, "organizationalUnit"))
	members := map[string][]string{}
	all := append(append(append([]account{}, m.builtin...), m.users...), m.services...)
	for _, a := range all {
		e := m.userEntry(a)
		for _, g := range a.groups {
			members[g] = append(members[g], e.DN)
		}
		d.Entries = append(d.Entries, e)
	}
	for _, g := range append([]string{"Domain Admins", "Enterprise Admins"}, m.groups...) {
		dn := m.groupDN(g)
		e := ldapd.Entry{DN: dn, Attrs: []ldapd.Attr{attr("objectClass", "top", "group"), attr("cn", g), attr("sAMAccountName", g),
			attr("groupType", globalSecurityType), attr("objectCategory", m.category("Group")), attr("objectGUID", guid(dn))}}
		if len(members[g]) > 0 {
			e.Attrs = append(e.Attrs, attr("member", members[g]...))
		}
		d.Entries = append(d.Entries, e)
	}
	for _, c := range m.computers {
		d.Entries = append(d.Entries, m.computerEntry(c))
	}
	netbios := strings.ToUpper(strings.Split(m.domain, ".")[0])
	d.Bind = func(name, password string) bool {
		if password != env.Secret {
			return false
		}
		n := strings.ToLower(name)
		return n == strings.ToLower(m.bindDN) || n == strings.ToLower(env.User+"@"+m.domain) || n == strings.ToLower(netbios+`\`+env.User)
	}
	return d
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	m := build(e, env)
	ep := &sim.Endpoint{Host: sim.AdvertiseHost(), State: map[string]any{}}
	if m.domain == "" {
		return ep, nil
	}
	dir := m.directory(env)
	for _, mode := range []string{"ldaps", "ldap"} {
		ln, port, err := sim.Listen()
		if err != nil {
			_ = ep.Close()
			return nil, err
		}
		srv := ldapd.Serve(ln, dir, mode == "ldaps")
		ep.OnClose(srv.Close)
		ep.State["port:"+mode] = port
	}
	return ep, nil
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	m := build(e, env)
	if m.domain == "" {
		return nil
	}
	expect := func(run *sim.Run) {
		for _, a := range m.users {
			run.Expect.CI(typeUser, a.display)
		}
		for _, a := range m.services {
			run.Expect.CI(typeService, a.sam)
		}
		run.Expect.CI(typeUser, "Administrator")
		run.Expect.CI(typeUser, "Guest")
		run.Expect.CI(typeService, "krbtgt") // carries an SPN (kadmin/changepw)
		for _, c := range m.computers {
			if c.vm {
				// The collector types every computer object as host; the estate types these as vm (see report).
				run.Expect.CI(typeHost, c.fqdn)
				continue
			}
			run.Expect.CIs = append(run.Expect.CIs, sim.ExpectCI{Type: typeHost, Name: c.fqdn, Identity: c.ci.Identity})
		}
	}
	ldaps := sim.Run{
		Name:           "ldaps-rootdse",
		Targets:        []sim.Target{{Kind: "host", Value: ep.Host, Label: "dc01." + m.domain}},
		Options:        map[string]any{"tls": true, "port": ep.State["port:ldaps"], "verifyTls": true, "caCertPem": env.CA.PEM, "serviceAccountOu": serviceOU},
		CredentialType: "password",
		Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": env.User + "@" + m.domain, "password": env.Secret}},
	}
	expect(&ldaps)
	starttls := sim.Run{
		Name:           "starttls-basedn",
		Targets:        []sim.Target{{Kind: "host", Value: ep.Host, Label: "dc01." + m.domain}},
		Options:        map[string]any{"startTls": true, "port": ep.State["port:ldap"], "verifyTls": true, "caCertPem": env.CA.PEM, "baseDn": m.base, "serviceAccountOu": serviceOU},
		CredentialType: "password",
		Credential:     &sim.Credential{Type: "password", Fields: map[string]string{"username": m.bindDN, "password": env.Secret}},
	}
	expect(&starttls)
	return []sim.Run{ldaps, starttls}
}
