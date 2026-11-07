// REQ-DISC-023 — Active Directory / LDAP collector: binds with a read-only account, pages through
// users, computers and groups under the configured base, and emits user_account and service_account
// CIs (service accounts by servicePrincipalName or an explicit OU filter), computer objects as
// hosts with their OS and last logon, and group membership as attributes.
package directory

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/go-ldap/ldap/v3"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	collectorID     = "ldap"
	version         = "0.1.0"
	evidenceKind    = "api_response"
	defaultPort     = 389
	defaultPortTLS  = 636
	pageSize        = 999
	optionBaseDN    = "baseDn"
	optionPort      = "port"
	optionTLS       = "tls"
	optionStartTLS  = "startTls"
	optionVerify    = "verifyTls"
	optionCAPem     = "caCertPem"        // PEM bundle of the enterprise CA that issued the domain controllers' certificates
	optionServiceOU = "serviceAccountOu" // substring matched against the DN, e.g. "OU=Service Accounts"
	optionComputers = "includeComputers"
	credUser        = "username"
	credPassword    = "password"
	dialTimeout     = 15 * time.Second

	// userAccountControl bits (MS-ADTS).
	uacDisabled      = 0x0002
	uacDontExpirePwd = 0x10000
	uacSmartcardReq  = 0x40000
	// Windows FILETIME epoch offset in 100 ns units relative to Unix.
	filetimeEpochDiff = 116444736000000000
	filetimeUnitsPerS = 10000000

	typeUser    = "user_account"
	typeService = "service_account"
	typeHost    = "host"
	relMemberOf = "member_of"
)

var userAttributes = []string{"sAMAccountName", "userPrincipalName", "displayName", "mail", "userAccountControl", "memberOf", "lastLogonTimestamp", "pwdLastSet", "whenCreated", "servicePrincipalName", "department", "title", "manager", "description", "objectClass", "uid", "cn"}
var computerAttributes = []string{"dNSHostName", "sAMAccountName", "operatingSystem", "operatingSystemVersion", "lastLogonTimestamp", "userAccountControl", "whenCreated", "description", "servicePrincipalName"}

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "ldap", Version: version, Language: "go",
		Protocols: []string{"ldap", "ldaps"}, CredentialTypes: []string{"password"},
		TargetKinds: []string{"host"}, Emits: []string{typeUser, typeService, typeHost},
		ContractVersion: contract.Version,
	}
}

// Entry is one directory object flattened to single-valued strings plus multi-valued lists.
type Entry struct {
	DN     string
	Attrs  map[string]string
	Multi  map[string][]string
	Object string // user | computer | group
}

// Inventory is what Search gathered.
type Inventory struct {
	BaseDN    string
	Users     []Entry
	Computers []Entry
	Groups    []Entry
	Raw       []byte
}

func toEntry(e *ldap.Entry, object string) Entry {
	out := Entry{DN: e.DN, Attrs: map[string]string{}, Multi: map[string][]string{}, Object: object}
	for _, a := range e.Attributes {
		if len(a.Values) == 1 {
			out.Attrs[a.Name] = a.Values[0]
		}
		out.Multi[a.Name] = a.Values
	}
	return out
}

func pagedSearch(conn *ldap.Conn, baseDN, filter string, attrs []string, object string) ([]Entry, error) {
	req := ldap.NewSearchRequest(baseDN, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 0, false, filter, attrs, nil)
	res, err := conn.SearchWithPaging(req, pageSize)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(res.Entries))
	for _, e := range res.Entries {
		out = append(out, toEntry(e, object))
	}
	return out, nil
}

// TLSConfig is the LDAPS / StartTLS client configuration: verify checks the chain against the system roots, or
// against caPem (the enterprise CA bundle) when one is given, which also turns verification on.
func TLSConfig(host string, verify bool, caPem string) (*tls.Config, error) {
	cfg := &tls.Config{InsecureSkipVerify: !verify, ServerName: host, MinVersion: tls.VersionTLS12} //nolint:gosec // domain controllers commonly present enterprise-CA certificates; verifyTls=true or caCertPem enforce them.
	if caPem != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(caPem)) {
			return nil, collector.Errorf(contract.ErrInternal, false, "caCertPem option holds no PEM certificate")
		}
		cfg.RootCAs = pool
		cfg.InsecureSkipVerify = false
	}
	return cfg, nil
}

// Search binds and reads users, computers and groups.
func Search(ctx context.Context, host string, port int, useTLS, startTLS bool, tlsCfg *tls.Config, user, password, baseDN string, includeComputers bool) (*Inventory, error) {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	dialer := &net.Dialer{Timeout: dialTimeout}
	var conn *ldap.Conn
	var err error
	if useTLS {
		conn, err = ldap.DialURL("ldaps://"+addr, ldap.DialWithDialer(dialer), ldap.DialWithTLSConfig(tlsCfg))
	} else {
		conn, err = ldap.DialURL("ldap://"+addr, ldap.DialWithDialer(dialer))
		if err == nil && startTLS {
			err = conn.StartTLS(tlsCfg)
		}
	}
	if err != nil {
		return nil, collector.Errorf(contract.ErrUnreachable, true, "%s: %v", addr, err)
	}
	defer conn.Close()
	conn.SetTimeout(dialTimeout)
	if err := conn.Bind(user, password); err != nil {
		return nil, collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the bind: %v", addr, err)
	}
	if baseDN == "" {
		// Root DSE tells us the default naming context.
		root, err := conn.Search(ldap.NewSearchRequest("", ldap.ScopeBaseObject, ldap.NeverDerefAliases, 0, 0, false, "(objectClass=*)", []string{"defaultNamingContext", "namingContexts"}, nil))
		if err != nil || len(root.Entries) == 0 {
			return nil, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s: no baseDn given and the root DSE did not name one", addr)
		}
		baseDN = root.Entries[0].GetAttributeValue("defaultNamingContext")
		if baseDN == "" {
			ncs := root.Entries[0].GetAttributeValues("namingContexts")
			if len(ncs) > 0 {
				baseDN = ncs[0]
			}
		}
	}
	inv := &Inventory{BaseDN: baseDN}
	if inv.Users, err = pagedSearch(conn, baseDN, "(|(&(objectCategory=person)(objectClass=user))(objectClass=inetOrgPerson)(objectClass=posixAccount))", userAttributes, "user"); err != nil {
		return nil, classify(addr, err)
	}
	if includeComputers {
		if inv.Computers, err = pagedSearch(conn, baseDN, "(objectCategory=computer)", computerAttributes, "computer"); err != nil {
			return nil, classify(addr, err)
		}
	}
	if inv.Groups, err = pagedSearch(conn, baseDN, "(|(objectCategory=group)(objectClass=groupOfNames)(objectClass=posixGroup))", []string{"cn", "sAMAccountName", "description", "groupType", "member"}, "group"); err != nil {
		return nil, classify(addr, err)
	}
	inv.Raw = []byte(fmt.Sprintf("baseDn=%s users=%d computers=%d groups=%d", baseDN, len(inv.Users), len(inv.Computers), len(inv.Groups)))
	return inv, nil
}

func classify(addr string, err error) error {
	if ldap.IsErrorWithCode(err, ldap.LDAPResultInsufficientAccessRights) {
		return collector.Errorf(contract.ErrPermissionDenied, false, "%s: %v", addr, err)
	}
	if ldap.IsErrorWithCode(err, ldap.LDAPResultSizeLimitExceeded) || ldap.IsErrorWithCode(err, ldap.LDAPResultTimeLimitExceeded) {
		return collector.Errorf(contract.ErrRateLimited, true, "%s: %v", addr, err)
	}
	return collector.Errorf(contract.ErrInternal, true, "%s: %v", addr, err)
}

// Filetime converts an AD large-integer timestamp to RFC 3339, or "" when unset.
func Filetime(v string) string {
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		return ""
	}
	secs := (n - filetimeEpochDiff) / filetimeUnitsPerS
	if secs <= 0 {
		return ""
	}
	return time.Unix(secs, 0).UTC().Format(time.RFC3339)
}

func uac(v string) int64 {
	n, _ := strconv.ParseInt(v, 10, 64)
	return n
}

// DomainOf turns "DC=corp,DC=example" into "corp.example".
func DomainOf(dn string) string {
	parts := []string{}
	for _, rdn := range strings.Split(dn, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(rdn), "=")
		if ok && strings.EqualFold(k, "DC") {
			parts = append(parts, v)
		}
	}
	return strings.ToLower(strings.Join(parts, "."))
}

func groupNames(memberOf []string) []string {
	out := make([]string, 0, len(memberOf))
	for _, dn := range memberOf {
		if cn, _, ok := strings.Cut(strings.TrimPrefix(dn, "CN="), ","); ok {
			out = append(out, cn)
		} else {
			out = append(out, strings.TrimPrefix(dn, "CN="))
		}
	}
	return out
}

// IsServiceAccount decides from SPNs or the configured OU substring.
func IsServiceAccount(e Entry, serviceOU string) bool {
	if len(e.Multi["servicePrincipalName"]) > 0 {
		return true
	}
	return serviceOU != "" && strings.Contains(strings.ToLower(e.DN), strings.ToLower(serviceOU))
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, serviceOU string, at time.Time) collector.Observation {
	obs := collector.Observation{Evidence: []collector.RawEvidence{{Kind: evidenceKind, Data: inv.Raw}}}
	domain := DomainOf(inv.BaseDN)
	directoryRef := strings.ToLower(inv.BaseDN)
	for _, u := range inv.Users {
		sam := u.Attrs["sAMAccountName"]
		principal := strings.ToLower(firstNonEmpty(u.Attrs["userPrincipalName"], joinUPN(sam, domain), u.Attrs["uid"], u.Attrs["cn"]))
		if principal == "" {
			continue
		}
		flags := uac(u.Attrs["userAccountControl"])
		typ := typeUser
		if IsServiceAccount(u, serviceOU) {
			typ = typeService
		}
		identity := map[string]string{"directoryRef": directoryRef, "principalName": principal}
		attrs := map[string]any{
			"directory": domain, "dn": u.DN, "samAccountName": sam, "displayName": u.Attrs["displayName"], "mail": strings.ToLower(u.Attrs["mail"]), "department": u.Attrs["department"], "title": u.Attrs["title"], "manager": u.Attrs["manager"], "description": u.Attrs["description"],
			"enabled": flags&uacDisabled == 0, "passwordNeverExpires": flags&uacDontExpirePwd != 0, "smartcardRequired": flags&uacSmartcardReq != 0,
			"lastLogon": Filetime(u.Attrs["lastLogonTimestamp"]), "passwordLastSet": Filetime(u.Attrs["pwdLastSet"]), "created": u.Attrs["whenCreated"],
			"groups": groupNames(u.Multi["memberOf"]), "groupCount": len(u.Multi["memberOf"]), "servicePrincipalNames": u.Multi["servicePrincipalName"],
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typ, Identity: identity, Name: firstNonEmpty(u.Attrs["displayName"], sam, principal), Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: "ldap", ID: u.DN}}, ObservedAt: at})
	}
	for _, c := range inv.Computers {
		fqdn := strings.ToLower(c.Attrs["dNSHostName"])
		if fqdn == "" {
			fqdn = strings.ToLower(strings.TrimSuffix(c.Attrs["sAMAccountName"], "$"))
			if domain != "" && fqdn != "" {
				fqdn += "." + domain
			}
		}
		if fqdn == "" {
			continue
		}
		flags := uac(c.Attrs["userAccountControl"])
		identity := map[string]string{"fqdn": fqdn}
		attrs := map[string]any{"directory": domain, "dn": c.DN, "operatingSystem": c.Attrs["operatingSystem"], "operatingSystemVersion": c.Attrs["operatingSystemVersion"], "adEnabled": flags&uacDisabled == 0, "lastLogon": Filetime(c.Attrs["lastLogonTimestamp"]), "created": c.Attrs["whenCreated"], "description": c.Attrs["description"], "source": collectorID}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHost, Identity: identity, Name: fqdn, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: "ldap", ID: c.DN}}, ObservedAt: at})
	}
	return obs
}

func joinUPN(sam, domain string) string {
	if sam == "" || domain == "" {
		return ""
	}
	return sam + "@" + domain
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	if cred == nil || cred.Type != "password" || cred.Fields[credUser] == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "ldap requires a password credential with a bind DN or UPN as username")
	}
	useTLS, _ := options[optionTLS].(bool)
	startTLS, _ := options[optionStartTLS].(bool)
	verify, _ := options[optionVerify].(bool)
	includeComputers := true
	if v, ok := options[optionComputers].(bool); ok {
		includeComputers = v
	}
	port := defaultPort
	if useTLS {
		port = defaultPortTLS
	}
	if p, ok := options[optionPort]; ok {
		if n, err := strconv.Atoi(fmt.Sprint(p)); err == nil && n > 0 {
			port = n
		}
	}
	baseDN, _ := options[optionBaseDN].(string)
	serviceOU, _ := options[optionServiceOU].(string)
	caPem, _ := options[optionCAPem].(string)
	tlsCfg, err := TLSConfig(target.Value, verify, caPem)
	if err != nil {
		return collector.Observation{}, err
	}
	inv, err := Search(ctx, target.Value, port, useTLS, startTLS, tlsCfg, cred.Fields[credUser], cred.Fields[credPassword], baseDN, includeComputers)
	if err != nil {
		return collector.Observation{}, err
	}
	return Emit(inv, target, serviceOU, time.Now().UTC()), nil
}
