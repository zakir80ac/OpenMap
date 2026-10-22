// REQ-DISC-013 — Cisco UCS Manager collector over the UCSM XML API (/nuova): login cookie, then
// configResolveClass for the system, fabric interconnects, chassis, blades, rack units and their
// management interfaces. Emits chassis, blade, host, bmc (CIMC) and network_device CIs with the
// contains / manages relationships that place every blade in its chassis slot.
package ucs

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/xml"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	collectorID  = "cisco_ucs"
	version      = "0.1.0"
	vendor       = "cisco"
	evidenceKind = "api_response"
	httpTimeout  = 60 * time.Second
	apiPath      = "/nuova"
	optionVerify = "verifyTls"
	credUser     = "username"
	credPassword = "password"

	typeChassis = "chassis"
	typeBlade   = "blade"
	typeHost    = "host"
	typeBmc     = "bmc"
	typeSwitch  = "network_device"
	relContains = "contains"
	relManages  = "manages"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "ipmi_redfish", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"password"},
		TargetKinds: []string{"host"}, Emits: []string{typeChassis, typeBlade, typeHost, typeBmc, typeSwitch},
		ContractVersion: contract.Version,
	}
}

// Client posts XML API requests to one UCS Manager.
type Client struct {
	base   string
	http   *http.Client
	cookie string
	raw    [][]byte
}

func NewClient(host string, verifyTLS bool) *Client {
	base := host
	if !strings.Contains(base, "://") {
		base = "https://" + base
	}
	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: !verifyTLS, MinVersion: tls.VersionTLS12}} //nolint:gosec // UCS Manager ships a self-signed certificate; verifyTls=true enforces the chain.
	return &Client{base: strings.TrimSuffix(base, "/"), http: &http.Client{Timeout: httpTimeout, Transport: tr}}
}

func (c *Client) post(ctx context.Context, body string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+apiPath, bytes.NewBufferString(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode >= http.StatusBadRequest {
		return collector.Errorf(contract.ErrUnsupportedDevice, false, "%s returned %d for the XML API", c.base, res.StatusCode)
	}
	var fault struct {
		ErrorCode string `xml:"errorCode,attr"`
		ErrorDesc string `xml:"errorDescr,attr"`
	}
	if err := xml.Unmarshal(raw, &fault); err == nil && fault.ErrorCode != "" {
		if strings.Contains(strings.ToLower(fault.ErrorDesc), "authentication") || fault.ErrorCode == "551" || fault.ErrorCode == "552" {
			return collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the credential: %s", c.base, fault.ErrorDesc)
		}
		return collector.Errorf(contract.ErrUnsupportedDevice, false, "%s XML API error %s: %s", c.base, fault.ErrorCode, fault.ErrorDesc)
	}
	c.raw = append(c.raw, raw)
	if out != nil {
		return xml.Unmarshal(raw, out)
	}
	return nil
}

func attr(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "&", "&amp;"), `"`, "&quot;")
}

// Login obtains the session cookie.
func (c *Client) Login(ctx context.Context, user, password string) error {
	var res struct {
		Cookie string `xml:"outCookie,attr"`
	}
	if err := c.post(ctx, `<aaaLogin inName="`+attr(user)+`" inPassword="`+attr(password)+`" />`, &res); err != nil {
		return err
	}
	if res.Cookie == "" {
		return collector.Errorf(contract.ErrAuthFailed, false, "%s returned no session cookie", c.base)
	}
	c.cookie = res.Cookie
	return nil
}

// Logout releases the session.
func (c *Client) Logout(ctx context.Context) {
	if c.cookie != "" {
		_ = c.post(ctx, `<aaaLogout inCookie="`+attr(c.cookie)+`" />`, nil)
	}
}

func (c *Client) resolveClass(ctx context.Context, classID string, out any) error {
	return c.post(ctx, `<configResolveClass cookie="`+attr(c.cookie)+`" classId="`+classID+`" inHierarchical="false" />`, out)
}

type topSystem struct {
	Name    string `xml:"name,attr"`
	Address string `xml:"address,attr"`
	Mode    string `xml:"mode,attr"`
	Site    string `xml:"site,attr"`
}

type networkElement struct {
	Dn      string `xml:"dn,attr"`
	ID      string `xml:"id,attr"`
	Serial  string `xml:"serial,attr"`
	Model   string `xml:"model,attr"`
	OobIP   string `xml:"oobIfIp,attr"`
	Oper    string `xml:"operability,attr"`
	Version string `xml:"version,attr"`
}

type equipmentChassis struct {
	Dn     string `xml:"dn,attr"`
	ID     string `xml:"id,attr"`
	Serial string `xml:"serial,attr"`
	Model  string `xml:"model,attr"`
	Oper   string `xml:"operability,attr"`
	Power  string `xml:"power,attr"`
	Vendor string `xml:"vendor,attr"`
}

type computeUnit struct {
	Dn           string `xml:"dn,attr"`
	ChassisID    string `xml:"chassisId,attr"`
	SlotID       string `xml:"slotId,attr"`
	ServerID     string `xml:"serverId,attr"`
	Serial       string `xml:"serial,attr"`
	Model        string `xml:"model,attr"`
	Vendor       string `xml:"vendor,attr"`
	UUID         string `xml:"uuid,attr"`
	NumCpus      string `xml:"numOfCpus,attr"`
	NumCores     string `xml:"numOfCores,attr"`
	TotalMemory  string `xml:"totalMemory,attr"`
	OperPower    string `xml:"operPower,attr"`
	Operability  string `xml:"operability,attr"`
	AssignedToDn string `xml:"assignedToDn,attr"`
	Name         string `xml:"name,attr"`
}

type mgmtIf struct {
	Dn         string `xml:"dn,attr"`
	ExternalIP string `xml:"externalIp,attr"`
	Mac        string `xml:"mac,attr"`
	Subject    string `xml:"subject,attr"`
}

// Inventory is one UCS domain.
type Inventory struct {
	System    topSystem
	Fabrics   []networkElement
	Chassis   []equipmentChassis
	Blades    []computeUnit
	RackUnits []computeUnit
	MgmtIfs   []mgmtIf
	Raw       [][]byte
}

func resolve[T any](ctx context.Context, c *Client, classID string, out *[]T) error {
	var res struct {
		Out struct {
			Items []T `xml:",any"`
		} `xml:"outConfigs"`
	}
	if err := c.resolveClass(ctx, classID, &res); err != nil {
		return err
	}
	*out = res.Out.Items
	return nil
}

// Walk reads the domain.
func (c *Client) Walk(ctx context.Context) (*Inventory, error) {
	inv := &Inventory{}
	var systems []topSystem
	if err := resolve(ctx, c, "topSystem", &systems); err != nil {
		return nil, err
	}
	if len(systems) > 0 {
		inv.System = systems[0]
	}
	if err := resolve(ctx, c, "networkElement", &inv.Fabrics); err != nil {
		return nil, err
	}
	if err := resolve(ctx, c, "equipmentChassis", &inv.Chassis); err != nil {
		return nil, err
	}
	if err := resolve(ctx, c, "computeBlade", &inv.Blades); err != nil {
		return nil, err
	}
	_ = resolve(ctx, c, "computeRackUnit", &inv.RackUnits)
	_ = resolve(ctx, c, "mgmtIf", &inv.MgmtIfs)
	inv.Raw = c.raw
	return inv, nil
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func healthOf(oper string) string {
	switch strings.ToLower(oper) {
	case "operable":
		return "healthy"
	case "degraded", "power-problem", "thermal-problem":
		return "degraded"
	case "inoperable", "removed":
		return "down"
	default:
		return "unknown"
	}
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	domain := strings.ToLower(firstNonEmpty(inv.System.Name, target.Value))
	cimcByDn := map[string]mgmtIf{}
	for _, m := range inv.MgmtIfs {
		if strings.EqualFold(m.Subject, "blade") || strings.EqualFold(m.Subject, "rack") || strings.EqualFold(m.Subject, "cimc") {
			// dn is like sys/chassis-1/blade-3/mgmt/if-1: key by the compute unit dn
			cimcByDn[strings.SplitN(m.Dn, "/mgmt/", 2)[0]] = m
		}
	}
	for _, f := range inv.Fabrics {
		if f.Serial == "" {
			continue
		}
		identity := map[string]string{"serialNumber": f.Serial}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeSwitch, Identity: identity, Name: domain + " FI-" + f.ID,
			Attributes: map[string]any{"vendor": vendor, "model": f.Model, "firmware": f.Version, "health": healthOf(f.Oper), "managementIp": f.OobIP, "role": "fabric-interconnect", "ucsDomain": domain},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: f.Dn}}, ObservedAt: at})
	}
	chassisRef := map[string]contract.CiRef{}
	chassisSerial := map[string]string{}
	for _, ch := range inv.Chassis {
		if ch.Serial == "" {
			continue
		}
		identity := map[string]string{"serialNumber": ch.Serial}
		chassisRef[ch.ID] = contract.CiRef{Type: typeChassis, Identity: identity}
		chassisSerial[ch.ID] = ch.Serial
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeChassis, Identity: identity, Name: domain + " chassis " + ch.ID,
			Attributes: map[string]any{"vendor": firstNonEmpty(ch.Vendor, "Cisco Systems Inc"), "model": ch.Model, "health": healthOf(ch.Oper), "power": ch.Power, "ucsDomain": domain, "chassisId": ch.ID},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: ch.Dn}}, ObservedAt: at})
	}
	emitUnit := func(u computeUnit, blade bool) {
		if u.Serial == "" {
			return
		}
		hostIdentity := map[string]string{"serialNumber": u.Serial}
		if u.UUID != "" {
			hostIdentity["systemUuid"] = strings.ToLower(u.UUID)
		}
		cimc, hasCimc := cimcByDn[u.Dn]
		if hasCimc && cimc.Mac != "" {
			// CIMC MAC is not a host NIC; keep it as an attribute only.
			hostIdentity = map[string]string{"serialNumber": u.Serial, "systemUuid": strings.ToLower(u.UUID)}
		}
		hostRef := contract.CiRef{Type: typeHost, Identity: hostIdentity}
		attrs := map[string]any{"vendor": firstNonEmpty(u.Vendor, "Cisco Systems Inc"), "model": u.Model, "powerState": u.OperPower, "health": healthOf(u.Operability), "cpuSockets": atoi(u.NumCpus), "cpuCores": atoi(u.NumCores), "memoryMb": atoi(u.TotalMemory), "serviceProfile": strings.TrimPrefix(u.AssignedToDn, "org-root/"), "ucsDomain": domain, "ucsDn": u.Dn}
		name := firstNonEmpty(u.Name, u.Dn)
		if u.AssignedToDn != "" {
			parts := strings.Split(u.AssignedToDn, "/ls-")
			name = parts[len(parts)-1]
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHost, Identity: hostIdentity, Name: name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: collectorID, ID: u.Dn}}, ObservedAt: at})
		if blade {
			if ch, ok := chassisRef[u.ChassisID]; ok {
				bladeIdentity := map[string]string{"chassisRef": chassisSerial[u.ChassisID], "bay": u.SlotID, "serialNumber": u.Serial}
				bladeRef := contract.CiRef{Type: typeBlade, Identity: bladeIdentity}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeBlade, Identity: bladeIdentity, Name: domain + " chassis " + u.ChassisID + " slot " + u.SlotID, Attributes: map[string]any{"vendor": vendor, "model": u.Model, "bay": atoi(u.SlotID), "health": healthOf(u.Operability)}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: ch, To: bladeRef, Attributes: map[string]any{"slot": atoi(u.SlotID)}, ObservedAt: at})
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: bladeRef, To: hostRef, Attributes: map[string]any{}, ObservedAt: at})
			}
		}
		if hasCimc && cimc.ExternalIP != "" && cimc.ExternalIP != "0.0.0.0" {
			bmcIdentity := map[string]string{"managementIp": cimc.ExternalIP}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeBmc, Identity: bmcIdentity, Name: "CIMC @ " + cimc.ExternalIP, Attributes: map[string]any{"vendor": vendor, "model": "CIMC", "managementIp": cimc.ExternalIP, "mac": strings.ToLower(cimc.Mac), "ucsDn": cimc.Dn}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relManages, From: contract.CiRef{Type: typeBmc, Identity: bmcIdentity}, To: hostRef, Attributes: map[string]any{"protocol": "cimc"}, ObservedAt: at})
		}
	}
	for _, b := range inv.Blades {
		emitUnit(b, true)
	}
	for _, r := range inv.RackUnits {
		emitUnit(r, false)
	}
	return obs
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
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "ucs requires a password credential with a username")
	}
	verify, _ := options[optionVerify].(bool)
	c := NewClient(target.Value, verify)
	if err := c.Login(ctx, cred.Fields[credUser], cred.Fields[credPassword]); err != nil {
		return collector.Observation{}, classify(target.Value, err)
	}
	defer c.Logout(ctx)
	inv, err := c.Walk(ctx)
	if err != nil {
		return collector.Observation{}, classify(target.Value, err)
	}
	return Emit(inv, target, time.Now().UTC()), nil
}

func classify(target string, err error) error {
	if _, ok := err.(*collector.TargetError); ok {
		return err
	}
	if strings.Contains(strings.ToLower(err.Error()), "timeout") {
		return collector.Errorf(contract.ErrTimeout, true, "%s timed out", target)
	}
	return collector.Errorf(contract.ErrUnreachable, true, "%s: %v", target, err)
}
