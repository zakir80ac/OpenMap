// REQ-DISC-010 — Google Cloud collector: a service-account key signs an RS256 JWT that the OAuth token
// endpoint exchanges for a bearer token (RFC 7523), then Compute Engine (instances, networks,
// subnetworks, reserved addresses, forwarding rules), Cloud SQL instances and GKE clusters are read
// over REST. The project is the account; VPC networks, forwarding rules, SQL instances and clusters are
// cloud resources; instances become VMs with their NICs' addresses and subnets. Every endpoint base and
// the OAuth scope arrive as job options so sovereign or private-access deployments need no code change.
package gcp

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID  = "cloud_gcp"
	version      = "0.1.0"
	provider     = "gcp"
	evidenceKind = "api_response"
	defaultPort  = 443
	tokenTimeout = 30 * time.Second
	// Job options: endpoint bases and the OAuth scope (deployment facts, never literals here).
	optionTokenURL  = "tokenUrl"
	optionScope     = "scope"
	optionCompute   = "computeUrl"
	optionSQLAdmin  = "sqlAdminUrl"
	optionContainer = "containerUrl"
	credEmail       = "clientEmail"
	credPrivateKey  = "privateKeyPem"
	credType        = "service_account"
	jwtLifetime     = time.Hour
	grantJWTBearer  = "urn:ietf:params:oauth:grant-type:jwt-bearer"
	computeAPI      = "compute/v1"
	sqlAPI          = "sql/v1beta4"
	containerAPI    = "v1"
	allLocations    = "-"
	vrfInternet     = "internet"

	typeAccount  = "cloud_account"
	typeResource = "cloud_resource"
	typeVM       = "vm"
	typeSubnet   = "subnet"
	typeIP       = "ip_address"
	typeOS       = "operating_system"
	typeLB       = "load_balancer"
	typeDBClust  = "database_cluster"
	relMemberOf  = "member_of"
	relUsesIP    = "uses_ip"
	relInSubnet  = "in_subnet"
	relInstalled = "installed_on"
	relRunsOn    = "runs_on"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "cloud_gcp", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{credType},
		TargetKinds: []string{"account"}, Emits: []string{typeAccount, typeResource, typeVM, typeSubnet, typeIP, typeOS, typeLB, typeDBClust},
		ContractVersion: contract.Version,
	}
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// SignedJWT builds the RS256 assertion for the service account (RFC 7523 §2.1).
func SignedJWT(clientEmail, privateKeyPEM, scope, audience string, now time.Time) (string, error) {
	return SignedDelegatedJWT(clientEmail, privateKeyPEM, scope, audience, "", now)
}

// SignedDelegatedJWT is SignedJWT with Google Workspace domain-wide delegation: `subject` is the administrator the
// service account acts as (the `sub` claim); empty means no delegation.
func SignedDelegatedJWT(clientEmail, privateKeyPEM, scope, audience, subject string, now time.Time) (string, error) {
	block, _ := pem.Decode([]byte(privateKeyPEM))
	if block == nil {
		return "", errors.New("privateKeyPem holds no PEM block")
	}
	var key *rsa.PrivateKey
	if k, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		rsaKey, ok := k.(*rsa.PrivateKey)
		if !ok {
			return "", errors.New("service account key is not RSA")
		}
		key = rsaKey
	} else if k, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		key = k
	} else {
		return "", errors.New("service account key is neither PKCS#8 nor PKCS#1")
	}
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT"})
	claimSet := map[string]any{"iss": clientEmail, "scope": scope, "aud": audience, "iat": now.Unix(), "exp": now.Add(jwtLifetime).Unix()}
	if subject != "" {
		claimSet["sub"] = subject
	}
	claims, _ := json.Marshal(claimSet)
	signingInput := b64url(header) + "." + b64url(claims)
	digest := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signingInput + "." + b64url(sig), nil
}

// Token exchanges the assertion for a bearer token.
func Token(ctx context.Context, tokenURL, assertion string) (string, error) {
	form := url.Values{"grant_type": {grantJWTBearer}, "assertion": {assertion}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := &http.Client{Timeout: tokenTimeout, Transport: restjson.Transport(true)}
	res, err := client.Do(req)
	if err != nil {
		return "", collector.Errorf(contract.ErrUnreachable, true, "token endpoint: %v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		return "", collector.Errorf(contract.ErrAuthFailed, false, "token endpoint answered %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.AccessToken == "" {
		return "", collector.Errorf(contract.ErrParse, false, "token endpoint returned no access_token")
	}
	return out.AccessToken, nil
}

type accessConfig struct {
	NatIP string `json:"natIP"`
	Type  string `json:"type"`
}

type networkInterface struct {
	Network       string         `json:"network"`
	Subnetwork    string         `json:"subnetwork"`
	NetworkIP     string         `json:"networkIP"`
	AccessConfigs []accessConfig `json:"accessConfigs"`
}

type disk struct {
	Boot     bool     `json:"boot"`
	Licenses []string `json:"licenses"`
	DiskSize string   `json:"diskSizeGb"`
}

// Instance is one Compute Engine VM.
type Instance struct {
	ID                string             `json:"id"`
	Name              string             `json:"name"`
	Zone              string             `json:"zone"`
	MachineType       string             `json:"machineType"`
	Status            string             `json:"status"`
	CPUPlatform       string             `json:"cpuPlatform"`
	Hostname          string             `json:"hostname"`
	Labels            map[string]string  `json:"labels"`
	NetworkInterfaces []networkInterface `json:"networkInterfaces"`
	Disks             []disk             `json:"disks"`
	CreationTimestamp string             `json:"creationTimestamp"`
}

// Network is a VPC network.
type Network struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	SelfLink string `json:"selfLink"`
}

// Subnetwork is one regional subnet of a VPC.
type Subnetwork struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Region      string `json:"region"`
	Network     string `json:"network"`
	IPCidrRange string `json:"ipCidrRange"`
	SelfLink    string `json:"selfLink"`
}

// ForwardingRule is a load balancer frontend.
type ForwardingRule struct {
	ID                  string `json:"id"`
	Name                string `json:"name"`
	Region              string `json:"region"`
	IPAddress           string `json:"IPAddress"`
	IPProtocol          string `json:"IPProtocol"`
	PortRange           string `json:"portRange"`
	LoadBalancingScheme string `json:"loadBalancingScheme"`
	Target              string `json:"target"`
	BackendService      string `json:"backendService"`
}

// SQLInstance is a Cloud SQL instance.
type SQLInstance struct {
	Name            string `json:"name"`
	DatabaseVersion string `json:"databaseVersion"`
	Region          string `json:"region"`
	State           string `json:"state"`
	Tier            string `json:"-"`
	Settings        struct {
		Tier             string `json:"tier"`
		AvailabilityType string `json:"availabilityType"`
	} `json:"settings"`
	IPAddresses []struct {
		IPAddress string `json:"ipAddress"`
		Type      string `json:"type"`
	} `json:"ipAddresses"`
	ConnectionName string `json:"connectionName"`
}

// Cluster is a GKE cluster.
type Cluster struct {
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	Location             string `json:"location"`
	Status               string `json:"status"`
	CurrentMasterVersion string `json:"currentMasterVersion"`
	CurrentNodeCount     int    `json:"currentNodeCount"`
	Endpoint             string `json:"endpoint"`
	Network              string `json:"network"`
	Subnetwork           string `json:"subnetwork"`
}

// Inventory is everything the walk gathered for one project.
type Inventory struct {
	Project         string
	Instances       []Instance
	Networks        []Network
	Subnetworks     []Subnetwork
	ForwardingRules []ForwardingRule
	SQLInstances    []SQLInstance
	Clusters        []Cluster
	Raw             [][]byte
}

type aggregated[T any] struct {
	Items map[string]map[string]json.RawMessage `json:"items"`
	Next  string                                `json:"nextPageToken"`
}

// aggregatedList follows pageTokens of an aggregated/<resource> call and decodes the named list in each scope.
func aggregatedList[T any](ctx context.Context, c *restjson.Client, p string, listKey string) ([]T, error) {
	var out []T
	pageToken := ""
	for {
		q := ""
		if pageToken != "" {
			q = "?pageToken=" + url.QueryEscape(pageToken)
		}
		var page aggregated[T]
		if err := c.Get(ctx, p+q, &page); err != nil {
			return nil, err
		}
		for _, scope := range page.Items {
			raw, ok := scope[listKey]
			if !ok {
				continue
			}
			var items []T
			if err := json.Unmarshal(raw, &items); err != nil {
				return nil, collector.Errorf(contract.ErrParse, false, "%s: %v", p, err)
			}
			out = append(out, items...)
		}
		if page.Next == "" {
			return out, nil
		}
		pageToken = page.Next
	}
}

func listAll[T any](ctx context.Context, c *restjson.Client, p string, key string) ([]T, error) {
	var out []T
	pageToken := ""
	for {
		q := ""
		if pageToken != "" {
			q = "?pageToken=" + url.QueryEscape(pageToken)
		}
		var page map[string]json.RawMessage
		if err := c.Get(ctx, p+q, &page); err != nil {
			return nil, err
		}
		if raw, ok := page[key]; ok {
			var items []T
			if err := json.Unmarshal(raw, &items); err != nil {
				return nil, collector.Errorf(contract.ErrParse, false, "%s: %v", p, err)
			}
			out = append(out, items...)
		}
		var next string
		if raw, ok := page["nextPageToken"]; ok {
			_ = json.Unmarshal(raw, &next)
		}
		if next == "" {
			return out, nil
		}
		pageToken = next
	}
}

// Walk reads the project's compute, SQL and GKE inventory.
func Walk(ctx context.Context, project string, compute, sqladmin, container *restjson.Client) (*Inventory, error) {
	inv := &Inventory{Project: project}
	base := path.Join(computeAPI, "projects", project)
	var err error
	if inv.Instances, err = aggregatedList[Instance](ctx, compute, base+"/aggregated/instances", "instances"); err != nil {
		return nil, err
	}
	if inv.Networks, err = listAll[Network](ctx, compute, base+"/global/networks", "items"); err != nil {
		return nil, err
	}
	if inv.Subnetworks, err = aggregatedList[Subnetwork](ctx, compute, base+"/aggregated/subnetworks", "subnetworks"); err != nil {
		return nil, err
	}
	if inv.ForwardingRules, err = aggregatedList[ForwardingRule](ctx, compute, base+"/aggregated/forwardingRules", "forwardingRules"); err != nil && !restjson.IsNotFound(err) {
		return nil, err
	}
	if inv.SQLInstances, err = listAll[SQLInstance](ctx, sqladmin, path.Join(sqlAPI, "projects", project, "instances"), "items"); err != nil && !restjson.IsNotFound(err) {
		return nil, err
	}
	if inv.Clusters, err = listAll[Cluster](ctx, container, path.Join(containerAPI, "projects", project, "locations", allLocations, "clusters"), "clusters"); err != nil && !restjson.IsNotFound(err) {
		return nil, err
	}
	inv.Raw = append(append(compute.Raw(), sqladmin.Raw()...), container.Raw()...)
	return inv, nil
}

func last(selfLink string) string {
	i := strings.LastIndex(selfLink, "/")
	if i < 0 {
		return selfLink
	}
	return selfLink[i+1:]
}

func lower(s string) string { return strings.ToLower(s) }

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	accountIdentity := map[string]string{"provider": provider, "accountId": inv.Project}
	account := contract.CiRef{Type: typeAccount, Identity: accountIdentity}
	running := 0
	for _, i := range inv.Instances {
		if i.Status == "RUNNING" {
			running++
		}
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeAccount, Identity: accountIdentity, Name: inv.Project,
		Attributes: map[string]any{"provider": provider, "project": inv.Project, "instances": len(inv.Instances), "instancesRunning": running, "networks": len(inv.Networks), "subnetworks": len(inv.Subnetworks), "forwardingRules": len(inv.ForwardingRules), "sqlInstances": len(inv.SQLInstances), "gkeClusters": len(inv.Clusters)},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: inv.Project}}, ObservedAt: at})

	resource := func(id, name, kind, location string, attrs map[string]any) contract.CiRef {
		identity := map[string]string{"provider": provider, "resourceId": id}
		attrs["provider"] = provider
		attrs["resourceType"] = kind
		attrs["location"] = location
		attrs["project"] = inv.Project
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeResource, Identity: identity, Name: name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: id}}, ObservedAt: at})
		ref := contract.CiRef{Type: typeResource, Identity: identity}
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: account, Attributes: map[string]any{}, ObservedAt: at})
		return ref
	}

	// Compute refers to networks by self-link, GKE by short name: index both.
	networkRef := map[string]contract.CiRef{}
	for _, n := range inv.Networks {
		ref := resource(n.ID, n.Name, "compute.network", "global", map[string]any{"name": n.Name})
		networkRef[n.SelfLink] = ref
		networkRef[n.Name] = ref
	}
	subnetRef := map[string]contract.CiRef{}
	for _, s := range inv.Subnetworks {
		vrf := last(s.Network)
		identity := map[string]string{"cidr": s.IPCidrRange, "vrfRef": vrf}
		ref := contract.CiRef{Type: typeSubnet, Identity: identity}
		subnetRef[s.SelfLink] = ref
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeSubnet, Identity: identity, Name: vrf + "/" + s.Name, Attributes: map[string]any{"provider": provider, "name": s.Name, "region": last(s.Region), "network": vrf, "cidr": s.IPCidrRange, "project": inv.Project}, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: s.ID}}, ObservedAt: at})
		if net, ok := networkRef[s.Network]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: net, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	for _, i := range inv.Instances {
		zone := last(i.Zone)
		fqdn := lower(firstNonEmpty(i.Hostname, i.Name+"."+zone+".c."+inv.Project+".internal"))
		identity := map[string]string{"instanceUuid": i.ID, "hypervisorRef": provider + ":" + zone, "fqdn": fqdn}
		vmRef := contract.CiRef{Type: typeVM, Identity: identity}
		attrs := map[string]any{"provider": provider, "name": i.Name, "zone": zone, "machineType": last(i.MachineType), "status": lower(i.Status), "cpuPlatform": i.CPUPlatform, "labels": i.Labels, "created": i.CreationTimestamp, "project": inv.Project, "powerState": lower(i.Status)}
		switch i.Status {
		case "RUNNING":
			attrs["health"] = "healthy"
		case "TERMINATED", "STOPPED", "SUSPENDED":
			attrs["health"] = "down"
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVM, Identity: identity, Name: i.Name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: i.ID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: vmRef, To: account, Attributes: map[string]any{}, ObservedAt: at})
		for _, nic := range i.NetworkInterfaces {
			if nic.NetworkIP != "" {
				ipIdentity := map[string]string{"address": nic.NetworkIP, "vrfRef": last(nic.Network)}
				ipRef := contract.CiRef{Type: typeIP, Identity: ipIdentity}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: nic.NetworkIP, Attributes: map[string]any{"assignedTo": i.Name, "scope": "private", "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: ipRef, Attributes: map[string]any{}, ObservedAt: at})
				if sn, ok := subnetRef[nic.Subnetwork]; ok {
					obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInSubnet, From: ipRef, To: sn, Attributes: map[string]any{}, ObservedAt: at})
				}
			}
			for _, ac := range nic.AccessConfigs {
				if ac.NatIP == "" {
					continue
				}
				ipIdentity := map[string]string{"address": ac.NatIP, "vrfRef": vrfInternet}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: ac.NatIP, Attributes: map[string]any{"assignedTo": i.Name, "scope": "public", "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{"scope": "public"}, ObservedAt: at})
			}
		}
		for _, d := range i.Disks {
			if !d.Boot || len(d.Licenses) == 0 {
				continue
			}
			image := last(d.Licenses[len(d.Licenses)-1])
			family := "linux"
			if strings.Contains(image, "windows") {
				family = "windows"
			}
			osIdentity := map[string]string{"hostRef": i.ID, "family": family, "version": image}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: image, Attributes: map[string]any{"family": family, "license": d.Licenses[len(d.Licenses)-1], "provider": provider, "bootDiskGb": d.DiskSize}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalled, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: vmRef, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	for _, fr := range inv.ForwardingRules {
		identity := map[string]string{"serialNumber": provider + ":" + fr.ID, "managementIp": fr.IPAddress}
		lbRef := contract.CiRef{Type: typeLB, Identity: identity}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeLB, Identity: identity, Name: fr.Name, Attributes: map[string]any{"vendor": provider, "provider": provider, "model": "forwarding-rule", "scheme": fr.LoadBalancingScheme, "protocol": lower(fr.IPProtocol), "portRange": fr.PortRange, "region": last(fr.Region), "target": last(firstNonEmpty(fr.Target, fr.BackendService)), "managementIp": fr.IPAddress, "project": inv.Project}, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: fr.ID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: lbRef, To: account, Attributes: map[string]any{}, ObservedAt: at})
		if fr.IPAddress != "" {
			vrf := vrfInternet
			if fr.LoadBalancingScheme == "INTERNAL" || fr.LoadBalancingScheme == "INTERNAL_MANAGED" {
				vrf = inv.Project
			}
			ipIdentity := map[string]string{"address": fr.IPAddress, "vrfRef": vrf}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: fr.IPAddress, Attributes: map[string]any{"role": "vip", "assignedTo": fr.Name, "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: lbRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	for _, s := range inv.SQLInstances {
		identity := map[string]string{"clusterId": provider + ":" + inv.Project + ":" + s.Name}
		ref := contract.CiRef{Type: typeDBClust, Identity: identity}
		engine, ver, _ := strings.Cut(lower(s.DatabaseVersion), "_")
		attrs := map[string]any{"provider": provider, "engine": engine, "version": ver, "databaseVersion": s.DatabaseVersion, "region": s.Region, "state": lower(s.State), "tier": s.Settings.Tier, "availability": lower(s.Settings.AvailabilityType), "connectionName": s.ConnectionName, "managed": true, "project": inv.Project}
		if s.State == "RUNNABLE" {
			attrs["health"] = "healthy"
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeDBClust, Identity: identity, Name: s.Name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: s.ConnectionName}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: account, Attributes: map[string]any{}, ObservedAt: at})
		for _, ip := range s.IPAddresses {
			vrf := vrfInternet
			if ip.Type != "PRIMARY" {
				vrf = inv.Project
			}
			ipIdentity := map[string]string{"address": ip.IPAddress, "vrfRef": vrf}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: ip.IPAddress, Attributes: map[string]any{"assignedTo": s.Name, "scope": lower(ip.Type), "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: ref, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	for _, c := range inv.Clusters {
		attrs := map[string]any{"name": c.Name, "status": lower(c.Status), "masterVersion": c.CurrentMasterVersion, "nodeCount": c.CurrentNodeCount, "endpoint": c.Endpoint, "network": c.Network, "subnetwork": c.Subnetwork, "kubernetesApi": c.Endpoint}
		if c.Status == "RUNNING" {
			attrs["health"] = "healthy"
		}
		ref := resource(c.ID, c.Name, "container.cluster", c.Location, attrs)
		if net, ok := networkRef[c.Network]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: ref, To: net, Attributes: map[string]any{}, ObservedAt: at})
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

func requiredOption(options map[string]any, key string) (string, error) {
	v := restjson.StringOption(options, key)
	if v == "" {
		return "", collector.Errorf(contract.ErrInternal, false, "cloud_gcp job must set the %s option", key)
	}
	return v, nil
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	if cred == nil || cred.Type != credType || cred.Fields[credEmail] == "" || cred.Fields[credPrivateKey] == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "cloud_gcp requires a service_account credential with clientEmail and privateKeyPem")
	}
	tokenURL, err := requiredOption(options, optionTokenURL)
	if err != nil {
		return collector.Observation{}, err
	}
	scope, err := requiredOption(options, optionScope)
	if err != nil {
		return collector.Observation{}, err
	}
	bases := map[string]string{}
	for _, key := range []string{optionCompute, optionSQLAdmin, optionContainer} {
		if bases[key], err = requiredOption(options, key); err != nil {
			return collector.Observation{}, err
		}
	}
	assertion, err := SignedJWT(cred.Fields[credEmail], cred.Fields[credPrivateKey], scope, tokenURL, time.Now())
	if err != nil {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "service account key: %v", err)
	}
	token, err := Token(ctx, tokenURL, assertion)
	if err != nil {
		return collector.Observation{}, err
	}
	clients := map[string]*restjson.Client{}
	for key, base := range bases {
		c, err := restjson.New(base, defaultPort, restjson.Auth{Bearer: token}, restjson.Options{VerifyTLS: true, CAPem: restjson.StringOption(options, "caCertPem")})
		if err != nil {
			return collector.Observation{}, err
		}
		clients[key] = c
	}
	inv, err := Walk(ctx, strings.TrimPrefix(strings.TrimSpace(target.Value), "projects/"), clients[optionCompute], clients[optionSQLAdmin], clients[optionContainer])
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	return Emit(inv, time.Now().UTC()), nil
}
