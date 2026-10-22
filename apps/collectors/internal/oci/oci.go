// REQ-DISC-010 — Oracle Cloud Infrastructure collector: every request carries an OCI HTTP Signature
// (RSA-SHA256 over date, (request-target) and host, keyed by tenancy/user/fingerprint), the compartment
// tree is read from Identity, and Core (instances, VNIC attachments and VNICs, VCNs, subnets, images),
// Database (DB systems), Container Engine (OKE clusters) and Load Balancer APIs are listed per
// compartment with opc-next-page pagination. Endpoint bases are job options because they are regional
// and differ between commercial, government and dedicated regions.
package oci

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
	"strings"
	"sync"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID  = "cloud_oci"
	version      = "0.1.0"
	provider     = "oci"
	evidenceKind = "api_response"
	httpTimeout  = 60 * time.Second
	credType     = "api_key"
	credTenancy  = "tenancyOcid"
	credUser     = "userOcid"
	credFinger   = "fingerprint"
	credKey      = "privateKeyPem"
	// Job options: regional endpoint bases.
	optionIdentity  = "identityUrl"
	optionCore      = "coreUrl"
	optionDatabase  = "databaseUrl"
	optionContainer = "containerEngineUrl"
	optionLB        = "loadBalancerUrl"
	apiIdentity     = "/20160918"
	apiCore         = "/20160918"
	apiDatabase     = "/20160918"
	apiContainer    = "/20180222"
	apiLB           = "/20170115"
	nextPageHeader  = "opc-next-page"
	signedHeaders   = "date (request-target) host"
	vrfInternet     = "internet"
	vcnDNSSuffix    = ".oraclevcn.com"

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
		ID: collectorID, Family: "cloud_oci", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{credType},
		TargetKinds: []string{"account"}, Emits: []string{typeAccount, typeResource, typeVM, typeSubnet, typeIP, typeOS, typeLB, typeDBClust},
		ContractVersion: contract.Version,
	}
}

// Signer produces OCI request signatures.
type Signer struct {
	KeyID string
	key   *rsa.PrivateKey
}

// NewSigner parses the API key and composes the key id tenancy/user/fingerprint.
func NewSigner(tenancy, user, fingerprint, privateKeyPEM string) (*Signer, error) {
	block, _ := pem.Decode([]byte(privateKeyPEM))
	if block == nil {
		return nil, errors.New("privateKeyPem holds no PEM block")
	}
	var key *rsa.PrivateKey
	if k, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		rsaKey, ok := k.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("API key is not RSA")
		}
		key = rsaKey
	} else if k, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		key = k
	} else {
		return nil, errors.New("API key is neither PKCS#8 nor PKCS#1")
	}
	return &Signer{KeyID: tenancy + "/" + user + "/" + fingerprint, key: key}, nil
}

// SigningString is the canonical text OCI expects for a GET: date, (request-target) and host, in that order.
func SigningString(req *http.Request, date string) string {
	target := strings.ToLower(req.Method) + " " + req.URL.RequestURI()
	return "date: " + date + "\n(request-target): " + target + "\nhost: " + req.URL.Host
}

// Sign adds the Date and Authorization headers to a GET request.
func (s *Signer) Sign(req *http.Request, now time.Time) error {
	date := now.UTC().Format(http.TimeFormat)
	digest := sha256.Sum256([]byte(SigningString(req, date)))
	sig, err := rsa.SignPKCS1v15(rand.Reader, s.key, crypto.SHA256, digest[:])
	if err != nil {
		return err
	}
	req.Header.Set("Date", date)
	req.Header.Set("Authorization", `Signature version="1",keyId="`+s.KeyID+`",algorithm="rsa-sha256",headers="`+signedHeaders+`",signature="`+base64.StdEncoding.EncodeToString(sig)+`"`)
	return nil
}

// Client performs signed GETs against one regional service base and keeps raw bodies as evidence.
type Client struct {
	base   string
	signer *Signer
	http   *http.Client
	now    func() time.Time
	mu     sync.Mutex
	raw    [][]byte
}

func newClient(base string, signer *Signer, verify bool) *Client {
	return &Client{base: strings.TrimSuffix(base, "/"), signer: signer, http: &http.Client{Timeout: httpTimeout, Transport: restjson.Transport(verify)}, now: time.Now}
}

// getPage performs one signed GET and returns the next-page token, if any.
func (c *Client) getPage(ctx context.Context, path string, query url.Values, out any) (string, error) {
	u := c.base + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	if err := c.signer.Sign(req, c.now()); err != nil {
		return "", err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return "", restjson.Classify(req.URL.Host, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return "", restjson.Classify(req.URL.Host, err)
	}
	switch {
	case res.StatusCode == http.StatusUnauthorized:
		return "", collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the API key signature (%d)", req.URL.Host, res.StatusCode)
	case res.StatusCode == http.StatusForbidden:
		return "", collector.Errorf(contract.ErrPermissionDenied, false, "%s denied %s", req.URL.Host, path)
	case res.StatusCode == http.StatusNotFound:
		return "", collector.Errorf(contract.ErrUnsupportedDevice, false, "%s has no %s", req.URL.Host, path)
	case res.StatusCode == http.StatusTooManyRequests:
		return "", collector.Errorf(contract.ErrRateLimited, true, "%s rate limited %s", req.URL.Host, path)
	case res.StatusCode >= http.StatusBadRequest:
		return "", collector.Errorf(contract.ErrUnreachable, res.StatusCode >= http.StatusInternalServerError, "%s returned %d for %s", req.URL.Host, res.StatusCode, path)
	}
	c.mu.Lock()
	c.raw = append(c.raw, body)
	c.mu.Unlock()
	if out != nil && len(body) > 0 {
		if err := json.Unmarshal(body, out); err != nil {
			return "", collector.Errorf(contract.ErrParse, false, "%s: invalid JSON at %s: %v", req.URL.Host, path, err)
		}
	}
	return res.Header.Get(nextPageHeader), nil
}

// list follows opc-next-page until the list is exhausted.
func list[T any](ctx context.Context, c *Client, path string, query url.Values) ([]T, error) {
	var out []T
	page := ""
	for {
		q := url.Values{}
		for k, v := range query {
			q[k] = v
		}
		if page != "" {
			q.Set("page", page)
		}
		var items []T
		next, err := c.getPage(ctx, path, q, &items)
		if err != nil {
			return nil, err
		}
		out = append(out, items...)
		if next == "" {
			return out, nil
		}
		page = next
	}
}

func (c *Client) rawBodies() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([][]byte{}, c.raw...)
}

// Compartment is an Identity compartment.
type Compartment struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Description    string `json:"description"`
	LifecycleState string `json:"lifecycleState"`
}

// Instance is a Compute instance.
type Instance struct {
	ID                 string            `json:"id"`
	DisplayName        string            `json:"displayName"`
	CompartmentID      string            `json:"compartmentId"`
	AvailabilityDomain string            `json:"availabilityDomain"`
	Region             string            `json:"region"`
	Shape              string            `json:"shape"`
	LifecycleState     string            `json:"lifecycleState"`
	ImageID            string            `json:"imageId"`
	TimeCreated        string            `json:"timeCreated"`
	FreeformTags       map[string]string `json:"freeformTags"`
	ShapeConfig        struct {
		Ocpus       float64 `json:"ocpus"`
		MemoryInGBs float64 `json:"memoryInGBs"`
	} `json:"shapeConfig"`
}

type vnicAttachment struct {
	InstanceID string `json:"instanceId"`
	VnicID     string `json:"vnicId"`
	State      string `json:"lifecycleState"`
}

// Vnic is a virtual NIC with its addresses.
type Vnic struct {
	ID            string `json:"id"`
	SubnetID      string `json:"subnetId"`
	PrivateIP     string `json:"privateIp"`
	PublicIP      string `json:"publicIp"`
	HostnameLabel string `json:"hostnameLabel"`
	MacAddress    string `json:"macAddress"`
	IsPrimary     bool   `json:"isPrimary"`
}

// VCN is a virtual cloud network.
type VCN struct {
	ID            string `json:"id"`
	DisplayName   string `json:"displayName"`
	CidrBlock     string `json:"cidrBlock"`
	DNSLabel      string `json:"dnsLabel"`
	CompartmentID string `json:"compartmentId"`
}

// Subnet is a VCN subnet.
type Subnet struct {
	ID               string `json:"id"`
	DisplayName      string `json:"displayName"`
	CidrBlock        string `json:"cidrBlock"`
	VcnID            string `json:"vcnId"`
	DNSLabel         string `json:"dnsLabel"`
	ProhibitPublicIP bool   `json:"prohibitPublicIpOnVnic"`
}

// Image describes an instance's operating system.
type Image struct {
	ID                     string `json:"id"`
	DisplayName            string `json:"displayName"`
	OperatingSystem        string `json:"operatingSystem"`
	OperatingSystemVersion string `json:"operatingSystemVersion"`
}

// DBSystem is a Database service DB system.
type DBSystem struct {
	ID              string   `json:"id"`
	DisplayName     string   `json:"displayName"`
	Hostname        string   `json:"hostname"`
	Domain          string   `json:"domain"`
	Shape           string   `json:"shape"`
	DatabaseEdition string   `json:"databaseEdition"`
	Version         string   `json:"version"`
	LifecycleState  string   `json:"lifecycleState"`
	NodeCount       int      `json:"nodeCount"`
	SubnetID        string   `json:"subnetId"`
	ScanIPIDs       []string `json:"scanIpIds"`
}

// Cluster is an OKE cluster.
type Cluster struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	KubernetesVersion string `json:"kubernetesVersion"`
	LifecycleState    string `json:"lifecycleState"`
	VcnID             string `json:"vcnId"`
	Endpoints         struct {
		PrivateEndpoint string `json:"privateEndpoint"`
		PublicEndpoint  string `json:"publicEndpoint"`
	} `json:"endpoints"`
}

// LoadBalancer is a Load Balancer service instance.
type LoadBalancer struct {
	ID             string `json:"id"`
	DisplayName    string `json:"displayName"`
	ShapeName      string `json:"shapeName"`
	LifecycleState string `json:"lifecycleState"`
	IsPrivate      bool   `json:"isPrivate"`
	IPAddresses    []struct {
		IPAddress string `json:"ipAddress"`
		IsPublic  bool   `json:"isPublic"`
	} `json:"ipAddresses"`
	Listeners map[string]struct {
		Port     int
		Protocol string
	} `json:"listeners"`
	BackendSets map[string]struct {
		Policy   string `json:"policy"`
		Backends []struct {
			IPAddress string `json:"ipAddress"`
			Port      int    `json:"port"`
			Offline   bool   `json:"offline"`
		} `json:"backends"`
	} `json:"backendSets"`
}

// Inventory is everything gathered from one tenancy or compartment subtree.
type Inventory struct {
	Root          string
	Compartments  []Compartment
	Instances     []Instance
	Vnics         map[string][]Vnic // by instance id
	VCNs          []VCN
	Subnets       []Subnet
	Images        map[string]Image
	DBSystems     []DBSystem
	Clusters      []Cluster
	LoadBalancers []LoadBalancer
	Raw           [][]byte
}

// Clients holds one signed client per regional service.
type Clients struct {
	Identity, Core, Database, Container, LB *Client
}

// Walk lists the compartment subtree under root and every resource in each compartment.
func Walk(ctx context.Context, root string, c Clients) (*Inventory, error) {
	inv := &Inventory{Root: root, Vnics: map[string][]Vnic{}, Images: map[string]Image{}}
	comps, err := list[Compartment](ctx, c.Identity, apiIdentity+"/compartments", url.Values{"compartmentId": {root}, "compartmentIdInSubtree": {"true"}, "accessLevel": {"ANY"}, "lifecycleState": {"ACTIVE"}})
	if err != nil {
		return nil, err
	}
	inv.Compartments = comps
	scopes := []string{root}
	for _, comp := range comps {
		scopes = append(scopes, comp.ID)
	}
	for _, scope := range scopes {
		q := url.Values{"compartmentId": {scope}}
		instances, err := list[Instance](ctx, c.Core, apiCore+"/instances", q)
		if err != nil {
			return nil, err
		}
		inv.Instances = append(inv.Instances, instances...)
		attachments, err := list[vnicAttachment](ctx, c.Core, apiCore+"/vnicAttachments", q)
		if err != nil {
			return nil, err
		}
		for _, a := range attachments {
			if a.State != "ATTACHED" || a.VnicID == "" {
				continue
			}
			var v Vnic
			if _, err := c.Core.getPage(ctx, apiCore+"/vnics/"+a.VnicID, nil, &v); err != nil {
				return nil, err
			}
			inv.Vnics[a.InstanceID] = append(inv.Vnics[a.InstanceID], v)
		}
		vcns, err := list[VCN](ctx, c.Core, apiCore+"/vcns", q)
		if err != nil {
			return nil, err
		}
		inv.VCNs = append(inv.VCNs, vcns...)
		subnets, err := list[Subnet](ctx, c.Core, apiCore+"/subnets", q)
		if err != nil {
			return nil, err
		}
		inv.Subnets = append(inv.Subnets, subnets...)
		if c.Database != nil {
			dbs, err := list[DBSystem](ctx, c.Database, apiDatabase+"/dbSystems", q)
			if err != nil && !isNotFound(err) {
				return nil, err
			}
			inv.DBSystems = append(inv.DBSystems, dbs...)
		}
		if c.Container != nil {
			clusters, err := list[Cluster](ctx, c.Container, apiContainer+"/clusters", q)
			if err != nil && !isNotFound(err) {
				return nil, err
			}
			inv.Clusters = append(inv.Clusters, clusters...)
		}
		if c.LB != nil {
			lbs, err := list[LoadBalancer](ctx, c.LB, apiLB+"/loadBalancers", q)
			if err != nil && !isNotFound(err) {
				return nil, err
			}
			inv.LoadBalancers = append(inv.LoadBalancers, lbs...)
		}
	}
	for _, i := range inv.Instances {
		if i.ImageID == "" {
			continue
		}
		if _, done := inv.Images[i.ImageID]; done {
			continue
		}
		var img Image
		if _, err := c.Core.getPage(ctx, apiCore+"/images/"+i.ImageID, nil, &img); err != nil {
			if isNotFound(err) {
				continue
			}
			return nil, err
		}
		inv.Images[i.ImageID] = img
	}
	for _, cl := range []*Client{c.Identity, c.Core, c.Database, c.Container, c.LB} {
		if cl != nil {
			inv.Raw = append(inv.Raw, cl.rawBodies()...)
		}
	}
	return inv, nil
}

func isNotFound(err error) bool {
	var te *collector.TargetError
	return errors.As(err, &te) && te.Code == contract.ErrUnsupportedDevice
}

func lower(s string) string { return strings.ToLower(s) }

func healthFromState(state string) (string, bool) {
	switch state {
	case "RUNNING", "AVAILABLE", "ACTIVE":
		return "healthy", true
	case "STOPPED", "TERMINATED", "FAILED", "DELETED":
		return "down", true
	case "PROVISIONING", "STARTING", "STOPPING", "UPDATING", "CREATING":
		return "degraded", true
	}
	return "", false
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	accountIdentity := map[string]string{"provider": provider, "accountId": inv.Root}
	account := contract.CiRef{Type: typeAccount, Identity: accountIdentity}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeAccount, Identity: accountIdentity, Name: inv.Root,
		Attributes: map[string]any{"provider": provider, "compartments": len(inv.Compartments), "instances": len(inv.Instances), "vcns": len(inv.VCNs), "subnets": len(inv.Subnets), "dbSystems": len(inv.DBSystems), "okeClusters": len(inv.Clusters), "loadBalancers": len(inv.LoadBalancers)},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: inv.Root}}, ObservedAt: at})

	resource := func(id, name, kind string, attrs map[string]any) contract.CiRef {
		identity := map[string]string{"provider": provider, "resourceId": id}
		attrs["provider"] = provider
		attrs["resourceType"] = kind
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeResource, Identity: identity, Name: name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: id}}, ObservedAt: at})
		ref := contract.CiRef{Type: typeResource, Identity: identity}
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: account, Attributes: map[string]any{}, ObservedAt: at})
		return ref
	}
	compartmentRef := map[string]contract.CiRef{}
	for _, comp := range inv.Compartments {
		compartmentRef[comp.ID] = resource(comp.ID, comp.Name, "identity.compartment", map[string]any{"description": comp.Description, "state": lower(comp.LifecycleState)})
	}
	vcnByID := map[string]VCN{}
	vcnRef := map[string]contract.CiRef{}
	for _, v := range inv.VCNs {
		vcnByID[v.ID] = v
		vcnRef[v.ID] = resource(v.ID, v.DisplayName, "core.vcn", map[string]any{"cidr": v.CidrBlock, "dnsLabel": v.DNSLabel, "compartment": v.CompartmentID})
	}
	subnetByID := map[string]Subnet{}
	subnetRef := map[string]contract.CiRef{}
	for _, s := range inv.Subnets {
		subnetByID[s.ID] = s
		vrf := firstNonEmpty(vcnByID[s.VcnID].DisplayName, s.VcnID)
		identity := map[string]string{"cidr": s.CidrBlock, "vrfRef": vrf}
		ref := contract.CiRef{Type: typeSubnet, Identity: identity}
		subnetRef[s.ID] = ref
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeSubnet, Identity: identity, Name: vrf + "/" + s.DisplayName, Attributes: map[string]any{"provider": provider, "name": s.DisplayName, "vcn": vrf, "cidr": s.CidrBlock, "dnsLabel": s.DNSLabel, "publicIpProhibited": s.ProhibitPublicIP}, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: s.ID}}, ObservedAt: at})
		if vr, ok := vcnRef[s.VcnID]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: vr, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	for _, i := range inv.Instances {
		vnics := inv.Vnics[i.ID]
		fqdn := lower(i.DisplayName)
		for _, v := range vnics {
			sn, ok := subnetByID[v.SubnetID]
			if v.IsPrimary && v.HostnameLabel != "" && ok && sn.DNSLabel != "" {
				if vcn, ok := vcnByID[sn.VcnID]; ok && vcn.DNSLabel != "" {
					fqdn = lower(v.HostnameLabel + "." + sn.DNSLabel + "." + vcn.DNSLabel + vcnDNSSuffix)
				}
			}
		}
		identity := map[string]string{"instanceUuid": i.ID, "hypervisorRef": provider + ":" + lower(i.AvailabilityDomain), "fqdn": fqdn}
		vmRef := contract.CiRef{Type: typeVM, Identity: identity}
		attrs := map[string]any{"provider": provider, "name": i.DisplayName, "availabilityDomain": i.AvailabilityDomain, "region": i.Region, "shape": i.Shape, "ocpus": i.ShapeConfig.Ocpus, "memoryGb": i.ShapeConfig.MemoryInGBs, "powerState": lower(i.LifecycleState), "created": i.TimeCreated, "tags": i.FreeformTags, "compartment": i.CompartmentID}
		if h, ok := healthFromState(i.LifecycleState); ok {
			attrs["health"] = h
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVM, Identity: identity, Name: i.DisplayName, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: i.ID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: vmRef, To: account, Attributes: map[string]any{}, ObservedAt: at})
		if cr, ok := compartmentRef[i.CompartmentID]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: vmRef, To: cr, Attributes: map[string]any{}, ObservedAt: at})
		}
		for _, v := range vnics {
			vrf := firstNonEmpty(vcnByID[subnetByID[v.SubnetID].VcnID].DisplayName, subnetByID[v.SubnetID].VcnID)
			if v.PrivateIP != "" {
				ipIdentity := map[string]string{"address": v.PrivateIP, "vrfRef": vrf}
				ipRef := contract.CiRef{Type: typeIP, Identity: ipIdentity}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: v.PrivateIP, Attributes: map[string]any{"assignedTo": i.DisplayName, "scope": "private", "mac": lower(v.MacAddress), "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: ipRef, Attributes: map[string]any{}, ObservedAt: at})
				if sr, ok := subnetRef[v.SubnetID]; ok {
					obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInSubnet, From: ipRef, To: sr, Attributes: map[string]any{}, ObservedAt: at})
				}
			}
			if v.PublicIP != "" {
				ipIdentity := map[string]string{"address": v.PublicIP, "vrfRef": vrfInternet}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: v.PublicIP, Attributes: map[string]any{"assignedTo": i.DisplayName, "scope": "public", "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{"scope": "public"}, ObservedAt: at})
			}
		}
		if img, ok := inv.Images[i.ImageID]; ok && img.OperatingSystem != "" {
			family := "linux"
			if strings.Contains(lower(img.OperatingSystem), "windows") {
				family = "windows"
			}
			osIdentity := map[string]string{"hostRef": i.ID, "family": family, "version": img.OperatingSystem + " " + img.OperatingSystemVersion}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: osIdentity["version"], Attributes: map[string]any{"family": family, "image": img.DisplayName, "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: img.ID}}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalled, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: vmRef, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	for _, db := range inv.DBSystems {
		identity := map[string]string{"clusterId": db.ID}
		ref := contract.CiRef{Type: typeDBClust, Identity: identity}
		attrs := map[string]any{"provider": provider, "engine": "oracle", "edition": db.DatabaseEdition, "version": db.Version, "shape": db.Shape, "nodeCount": db.NodeCount, "state": lower(db.LifecycleState), "fqdn": lower(firstNonEmpty(db.Hostname+"."+db.Domain, db.DisplayName)), "managed": true}
		if h, ok := healthFromState(db.LifecycleState); ok {
			attrs["health"] = h
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeDBClust, Identity: identity, Name: db.DisplayName, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: db.ID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: account, Attributes: map[string]any{}, ObservedAt: at})
		if sr, ok := subnetRef[db.SubnetID]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: ref, To: sr, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	for _, cl := range inv.Clusters {
		attrs := map[string]any{"name": cl.Name, "kubernetesVersion": cl.KubernetesVersion, "state": lower(cl.LifecycleState), "privateEndpoint": cl.Endpoints.PrivateEndpoint, "publicEndpoint": cl.Endpoints.PublicEndpoint, "kubernetesApi": firstNonEmpty(cl.Endpoints.PrivateEndpoint, cl.Endpoints.PublicEndpoint)}
		if h, ok := healthFromState(cl.LifecycleState); ok {
			attrs["health"] = h
		}
		ref := resource(cl.ID, cl.Name, "containerengine.cluster", attrs)
		if vr, ok := vcnRef[cl.VcnID]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: ref, To: vr, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	for _, lb := range inv.LoadBalancers {
		mgmt := ""
		for _, ip := range lb.IPAddresses {
			if mgmt == "" || ip.IsPublic {
				mgmt = ip.IPAddress
			}
		}
		identity := map[string]string{"serialNumber": provider + ":" + lb.ID, "managementIp": mgmt}
		lbRef := contract.CiRef{Type: typeLB, Identity: identity}
		listeners := make([]map[string]any, 0, len(lb.Listeners))
		for name, l := range lb.Listeners {
			listeners = append(listeners, map[string]any{"name": name, "port": l.Port, "protocol": lower(l.Protocol)})
		}
		backendSets := make([]map[string]any, 0, len(lb.BackendSets))
		for name, bs := range lb.BackendSets {
			online := 0
			for _, b := range bs.Backends {
				if !b.Offline {
					online++
				}
			}
			backendSets = append(backendSets, map[string]any{"name": name, "policy": lower(bs.Policy), "members": len(bs.Backends), "online": online})
		}
		attrs := map[string]any{"vendor": provider, "provider": provider, "model": lb.ShapeName, "private": lb.IsPrivate, "state": lower(lb.LifecycleState), "listeners": listeners, "backendSets": backendSets, "managementIp": mgmt}
		if h, ok := healthFromState(lb.LifecycleState); ok {
			attrs["health"] = h
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeLB, Identity: identity, Name: lb.DisplayName, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: lb.ID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: lbRef, To: account, Attributes: map[string]any{}, ObservedAt: at})
		for _, ip := range lb.IPAddresses {
			vrf := vrfInternet
			if !ip.IsPublic {
				vrf = inv.Root
			}
			ipIdentity := map[string]string{"address": ip.IPAddress, "vrfRef": vrf}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: ip.IPAddress, Attributes: map[string]any{"role": "vip", "assignedTo": lb.DisplayName, "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: lbRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
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
	if cred == nil || cred.Type != credType || cred.Fields[credTenancy] == "" || cred.Fields[credUser] == "" || cred.Fields[credFinger] == "" || cred.Fields[credKey] == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "cloud_oci requires an api_key credential with tenancyOcid, userOcid, fingerprint and privateKeyPem")
	}
	signer, err := NewSigner(cred.Fields[credTenancy], cred.Fields[credUser], cred.Fields[credFinger], cred.Fields[credKey])
	if err != nil {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "API key: %v", err)
	}
	identity := restjson.StringOption(options, optionIdentity)
	core := restjson.StringOption(options, optionCore)
	if identity == "" || core == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrInternal, false, "cloud_oci job must set the %s and %s options", optionIdentity, optionCore)
	}
	// Regional OCI endpoints present publicly trusted certificates; dedicated regions with a private CA supply it
	// through caCertPem, which restjson trusts beside the system roots.
	verify := true
	clients := Clients{Identity: newClient(identity, signer, verify), Core: newClient(core, signer, verify)}
	if v := restjson.StringOption(options, optionDatabase); v != "" {
		clients.Database = newClient(v, signer, verify)
	}
	if v := restjson.StringOption(options, optionContainer); v != "" {
		clients.Container = newClient(v, signer, verify)
	}
	if v := restjson.StringOption(options, optionLB); v != "" {
		clients.LB = newClient(v, signer, verify)
	}
	root := firstNonEmpty(strings.TrimSpace(target.Value), cred.Fields[credTenancy])
	inv, err := Walk(ctx, root, clients)
	if err != nil {
		return collector.Observation{}, restjson.Classify(root, err)
	}
	return Emit(inv, time.Now().UTC()), nil
}
