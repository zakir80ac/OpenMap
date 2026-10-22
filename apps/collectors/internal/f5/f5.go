// REQ-DISC-018 — F5 BIG-IP collector over iControl REST: device facts (serial, platform, version,
// failover state), every LTM virtual server as a listening service with its VIP, pools with their
// members and health, and nodes. Member endpoints become listening services on the member hosts so
// the dependency map shows what sits behind each VIP. Basic auth by default; token auth optional.
package f5

import (
	"context"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID     = "load_balancer"
	version         = "0.1.0"
	vendor          = "f5"
	evidenceKind    = "api_response"
	defaultPort     = 443
	optionVerify    = "verifyTls"
	optionCA        = "caCertPem"
	optionTokenAuth = "tokenAuth"
	credUser        = "username"
	credPassword    = "password"
	tokenHeader     = "X-F5-Auth-Token"
	defaultVrf      = "default"
	loginProvider   = "tmos"

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

type items[T any] struct {
	Items []T `json:"items"`
}

type device struct {
	Hostname      string   `json:"hostname"`
	ManagementIP  string   `json:"managementIp"`
	MarketingName string   `json:"marketingName"`
	PlatformID    string   `json:"platformId"`
	ChassisID     string   `json:"chassisId"`
	Version       string   `json:"version"`
	Build         string   `json:"build"`
	Edition       string   `json:"edition"`
	FailoverState string   `json:"failoverState"`
	BaseMac       string   `json:"baseMac"`
	SelfDevice    string   `json:"selfDevice"`
	ActiveModules []string `json:"activeModules"`
}

type virtual struct {
	Name        string   `json:"name"`
	Partition   string   `json:"partition"`
	FullPath    string   `json:"fullPath"`
	Destination string   `json:"destination"`
	IPProtocol  string   `json:"ipProtocol"`
	Pool        string   `json:"pool"`
	Enabled     bool     `json:"enabled"`
	Disabled    bool     `json:"disabled"`
	Description string   `json:"description"`
	Rules       []string `json:"rules"`
	Profiles    struct {
		Items []struct {
			Name string `json:"name"`
		} `json:"items"`
	} `json:"profilesReference"`
}

type member struct {
	Name          string `json:"name"`
	Address       string `json:"address"`
	State         string `json:"state"`
	Session       string `json:"session"`
	Ratio         int    `json:"ratio"`
	PriorityGroup int    `json:"priorityGroup"`
}

type pool struct {
	Name              string `json:"name"`
	FullPath          string `json:"fullPath"`
	LoadBalancingMode string `json:"loadBalancingMode"`
	Monitor           string `json:"monitor"`
	Members           struct {
		Items []member `json:"items"`
	} `json:"membersReference"`
}

type node struct {
	Name    string `json:"name"`
	Address string `json:"address"`
	State   string `json:"state"`
	FQDN    struct {
		TMName string `json:"tmName"`
	} `json:"fqdn"`
}

// Inventory is one BIG-IP's content.
type Inventory struct {
	Device   device
	Virtuals []virtual
	Pools    []pool
	Nodes    []node
	Raw      [][]byte
}

// Login exchanges a password for an iControl token when the job asks for token auth.
func Login(ctx context.Context, c *restjson.Client, user, password string) (string, error) {
	var res struct {
		Token struct {
			Token string `json:"token"`
		} `json:"token"`
	}
	if err := c.Post(ctx, "/mgmt/shared/authn/login", map[string]string{"username": user, "password": password, "loginProviderName": loginProvider}, &res); err != nil {
		return "", err
	}
	if res.Token.Token == "" {
		return "", collector.Errorf(contract.ErrAuthFailed, false, "login returned no token")
	}
	return res.Token.Token, nil
}

// Walk reads device, virtuals (with profiles), pools (with members) and nodes.
func Walk(ctx context.Context, c *restjson.Client) (*Inventory, error) {
	inv := &Inventory{}
	var devices items[device]
	if err := c.Get(ctx, "/mgmt/tm/cm/device", &devices); err != nil {
		return nil, err
	}
	for _, d := range devices.Items {
		if d.SelfDevice == "true" || inv.Device.Hostname == "" {
			inv.Device = d
		}
	}
	var virtuals items[virtual]
	if err := c.Get(ctx, "/mgmt/tm/ltm/virtual?expandSubcollections=true", &virtuals); err != nil {
		return nil, err
	}
	inv.Virtuals = virtuals.Items
	var pools items[pool]
	if err := c.Get(ctx, "/mgmt/tm/ltm/pool?expandSubcollections=true", &pools); err != nil {
		return nil, err
	}
	inv.Pools = pools.Items
	var nodes items[node]
	if err := c.Get(ctx, "/mgmt/tm/ltm/node", &nodes); err == nil {
		inv.Nodes = nodes.Items
	}
	inv.Raw = c.Raw()
	return inv, nil
}

// SplitDestination parses "/Common/10.1.1.10:443" or "/Common/2001:db8::10.443" into address and port.
func SplitDestination(dest string) (string, int) {
	d := dest
	if i := strings.LastIndex(d, "/"); i >= 0 {
		d = d[i+1:]
	}
	if i := strings.LastIndex(d, "%"); i >= 0 { // route domain suffix: 10.1.1.10%2:443
		rest := d[i:]
		if j := strings.Index(rest, ":"); j >= 0 {
			d = d[:i] + rest[j:]
		} else {
			d = d[:i]
		}
	}
	sep := strings.LastIndex(d, ":")
	if strings.Count(d, ":") > 1 { // IPv6 uses '.' before the port
		sep = strings.LastIndex(d, ".")
	}
	if sep < 0 {
		return d, 0
	}
	port, _ := strconv.Atoi(d[sep+1:])
	return d[:sep], port
}

// memberPort parses "web01:80" (name may be an fqdn or address).
func memberPort(name string) int {
	sep := strings.LastIndex(name, ":")
	if strings.Count(name, ":") > 1 {
		sep = strings.LastIndex(name, ".")
	}
	if sep < 0 {
		return 0
	}
	p, _ := strconv.Atoi(name[sep+1:])
	return p
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	d := inv.Device
	lbRef := strings.ToLower(firstNonEmpty(d.Hostname, target.Value))
	lbIdentity := map[string]string{"serialNumber": firstNonEmpty(d.ChassisID, lbRef), "managementIp": firstNonEmpty(d.ManagementIP, target.Value)}
	lb := contract.CiRef{Type: typeLB, Identity: lbIdentity}
	up := 0
	for _, v := range inv.Virtuals {
		if v.Enabled && !v.Disabled {
			up++
		}
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeLB, Identity: lbIdentity, Name: lbRef,
		Attributes: map[string]any{"vendor": vendor, "model": firstNonEmpty(d.MarketingName, d.PlatformID), "platformId": d.PlatformID, "version": d.Version, "build": d.Build, "edition": d.Edition, "failoverState": d.FailoverState, "baseMac": strings.ToLower(d.BaseMac), "activeModules": d.ActiveModules, "virtualServers": len(inv.Virtuals), "virtualServersEnabled": up, "pools": len(inv.Pools), "nodes": len(inv.Nodes), "managementIp": d.ManagementIP, "fqdn": d.Hostname},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: d.ChassisID}}, ObservedAt: at})
	nodeFQDN := map[string]string{}
	for _, n := range inv.Nodes {
		if n.FQDN.TMName != "" {
			nodeFQDN[n.Address] = strings.ToLower(n.FQDN.TMName)
		}
	}
	poolByPath := map[string]pool{}
	for _, p := range inv.Pools {
		poolByPath[p.FullPath] = p
		poolByPath[p.Name] = p
	}
	memberSeen := map[string]bool{}
	for _, v := range inv.Virtuals {
		addr, port := SplitDestination(v.Destination)
		proto := strings.ToLower(firstNonEmpty(v.IPProtocol, "tcp"))
		if proto == "any" {
			proto = "ip"
		}
		identity := map[string]string{"hostRef": lbRef, "protocol": proto, "port": strconv.Itoa(port)}
		if port == 0 {
			identity["port"] = v.Name
		}
		profiles := []string{}
		for _, p := range v.Profiles.Items {
			profiles = append(profiles, p.Name)
		}
		vs := contract.CiRef{Type: typeListener, Identity: identity}
		p, hasPool := poolByPath[v.Pool]
		attrs := map[string]any{"vendor": vendor, "virtualServer": v.FullPath, "partition": v.Partition, "destination": addr, "protocol": proto, "port": port, "enabled": v.Enabled && !v.Disabled, "pool": v.Pool, "profiles": profiles, "irules": v.Rules, "description": v.Description, "service": "load-balanced-vip", "source": collectorID}
		if hasPool {
			attrs["loadBalancingMode"] = p.LoadBalancingMode
			attrs["monitor"] = p.Monitor
			attrs["memberCount"] = len(p.Members.Items)
			upMembers := 0
			for _, m := range p.Members.Items {
				if m.State == "up" {
					upMembers++
				}
			}
			attrs["membersUp"] = upMembers
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: identity, Name: v.Name + " (" + addr + ":" + strconv.Itoa(port) + ")", Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: vendor, ID: v.FullPath}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: lb, To: vs, Attributes: map[string]any{}, ObservedAt: at})
		if net.ParseIP(addr) != nil && !strings.HasPrefix(addr, "0.0.0.0") {
			ipIdentity := map[string]string{"address": addr, "vrfRef": defaultVrf}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: addr, Attributes: map[string]any{"role": "vip", "assignedTo": lbRef, "virtualServer": v.FullPath, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vs, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
		}
		if !hasPool {
			continue
		}
		for _, m := range p.Members.Items {
			mport := memberPort(m.Name)
			if m.Address == "" || mport == 0 {
				continue
			}
			mIdentity := map[string]string{"hostRef": strings.ToLower(firstNonEmpty(nodeFQDN[m.Address], m.Address)), "protocol": proto, "port": strconv.Itoa(mport)}
			mRef := contract.CiRef{Type: typeListener, Identity: mIdentity}
			key := mIdentity["hostRef"] + "|" + proto + "|" + mIdentity["port"]
			if !memberSeen[key] {
				memberSeen[key] = true
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: mIdentity, Name: m.Name, Attributes: map[string]any{"protocol": proto, "port": mport, "address": m.Address, "poolMemberState": m.State, "session": m.Session, "ratio": m.Ratio, "priorityGroup": m.PriorityGroup, "pool": p.FullPath, "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				ipIdentity := map[string]string{"address": m.Address, "vrfRef": defaultVrf}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: m.Address, Attributes: map[string]any{"role": "pool-member", "source": collectorID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: mRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
				if fqdn, ok := nodeFQDN[m.Address]; ok {
					obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: mRef, To: contract.CiRef{Type: typeHost, Identity: map[string]string{"fqdn": fqdn}}, Attributes: map[string]any{}, ObservedAt: at})
				}
			}
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relDependsOn, From: vs, To: mRef, Attributes: map[string]any{"pool": p.FullPath, "state": m.State, "ratio": m.Ratio}, ObservedAt: at})
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
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "f5 requires a password credential with a username")
	}
	opts := restjson.Options{VerifyTLS: restjson.BoolOption(options, optionVerify), CAPem: restjson.StringOption(options, optionCA)}
	c, err := restjson.New(target.Value, defaultPort, restjson.Auth{User: cred.Fields[credUser], Pass: cred.Fields[credPassword]}, opts)
	if err != nil {
		return collector.Observation{}, err
	}
	if restjson.BoolOption(options, optionTokenAuth) {
		token, err := Login(ctx, c, cred.Fields[credUser], cred.Fields[credPassword])
		if err != nil {
			return collector.Observation{}, restjson.Classify(target.Value, err)
		}
		opts.Headers = map[string]string{tokenHeader: token}
		if c, err = restjson.New(target.Value, defaultPort, restjson.Auth{}, opts); err != nil {
			return collector.Observation{}, err
		}
	}
	inv, err := Walk(ctx, c)
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	return Emit(inv, target, time.Now().UTC()), nil
}
