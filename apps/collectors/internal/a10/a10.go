// REQ-DISC-018 — A10 Thunder / ACOS collector over aXAPI v3: session sign-on for an `A10 <signature>`
// token, appliance facts (hostname, platform, ACOS version, serial), SLB virtual servers with their
// VIPs and ports as listening services, service groups as backend pools (method, member health from
// the oper view) and members as listening services on the real servers, then a clean logoff.
package a10

import (
	"context"
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
	collectorID  = "a10_thunder"
	version      = "0.1.0"
	vendor       = "a10"
	evidenceKind = "api_response"
	defaultPort  = 443
	optionVerify = "verifyTls"
	optionCA     = "caCertPem"
	credUser     = "username"
	credPassword = "password"
	apiBase      = "/axapi/v3"
	authScheme   = "A10 "
	defaultVrf   = "default"

	typeLB       = "load_balancer"
	typeListener = "listening_service"
	typeIP       = "ip_address"
	typeHost     = "host"
	relContains  = "contains"
	relUsesIP    = "uses_ip"
	relDependsOn = "depends_on"
	relRunsOn    = "runs_on"
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

type authResponse struct {
	AuthResponse struct {
		Signature string `json:"signature"`
	} `json:"authresponse"`
}

// VersionOper is `/version/oper`.
type VersionOper struct {
	Version struct {
		Oper struct {
			HWPlatform   string `json:"hw-platform"`
			SWVersion    string `json:"sw-version"`
			SerialNumber string `json:"serial-number"`
			Hostname     string `json:"hostname"`
			HAState      string `json:"ha-state"`
			UpTime       string `json:"up-time"`
		} `json:"oper"`
	} `json:"version"`
}

// VirtualPort is one entry under a virtual server's `port-list`.
type VirtualPort struct {
	PortNumber   int    `json:"port-number"`
	Protocol     string `json:"protocol"`
	ServiceGroup string `json:"service-group"`
	Action       string `json:"action"`
	Name         string `json:"name"`
}

// VirtualServer is one `/slb/virtual-server` entry.
type VirtualServer struct {
	Name      string        `json:"name"`
	IPAddress string        `json:"ip-address"`
	IPv6      string        `json:"ipv6-address"`
	Enable    string        `json:"enable-disable-action"`
	PortList  []VirtualPort `json:"port-list"`
}

// Member is one `/slb/service-group` member.
type Member struct {
	Name        string `json:"name"`
	Port        int    `json:"port"`
	MemberState string `json:"member-state"`
	Priority    int    `json:"member-priority"`
}

// ServiceGroup is one `/slb/service-group` entry.
type ServiceGroup struct {
	Name        string   `json:"name"`
	Protocol    string   `json:"protocol"`
	LBMethod    string   `json:"lb-method"`
	HealthCheck string   `json:"health-check"`
	MemberList  []Member `json:"member-list"`
}

// Server is one `/slb/server` entry (the real server behind members).
type Server struct {
	Name   string `json:"name"`
	Host   string `json:"host"`
	FQDN   string `json:"fqdn-name"`
	Action string `json:"action"`
}

type memberOper struct {
	MemberName string `json:"member-name"`
	Port       int    `json:"port"`
	Oper       struct {
		State string `json:"state"`
	} `json:"oper"`
}

type serviceGroupOper struct {
	Name string `json:"name"`
	Oper struct {
		State string `json:"state"`
	} `json:"oper"`
	MemberList []memberOper `json:"member-list"`
}

// ManagementInterface is `/interface/management`: the address of the dedicated management port.
type ManagementInterface struct {
	Management struct {
		IP struct {
			IPv4Address string `json:"ipv4-address"`
			IPv4Netmask string `json:"ipv4-netmask"`
		} `json:"ip"`
	} `json:"management"`
}

// Inventory is everything the walk gathered.
type Inventory struct {
	Version        VersionOper
	Management     ManagementInterface
	VirtualServers []VirtualServer
	ServiceGroups  []ServiceGroup
	Servers        []Server
	// MemberState keyed by "group|server|port" from the oper view ("Up", "Down", "Disabled").
	MemberState map[string]string
	GroupState  map[string]string
	Raw         [][]byte
}

// Login exchanges the credential for the session signature.
func Login(ctx context.Context, c *restjson.Client, user, password string) (string, error) {
	var out authResponse
	if err := c.Post(ctx, apiBase+"/auth", map[string]any{"credentials": map[string]string{"username": user, "password": password}}, &out); err != nil {
		return "", err
	}
	if out.AuthResponse.Signature == "" {
		return "", collector.Errorf(contract.ErrAuthFailed, false, "%s returned no aXAPI signature", c.Base.Host)
	}
	return out.AuthResponse.Signature, nil
}

// Walk reads facts, virtual servers, service groups, servers and the service-group oper view.
func Walk(ctx context.Context, c *restjson.Client) (*Inventory, error) {
	inv := &Inventory{MemberState: map[string]string{}, GroupState: map[string]string{}}
	if err := c.Get(ctx, apiBase+"/version/oper", &inv.Version); err != nil {
		return nil, err
	}
	// The management port address keys the appliance: the job target may be a DNS name, a data-plane
	// address or a URL with a port. Partitions without the object (or without the right) answer 404/403.
	if err := c.Get(ctx, apiBase+"/interface/management", &inv.Management); err != nil && !restjson.IsNotFound(err) && !restjson.IsForbidden(err) {
		return nil, err
	}
	var vs struct {
		List []VirtualServer `json:"virtual-server-list"`
	}
	if err := c.Get(ctx, apiBase+"/slb/virtual-server", &vs); err != nil && !restjson.IsNotFound(err) {
		return nil, err
	}
	inv.VirtualServers = vs.List
	var sg struct {
		List []ServiceGroup `json:"service-group-list"`
	}
	if err := c.Get(ctx, apiBase+"/slb/service-group", &sg); err != nil && !restjson.IsNotFound(err) {
		return nil, err
	}
	inv.ServiceGroups = sg.List
	var srv struct {
		List []Server `json:"server-list"`
	}
	if err := c.Get(ctx, apiBase+"/slb/server", &srv); err != nil && !restjson.IsNotFound(err) {
		return nil, err
	}
	inv.Servers = srv.List
	var oper struct {
		List []serviceGroupOper `json:"service-group-list"`
	}
	if err := c.Get(ctx, apiBase+"/slb/service-group/oper", &oper); err == nil {
		for _, g := range oper.List {
			inv.GroupState[g.Name] = g.Oper.State
			for _, m := range g.MemberList {
				inv.MemberState[g.Name+"|"+m.MemberName+"|"+strconv.Itoa(m.Port)] = m.Oper.State
			}
		}
	} else if !restjson.IsNotFound(err) {
		return nil, err
	}
	inv.Raw = c.Raw()
	return inv, nil
}

// Logoff closes the aXAPI session; failures are ignored because the inventory is already complete.
func Logoff(ctx context.Context, c *restjson.Client) {
	_ = c.Post(ctx, apiBase+"/logoff", nil, nil)
}

func normaliseState(cfg, oper string) string {
	switch strings.ToLower(oper) {
	case "up", "functional up":
		return "up"
	case "down", "functional down":
		return "down"
	case "disabled", "disb":
		return "disabled"
	}
	switch strings.ToLower(cfg) {
	case "disable":
		return "disabled"
	case "":
		return "unknown"
	default:
		return strings.ToLower(cfg)
	}
}

// Emit converts an inventory into observations.
func Emit(inv *Inventory, target contract.Target, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	v := inv.Version.Version.Oper
	mgmt := ManagementAddress(inv, target.Value)
	lbRef := strings.ToLower(firstNonEmpty(v.Hostname, mgmt))
	lbIdentity := map[string]string{"serialNumber": firstNonEmpty(v.SerialNumber, vendor+":"+lbRef), "managementIp": mgmt}
	lb := contract.CiRef{Type: typeLB, Identity: lbIdentity}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeLB, Identity: lbIdentity, Name: lbRef,
		Attributes: map[string]any{"vendor": vendor, "model": v.HWPlatform, "version": v.SWVersion, "haState": v.HAState, "upTime": v.UpTime, "virtualServers": len(inv.VirtualServers), "serviceGroups": len(inv.ServiceGroups), "servers": len(inv.Servers), "managementIp": mgmt, "fqdn": lbRef},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: v.SerialNumber}}, ObservedAt: at})
	serverByName := map[string]Server{}
	for _, s := range inv.Servers {
		serverByName[s.Name] = s
	}
	groupByName := map[string]ServiceGroup{}
	for _, g := range inv.ServiceGroups {
		groupByName[g.Name] = g
	}
	poolRef := map[string]contract.CiRef{}
	memberSeen := map[string]bool{}
	for _, g := range inv.ServiceGroups {
		proto := strings.ToLower(firstNonEmpty(g.Protocol, "tcp"))
		identity := map[string]string{"hostRef": lbRef, "protocol": proto, "port": g.Name}
		pool := contract.CiRef{Type: typeListener, Identity: identity}
		poolRef[g.Name] = pool
		up := 0
		for _, m := range g.MemberList {
			if normaliseState(m.MemberState, inv.MemberState[g.Name+"|"+m.Name+"|"+strconv.Itoa(m.Port)]) == "up" {
				up++
			}
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: identity, Name: g.Name + " (service group)", Attributes: map[string]any{"vendor": vendor, "role": "backend-pool", "serviceGroup": g.Name, "protocol": proto, "loadBalancingMode": g.LBMethod, "monitor": g.HealthCheck, "state": normaliseState("", inv.GroupState[g.Name]), "memberCount": len(g.MemberList), "membersUp": up, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: "service-group/" + g.Name}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: lb, To: pool, Attributes: map[string]any{}, ObservedAt: at})
		for _, m := range g.MemberList {
			s := serverByName[m.Name]
			addr := firstNonEmpty(s.Host, s.FQDN, m.Name)
			if m.Port == 0 {
				continue
			}
			state := normaliseState(m.MemberState, inv.MemberState[g.Name+"|"+m.Name+"|"+strconv.Itoa(m.Port)])
			mIdentity := map[string]string{"hostRef": strings.ToLower(addr), "protocol": proto, "port": strconv.Itoa(m.Port)}
			mRef := contract.CiRef{Type: typeListener, Identity: mIdentity}
			key := mIdentity["hostRef"] + "|" + proto + "|" + mIdentity["port"]
			if !memberSeen[key] {
				memberSeen[key] = true
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: mIdentity, Name: m.Name + ":" + strconv.Itoa(m.Port), Attributes: map[string]any{"protocol": proto, "port": m.Port, "address": addr, "server": m.Name, "poolMemberState": state, "priority": m.Priority, "serviceGroup": g.Name, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				if net.ParseIP(addr) != nil {
					ipIdentity := map[string]string{"address": addr, "vrfRef": defaultVrf}
					obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: addr, Attributes: map[string]any{"role": "pool-member", "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
					obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: mRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
				} else if s.FQDN != "" {
					obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: mRef, To: contract.CiRef{Type: typeHost, Identity: map[string]string{"fqdn": strings.ToLower(s.FQDN)}}, Attributes: map[string]any{}, ObservedAt: at})
				}
			}
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relDependsOn, From: pool, To: mRef, Attributes: map[string]any{"serviceGroup": g.Name, "state": state, "priority": m.Priority}, ObservedAt: at})
		}
	}
	for _, vsrv := range inv.VirtualServers {
		addr := firstNonEmpty(vsrv.IPAddress, vsrv.IPv6)
		for _, p := range vsrv.PortList {
			proto := strings.ToLower(firstNonEmpty(p.Protocol, "tcp"))
			identity := map[string]string{"hostRef": lbRef, "protocol": proto, "port": vsrv.Name + ":" + strconv.Itoa(p.PortNumber)}
			vs := contract.CiRef{Type: typeListener, Identity: identity}
			attrs := map[string]any{"vendor": vendor, "role": "frontend", "virtualServer": vsrv.Name, "destination": addr, "protocol": proto, "port": p.PortNumber, "enabled": vsrv.Enable != "disable" && p.Action != "disable", "serviceGroup": p.ServiceGroup, "service": "load-balanced-vip", "source": collectorID}
			if g, ok := groupByName[p.ServiceGroup]; ok {
				attrs["loadBalancingMode"] = g.LBMethod
				attrs["memberCount"] = len(g.MemberList)
			}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: identity, Name: vsrv.Name + " (" + addr + ":" + strconv.Itoa(p.PortNumber) + ")", Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: "virtual-server/" + vsrv.Name + "/" + strconv.Itoa(p.PortNumber)}}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: lb, To: vs, Attributes: map[string]any{}, ObservedAt: at})
			if net.ParseIP(addr) != nil {
				ipIdentity := map[string]string{"address": addr, "vrfRef": defaultVrf}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: addr, Attributes: map[string]any{"role": "vip", "assignedTo": lbRef, "virtualServer": vsrv.Name, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vs, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
			}
			if pool, ok := poolRef[p.ServiceGroup]; ok {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relDependsOn, From: vs, To: pool, Attributes: map[string]any{"serviceGroup": p.ServiceGroup}, ObservedAt: at})
			}
		}
	}
	return obs
}

// ManagementAddress is the management port's IPv4 address when the appliance reports one, otherwise the
// target's host (without scheme, port or path), never the raw target string.
func ManagementAddress(inv *Inventory, target string) string {
	if ip := inv.Management.Management.IP.IPv4Address; net.ParseIP(ip) != nil {
		return ip
	}
	host := target
	if u, err := url.Parse(target); err == nil && u.Host != "" {
		host = u.Host
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return strings.TrimSuffix(host, "/")
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
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "a10 requires a password credential with a username")
	}
	opts := restjson.Options{VerifyTLS: restjson.BoolOption(options, optionVerify), CAPem: restjson.StringOption(options, optionCA)}
	anon, err := restjson.New(target.Value, defaultPort, restjson.Auth{}, opts)
	if err != nil {
		return collector.Observation{}, err
	}
	signature, err := Login(ctx, anon, cred.Fields[credUser], cred.Fields[credPassword])
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	opts.Headers = map[string]string{"Authorization": authScheme + signature}
	c, err := restjson.New(target.Value, defaultPort, restjson.Auth{}, opts)
	if err != nil {
		return collector.Observation{}, err
	}
	defer Logoff(ctx, c)
	inv, err := Walk(ctx, c)
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	return Emit(inv, target, time.Now().UTC()), nil
}
