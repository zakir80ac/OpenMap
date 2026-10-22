// REQ-DISC-018 — Citrix ADC / NetScaler collector over the NITRO REST API (header auth): appliance
// facts (hostname, build, hardware, NSIPs, HA role), every load-balancing vserver as a listening
// service with its VIP, bound services and service-group members with health, and content-switching
// vservers linked to the lbvservers they target. Member endpoints become listening services on the
// member hosts so the dependency map shows what sits behind each VIP.
package citrixadc

import (
	"context"
	"encoding/json"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID  = "citrix_adc"
	version      = "0.1.0"
	vendor       = "citrix"
	evidenceKind = "api_response"
	defaultPort  = 443
	optionVerify = "verifyTls"
	optionCA     = "caCertPem"
	credUser     = "username"
	credPassword = "password"
	headerUser   = "X-NITRO-USER"
	headerPass   = "X-NITRO-PASS"
	nitroConfig  = "/nitro/v1/config/"
	defaultVrf   = "default"
	stateUp      = "UP"
	nsipType     = "NSIP"
	// NITRO error codes that mean the credential was rejected rather than the object missing.
	nitroErrBadCredential = 354
	nitroErrNotAuthorized = 444

	typeLB       = "load_balancer"
	typeListener = "listening_service"
	typeIP       = "ip_address"
	relContains  = "contains"
	relUsesIP    = "uses_ip"
	relDependsOn = "depends_on"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "load_balancer", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"password"},
		TargetKinds: []string{"host"}, Emits: []string{typeLB, typeListener, typeIP},
		ContractVersion: contract.Version,
	}
}

// flexInt decodes NITRO numbers that arrive as either JSON numbers or quoted strings.
type flexInt int

func (f *flexInt) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return err
	}
	*f = flexInt(n)
	return nil
}

type envelope struct {
	ErrorCode int    `json:"errorcode"`
	Message   string `json:"message"`
	Severity  string `json:"severity"`
}

type hostnameResp struct {
	envelope
	Items []struct {
		Hostname string `json:"hostname"`
	} `json:"nshostname"`
}

type versionResp struct {
	envelope
	Version struct {
		Version string `json:"version"`
		Mode    string `json:"mode"`
	} `json:"nsversion"`
}

type hardwareResp struct {
	envelope
	Hardware struct {
		Description string `json:"hwdescription"`
		SysID       string `json:"sysid"`
		Serial      string `json:"serialno"`
		HostID      string `json:"host"`
		Encoded     string `json:"encodedserialno"`
	} `json:"nshardware"`
}

type nsipResp struct {
	envelope
	Items []struct {
		Address string `json:"ipaddress"`
		Type    string `json:"type"`
	} `json:"nsip"`
}

type haResp struct {
	envelope
	Items []struct {
		ID       string `json:"id"`
		Address  string `json:"ipaddress"`
		State    string `json:"state"`
		HAStatus string `json:"hastatus"`
	} `json:"hanode"`
}

// LBVserver is a NITRO lbvserver.
type LBVserver struct {
	Name           string  `json:"name"`
	Address        string  `json:"ipv46"`
	Port           flexInt `json:"port"`
	ServiceType    string  `json:"servicetype"`
	State          string  `json:"curstate"`
	EffectiveState string  `json:"effectivestate"`
	Method         string  `json:"lbmethod"`
	Persistence    string  `json:"persistencetype"`
	Health         flexInt `json:"health"`
	Comment        string  `json:"comment"`
}

type lbvserverResp struct {
	envelope
	Items []LBVserver `json:"lbvserver"`
}

// ServiceBinding is a service bound directly to an lbvserver.
type ServiceBinding struct {
	ServiceName string  `json:"servicename"`
	Address     string  `json:"ipv46"`
	Port        flexInt `json:"port"`
	State       string  `json:"curstate"`
	Weight      flexInt `json:"weight"`
	ServiceType string  `json:"servicetype"`
}

type serviceBindingResp struct {
	envelope
	Items []ServiceBinding `json:"lbvserver_service_binding"`
}

type groupBindingResp struct {
	envelope
	Items []struct {
		GroupName string `json:"servicegroupname"`
	} `json:"lbvserver_servicegroup_binding"`
}

// GroupMember is a servicegroup member.
type GroupMember struct {
	Address    string  `json:"ip"`
	Port       flexInt `json:"port"`
	State      string  `json:"svrstate"`
	Weight     flexInt `json:"weight"`
	ServerName string  `json:"servername"`
}

type groupMemberResp struct {
	envelope
	Items []GroupMember `json:"servicegroup_servicegroupmember_binding"`
}

// CSVserver is a content-switching vserver.
type CSVserver struct {
	Name        string  `json:"name"`
	Address     string  `json:"ipv46"`
	Port        flexInt `json:"port"`
	ServiceType string  `json:"servicetype"`
	State       string  `json:"curstate"`
}

type csvserverResp struct {
	envelope
	Items []CSVserver `json:"csvserver"`
}

type csLBBindingResp struct {
	envelope
	Items []struct {
		LBVserver string `json:"lbvserver"`
	} `json:"csvserver_lbvserver_binding"`
}

type csPolicyBindingResp struct {
	envelope
	Items []struct {
		Target string `json:"targetlbvserver"`
		Policy string `json:"policyname"`
	} `json:"csvserver_cspolicy_binding"`
}

// Member is a normalised backend endpoint behind an lbvserver.
type Member struct {
	Name, Address, Group, State string
	Port, Weight                int
}

// Inventory is everything gathered from one appliance.
type Inventory struct {
	Hostname, Version, Mode, HardwareDesc, SysID, Serial, HostID string
	NSIPs                                                        []string
	HAState, HAStatus                                            string
	HANodes                                                      int
	Virtuals                                                     []LBVserver
	Members                                                      map[string][]Member // by lbvserver name
	CSVirtuals                                                   []CSVserver
	CSTargets                                                    map[string][]string // csvserver → lbvserver names
	Raw                                                          [][]byte
}

func checkEnvelope(host string, e envelope) error {
	switch e.ErrorCode {
	case 0:
		return nil
	case nitroErrBadCredential, nitroErrNotAuthorized:
		return collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the NITRO credential: %s", host, e.Message)
	default:
		return collector.Errorf(contract.ErrUnsupportedDevice, false, "%s NITRO error %d: %s", host, e.ErrorCode, e.Message)
	}
}

func get[T any](ctx context.Context, c *restjson.Client, host, object string, out *T, env func(*T) envelope) error {
	if err := c.Get(ctx, nitroConfig+object, out); err != nil {
		if restjson.IsNotFound(err) {
			return nil
		}
		return err
	}
	return checkEnvelope(host, env(out))
}

// Walk gathers the inventory.
func Walk(ctx context.Context, c *restjson.Client) (*Inventory, error) {
	host := c.Base.Host
	inv := &Inventory{Members: map[string][]Member{}, CSTargets: map[string][]string{}}
	var hn hostnameResp
	if err := get(ctx, c, host, "nshostname", &hn, func(r *hostnameResp) envelope { return r.envelope }); err != nil {
		return nil, err
	}
	if len(hn.Items) > 0 {
		inv.Hostname = hn.Items[0].Hostname
	}
	var ver versionResp
	if err := get(ctx, c, host, "nsversion", &ver, func(r *versionResp) envelope { return r.envelope }); err != nil {
		return nil, err
	}
	inv.Version, inv.Mode = ver.Version.Version, ver.Version.Mode
	var hw hardwareResp
	if err := get(ctx, c, host, "nshardware", &hw, func(r *hardwareResp) envelope { return r.envelope }); err != nil {
		return nil, err
	}
	inv.HardwareDesc, inv.SysID, inv.Serial, inv.HostID = hw.Hardware.Description, hw.Hardware.SysID, hw.Hardware.Serial, hw.Hardware.HostID
	var ips nsipResp
	if err := get(ctx, c, host, "nsip", &ips, func(r *nsipResp) envelope { return r.envelope }); err != nil {
		return nil, err
	}
	for _, ip := range ips.Items {
		if ip.Type == nsipType {
			inv.NSIPs = append(inv.NSIPs, ip.Address)
		}
	}
	var ha haResp
	if err := get(ctx, c, host, "hanode", &ha, func(r *haResp) envelope { return r.envelope }); err == nil {
		inv.HANodes = len(ha.Items)
		for _, n := range ha.Items {
			if n.ID == "0" {
				inv.HAState, inv.HAStatus = n.State, n.HAStatus
			}
		}
	}
	var lbs lbvserverResp
	if err := get(ctx, c, host, "lbvserver", &lbs, func(r *lbvserverResp) envelope { return r.envelope }); err != nil {
		return nil, err
	}
	inv.Virtuals = lbs.Items
	groupCache := map[string][]GroupMember{}
	for _, v := range lbs.Items {
		name := url.PathEscape(v.Name)
		var sb serviceBindingResp
		if err := get(ctx, c, host, "lbvserver_service_binding/"+name, &sb, func(r *serviceBindingResp) envelope { return r.envelope }); err != nil {
			return nil, err
		}
		for _, s := range sb.Items {
			inv.Members[v.Name] = append(inv.Members[v.Name], Member{Name: s.ServiceName, Address: s.Address, Port: int(s.Port), Weight: int(s.Weight), State: s.State})
		}
		var gb groupBindingResp
		if err := get(ctx, c, host, "lbvserver_servicegroup_binding/"+name, &gb, func(r *groupBindingResp) envelope { return r.envelope }); err != nil {
			return nil, err
		}
		for _, g := range gb.Items {
			members, ok := groupCache[g.GroupName]
			if !ok {
				var gm groupMemberResp
				if err := get(ctx, c, host, "servicegroup_servicegroupmember_binding/"+url.PathEscape(g.GroupName), &gm, func(r *groupMemberResp) envelope { return r.envelope }); err != nil {
					return nil, err
				}
				members = gm.Items
				groupCache[g.GroupName] = members
			}
			for _, m := range members {
				inv.Members[v.Name] = append(inv.Members[v.Name], Member{Name: m.ServerName, Address: m.Address, Port: int(m.Port), Weight: int(m.Weight), State: m.State, Group: g.GroupName})
			}
		}
	}
	var cs csvserverResp
	if err := get(ctx, c, host, "csvserver", &cs, func(r *csvserverResp) envelope { return r.envelope }); err != nil {
		return nil, err
	}
	inv.CSVirtuals = cs.Items
	for _, v := range cs.Items {
		name := url.PathEscape(v.Name)
		seen := map[string]bool{}
		var lb csLBBindingResp
		if err := get(ctx, c, host, "csvserver_lbvserver_binding/"+name, &lb, func(r *csLBBindingResp) envelope { return r.envelope }); err != nil {
			return nil, err
		}
		for _, b := range lb.Items {
			if b.LBVserver != "" && !seen[b.LBVserver] {
				seen[b.LBVserver] = true
				inv.CSTargets[v.Name] = append(inv.CSTargets[v.Name], b.LBVserver)
			}
		}
		var pb csPolicyBindingResp
		if err := get(ctx, c, host, "csvserver_cspolicy_binding/"+name, &pb, func(r *csPolicyBindingResp) envelope { return r.envelope }); err != nil {
			return nil, err
		}
		for _, b := range pb.Items {
			if b.Target != "" && !seen[b.Target] {
				seen[b.Target] = true
				inv.CSTargets[v.Name] = append(inv.CSTargets[v.Name], b.Target)
			}
		}
	}
	inv.Raw = c.Raw()
	return inv, nil
}

func protoOf(serviceType string) string {
	s := strings.ToLower(serviceType)
	switch {
	case s == "", s == "any":
		return "ip"
	case strings.HasPrefix(s, "udp"), s == "dns", s == "radius", s == "syslogudp":
		return "udp"
	default:
		return "tcp"
	}
}

func stateOf(state string) string {
	switch strings.ToUpper(state) {
	case stateUp:
		return "up"
	case "DOWN":
		return "down"
	case "OUT OF SERVICE", "TRANSITION TO OUT OF SERVICE", "GOING OUT OF SERVICE", "DISABLED":
		return "disabled"
	case "":
		return "unknown"
	default:
		return strings.ToLower(state)
	}
}

func listenerIdentity(lbRef, proto string, port int, name string) map[string]string {
	identity := map[string]string{"hostRef": lbRef, "protocol": proto, "port": strconv.Itoa(port)}
	if port == 0 {
		identity["port"] = name
	}
	return identity
}

func isRealVIP(addr string) bool {
	ip := net.ParseIP(addr)
	return ip != nil && !ip.IsUnspecified()
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	lbRef := strings.ToLower(firstNonEmpty(inv.Hostname, target.Value))
	mgmt := target.Value
	if len(inv.NSIPs) > 0 {
		mgmt = inv.NSIPs[0]
	}
	serial := firstNonEmpty(inv.Serial, inv.SysID, inv.HostID, vendor+":"+lbRef)
	lbIdentity := map[string]string{"serialNumber": serial, "managementIp": mgmt}
	lb := contract.CiRef{Type: typeLB, Identity: lbIdentity}
	up := 0
	for _, v := range inv.Virtuals {
		if stateOf(v.State) == "up" {
			up++
		}
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeLB, Identity: lbIdentity, Name: lbRef,
		Attributes: map[string]any{"vendor": vendor, "model": firstNonEmpty(inv.HardwareDesc, "NetScaler"), "version": inv.Version, "mode": inv.Mode, "systemId": inv.SysID, "hostId": inv.HostID, "haState": stateOf(inv.HAState), "haStatus": inv.HAStatus, "haNodes": inv.HANodes, "managementIps": inv.NSIPs, "virtualServers": len(inv.Virtuals), "virtualServersUp": up, "contentSwitchingServers": len(inv.CSVirtuals), "managementIp": mgmt, "fqdn": inv.Hostname},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: serial}}, ObservedAt: at})
	vsRef := map[string]contract.CiRef{}
	memberSeen := map[string]bool{}
	for _, v := range inv.Virtuals {
		proto := protoOf(v.ServiceType)
		identity := listenerIdentity(lbRef, proto, int(v.Port), v.Name)
		vs := contract.CiRef{Type: typeListener, Identity: identity}
		vsRef[v.Name] = vs
		members := inv.Members[v.Name]
		upMembers := 0
		for _, m := range members {
			if stateOf(m.State) == "up" {
				upMembers++
			}
		}
		attrs := map[string]any{"vendor": vendor, "virtualServer": v.Name, "destination": v.Address, "protocol": proto, "serviceType": v.ServiceType, "port": int(v.Port), "state": stateOf(v.State), "effectiveState": stateOf(v.EffectiveState), "loadBalancingMode": v.Method, "persistence": v.Persistence, "healthPercent": int(v.Health), "memberCount": len(members), "membersUp": upMembers, "description": v.Comment, "service": "load-balanced-vip", "source": collectorID}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: identity, Name: v.Name + " (" + v.Address + ":" + strconv.Itoa(int(v.Port)) + ")", Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: v.Name}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: lb, To: vs, Attributes: map[string]any{}, ObservedAt: at})
		if isRealVIP(v.Address) {
			ipIdentity := map[string]string{"address": v.Address, "vrfRef": defaultVrf}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: v.Address, Attributes: map[string]any{"role": "vip", "assignedTo": lbRef, "virtualServer": v.Name, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vs, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
		}
		for _, m := range members {
			if m.Address == "" || m.Port == 0 {
				continue
			}
			mIdentity := map[string]string{"hostRef": strings.ToLower(m.Address), "protocol": proto, "port": strconv.Itoa(m.Port)}
			mRef := contract.CiRef{Type: typeListener, Identity: mIdentity}
			key := mIdentity["hostRef"] + "|" + proto + "|" + mIdentity["port"]
			if !memberSeen[key] {
				memberSeen[key] = true
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: mIdentity, Name: firstNonEmpty(m.Name, m.Address) + ":" + strconv.Itoa(m.Port), Attributes: map[string]any{"protocol": proto, "port": m.Port, "address": m.Address, "poolMemberState": stateOf(m.State), "weight": m.Weight, "serviceGroup": m.Group, "serverName": m.Name, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				if net.ParseIP(m.Address) != nil {
					ipIdentity := map[string]string{"address": m.Address, "vrfRef": defaultVrf}
					obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: m.Address, Attributes: map[string]any{"role": "pool-member", "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
					obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: mRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
				}
			}
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relDependsOn, From: vs, To: mRef, Attributes: map[string]any{"serviceGroup": m.Group, "state": stateOf(m.State), "weight": m.Weight}, ObservedAt: at})
		}
	}
	for _, v := range inv.CSVirtuals {
		proto := protoOf(v.ServiceType)
		identity := listenerIdentity(lbRef, proto, int(v.Port), v.Name)
		cs := contract.CiRef{Type: typeListener, Identity: identity}
		targets := inv.CSTargets[v.Name]
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: identity, Name: v.Name + " (cs " + v.Address + ":" + strconv.Itoa(int(v.Port)) + ")", Attributes: map[string]any{"vendor": vendor, "virtualServer": v.Name, "role": "content-switching", "destination": v.Address, "protocol": proto, "serviceType": v.ServiceType, "port": int(v.Port), "state": stateOf(v.State), "targets": targets, "service": "content-switching-vip", "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: v.Name}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: lb, To: cs, Attributes: map[string]any{}, ObservedAt: at})
		if isRealVIP(v.Address) {
			ipIdentity := map[string]string{"address": v.Address, "vrfRef": defaultVrf}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: v.Address, Attributes: map[string]any{"role": "vip", "assignedTo": lbRef, "virtualServer": v.Name, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: cs, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
		}
		for _, t := range targets {
			if ref, ok := vsRef[t]; ok {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relDependsOn, From: cs, To: ref, Attributes: map[string]any{"via": "content-switching"}, ObservedAt: at})
			}
		}
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
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "citrix_adc requires a password credential with a username")
	}
	opts := restjson.Options{VerifyTLS: restjson.BoolOption(options, optionVerify), CAPem: restjson.StringOption(options, optionCA), Headers: map[string]string{headerUser: cred.Fields[credUser], headerPass: cred.Fields[credPassword]}}
	c, err := restjson.New(target.Value, defaultPort, restjson.Auth{}, opts)
	if err != nil {
		return collector.Observation{}, err
	}
	inv, err := Walk(ctx, c)
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	return Emit(inv, target, time.Now().UTC()), nil
}

var _ = json.Marshal
