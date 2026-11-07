// REQ-DISC-010 — Alibaba Cloud collector: RPC-style APIs (ECS instances, VPCs and VSwitches; RDS
// instances; SLB load balancers) signed with HMAC-SHA1 over the canonicalised query, and the ROA-style
// Container Service API (ACK clusters) signed over the canonical headers and resource. The account
// alias or id is the cloud account; VPCs and ACK clusters are cloud resources; VSwitches become
// subnets; ECS instances become VMs with private, public and EIP addresses and their OS. Regional
// endpoint bases are job options, so Alibaba Cloud International, Mainland and Financial Cloud deployments
// differ only in configuration.
package alibaba

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // Alibaba Cloud's RPC signature algorithm is HMAC-SHA1 by specification.
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID    = "cloud_alibaba"
	version        = "0.1.0"
	provider       = "alibaba"
	evidenceKind   = "api_response"
	httpTimeout    = 60 * time.Second
	credType       = "access_key"
	credKeyID      = "accessKeyId"
	credSecret     = "accessKeySecret"
	optionRegion   = "regionId"
	optionECS      = "ecsUrl"
	optionRDS      = "rdsUrl"
	optionSLB      = "slbUrl"
	optionCS       = "csUrl"
	optionCA       = "caCertPem" // private CA of Financial Cloud, Apsara Stack or a proxy
	ecsVersion     = "2014-05-26"
	rdsVersion     = "2014-08-15"
	slbVersion     = "2014-05-15"
	csClustersPath = "/api/v1/clusters"
	csVersion      = "2015-12-15"
	pageSize       = 100
	nonceBytes     = 16
	timestampFmt   = "2006-01-02T15:04:05Z"
	vrfInternet    = "internet"

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
		ID: collectorID, Family: "cloud_alibaba", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{credType},
		TargetKinds: []string{"account"}, Emits: []string{typeAccount, typeResource, typeVM, typeSubnet, typeIP, typeOS, typeLB, typeDBClust},
		ContractVersion: contract.Version,
	}
}

// percentEncode follows the RFC 3986 variant Alibaba's RPC signature requires.
func percentEncode(s string) string {
	e := url.QueryEscape(s)
	e = strings.ReplaceAll(e, "+", "%20")
	e = strings.ReplaceAll(e, "*", "%2A")
	e = strings.ReplaceAll(e, "%7E", "~")
	return e
}

func nonce() string {
	b := make([]byte, nonceBytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// RPCSignature computes the HMAC-SHA1 signature over the sorted, percent-encoded parameters.
func RPCSignature(method string, params map[string]string, secret string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		if k != "Signature" {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var canonical strings.Builder
	for i, k := range keys {
		if i > 0 {
			canonical.WriteByte('&')
		}
		canonical.WriteString(percentEncode(k) + "=" + percentEncode(params[k]))
	}
	stringToSign := method + "&" + percentEncode("/") + "&" + percentEncode(canonical.String())
	mac := hmac.New(sha1.New, []byte(secret+"&"))
	mac.Write([]byte(stringToSign))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// ROASignature signs a Container Service GET: method, accept, content-md5, content-type, date, x-acs headers, resource.
func ROASignature(method, accept, date string, acsHeaders map[string]string, resource string, secret string) string {
	keys := make([]string, 0, len(acsHeaders))
	for k := range acsHeaders {
		keys = append(keys, strings.ToLower(k))
	}
	sort.Strings(keys)
	var canonicalHeaders strings.Builder
	for _, k := range keys {
		canonicalHeaders.WriteString(k + ":" + acsHeaders[k] + "\n")
	}
	stringToSign := method + "\n" + accept + "\n" + "\n" + "\n" + date + "\n" + canonicalHeaders.String() + resource
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(stringToSign))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// Client issues signed calls against one product endpoint.
type Client struct {
	base   string
	keyID  string
	secret string
	http   *http.Client
	now    func() time.Time
	mu     sync.Mutex
	raw    [][]byte
}

// newClient builds a client for one product endpoint; a non-empty caPem becomes the trust anchor (Financial Cloud,
// Apsara Stack and proxies sit behind private CAs).
func newClient(base, keyID, secret, caPem string) (*Client, error) {
	transport, err := restjson.TransportFor(true, caPem)
	if err != nil {
		return nil, err
	}
	return &Client{base: strings.TrimSuffix(base, "/"), keyID: keyID, secret: secret, http: &http.Client{Timeout: httpTimeout, Transport: transport}, now: time.Now}, nil
}

// errorCode is the Code (RPC) or code (ROA) of an Alibaba Cloud error body.
func errorCode(body []byte) string {
	var e struct {
		Code    string `json:"Code"`
		CodeROA string `json:"code"`
	}
	if json.Unmarshal(body, &e) != nil {
		return ""
	}
	return firstNonEmpty(e.Code, e.CodeROA)
}

// credentialCodes are the error codes Alibaba Cloud answers with HTTP 400 or 404 when the access key or its
// signature is wrong (InvalidAccessKeyId.NotFound, SignatureDoesNotMatch, IncompleteSignature, InvalidTimeStamp.*,
// SignatureNonceUsed): they are credential failures, not unreachable or unsupported endpoints.
var credentialCodes = []string{"InvalidAccessKeyId", "SignatureDoesNotMatch", "IncompleteSignature", "InvalidTimeStamp", "SignatureNonceUsed"}

func (c *Client) classify(res *http.Response, body []byte, what string) error {
	host := c.base
	if res.StatusCode >= http.StatusBadRequest {
		code := errorCode(body)
		for _, prefix := range credentialCodes {
			if strings.HasPrefix(code, prefix) {
				return collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the access key for %s (%s)", host, what, code)
			}
		}
		if strings.HasPrefix(code, "Forbidden") {
			return collector.Errorf(contract.ErrPermissionDenied, false, "%s denied %s (%s)", host, what, code)
		}
	}
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the access key for %s (%d): %s", host, what, res.StatusCode, strings.TrimSpace(string(body)))
	case res.StatusCode == http.StatusNotFound:
		return collector.Errorf(contract.ErrUnsupportedDevice, false, "%s has no %s", host, what)
	case res.StatusCode == http.StatusTooManyRequests:
		return collector.Errorf(contract.ErrRateLimited, true, "%s rate limited %s", host, what)
	case res.StatusCode >= http.StatusBadRequest:
		return collector.Errorf(contract.ErrUnreachable, res.StatusCode >= http.StatusInternalServerError, "%s returned %d for %s: %s", host, res.StatusCode, what, strings.TrimSpace(string(body)))
	}
	return nil
}

// RPC performs one RPC-style GET with the common parameters added and signed.
func (c *Client) RPC(ctx context.Context, action, apiVersion string, params map[string]string, out any) error {
	all := map[string]string{"Action": action, "Version": apiVersion, "Format": "JSON", "AccessKeyId": c.keyID, "SignatureMethod": "HMAC-SHA1", "SignatureVersion": "1.0", "SignatureNonce": nonce(), "Timestamp": c.now().UTC().Format(timestampFmt)}
	for k, v := range params {
		all[k] = v
	}
	all["Signature"] = RPCSignature(http.MethodGet, all, c.secret)
	q := url.Values{}
	for k, v := range all {
		q.Set(k, v)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return restjson.Classify(c.base, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return restjson.Classify(c.base, err)
	}
	if err := c.classify(res, body, action); err != nil {
		return err
	}
	c.mu.Lock()
	c.raw = append(c.raw, body)
	c.mu.Unlock()
	if err := json.Unmarshal(body, out); err != nil {
		return collector.Errorf(contract.ErrParse, false, "%s: invalid JSON from %s: %v", c.base, action, err)
	}
	return nil
}

// canonicalResource is the ROA CanonicalizedResource: the path, then the query parameters sorted by name.
func canonicalResource(path string, query url.Values) string {
	if len(query) == 0 {
		return path
	}
	keys := make([]string, 0, len(query))
	for k := range query {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+query.Get(k))
	}
	return path + "?" + strings.Join(parts, "&")
}

// ROA performs one ROA-style GET (Container Service).
func (c *Client) ROA(ctx context.Context, path string, query url.Values, apiVersion string, out any) error {
	date := c.now().UTC().Format(http.TimeFormat)
	accept := "application/json"
	acs := map[string]string{"x-acs-signature-method": "HMAC-SHA1", "x-acs-signature-nonce": nonce(), "x-acs-version": apiVersion}
	resource := canonicalResource(path, query)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+resource, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("Date", date)
	for k, v := range acs {
		req.Header.Set(k, v)
	}
	req.Header.Set("Authorization", "acs "+c.keyID+":"+ROASignature(http.MethodGet, accept, date, acs, resource, c.secret))
	res, err := c.http.Do(req)
	if err != nil {
		return restjson.Classify(c.base, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return restjson.Classify(c.base, err)
	}
	if err := c.classify(res, body, resource); err != nil {
		return err
	}
	c.mu.Lock()
	c.raw = append(c.raw, body)
	c.mu.Unlock()
	if err := json.Unmarshal(body, out); err != nil {
		return collector.Errorf(contract.ErrParse, false, "%s: invalid JSON from %s: %v", c.base, resource, err)
	}
	return nil
}

func (c *Client) rawBodies() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([][]byte{}, c.raw...)
}

type ipList struct {
	IPAddress []string `json:"IpAddress"`
}

// Instance is one ECS instance.
type Instance struct {
	InstanceID      string `json:"InstanceId"`
	InstanceName    string `json:"InstanceName"`
	HostName        string `json:"HostName"`
	ZoneID          string `json:"ZoneId"`
	RegionID        string `json:"RegionId"`
	InstanceType    string `json:"InstanceType"`
	Status          string `json:"Status"`
	OSName          string `json:"OSName"`
	OSType          string `json:"OSType"`
	CPU             int    `json:"Cpu"`
	Memory          int    `json:"Memory"`
	CreationTime    string `json:"CreationTime"`
	PublicIPAddress ipList `json:"PublicIpAddress"`
	EipAddress      struct {
		IPAddress string `json:"IpAddress"`
	} `json:"EipAddress"`
	VpcAttributes struct {
		VpcID            string `json:"VpcId"`
		VSwitchID        string `json:"VSwitchId"`
		PrivateIPAddress ipList `json:"PrivateIpAddress"`
	} `json:"VpcAttributes"`
}

// Vpc is a virtual private cloud.
type Vpc struct {
	VpcID     string `json:"VpcId"`
	VpcName   string `json:"VpcName"`
	CidrBlock string `json:"CidrBlock"`
	Status    string `json:"Status"`
}

// VSwitch is a VPC subnet.
type VSwitch struct {
	VSwitchID   string `json:"VSwitchId"`
	VSwitchName string `json:"VSwitchName"`
	VpcID       string `json:"VpcId"`
	CidrBlock   string `json:"CidrBlock"`
	ZoneID      string `json:"ZoneId"`
}

// DBInstance is an RDS instance.
type DBInstance struct {
	DBInstanceID          string `json:"DBInstanceId"`
	DBInstanceDescription string `json:"DBInstanceDescription"`
	Engine                string `json:"Engine"`
	EngineVersion         string `json:"EngineVersion"`
	DBInstanceStatus      string `json:"DBInstanceStatus"`
	DBInstanceClass       string `json:"DBInstanceClass"`
	Category              string `json:"Category"`
	ZoneID                string `json:"ZoneId"`
	VpcID                 string `json:"VpcId"`
	VSwitchID             string `json:"VSwitchId"`
	ConnectionString      string `json:"ConnectionString"`
}

// LoadBalancer is an SLB instance.
type LoadBalancer struct {
	LoadBalancerID     string `json:"LoadBalancerId"`
	LoadBalancerName   string `json:"LoadBalancerName"`
	LoadBalancerStatus string `json:"LoadBalancerStatus"`
	Address            string `json:"Address"`
	AddressType        string `json:"AddressType"`
	LoadBalancerSpec   string `json:"LoadBalancerSpec"`
	VpcID              string `json:"VpcId"`
	VSwitchID          string `json:"VSwitchId"`
}

// Cluster is an ACK cluster.
type Cluster struct {
	ClusterID      string `json:"cluster_id"`
	Name           string `json:"name"`
	State          string `json:"state"`
	CurrentVersion string `json:"current_version"`
	Size           int    `json:"size"`
	VpcID          string `json:"vpc_id"`
	RegionID       string `json:"region_id"`
	ClusterType    string `json:"cluster_type"`
}

// Inventory is everything gathered for one region.
type Inventory struct {
	Account       string
	Region        string
	Instances     []Instance
	Vpcs          []Vpc
	VSwitches     []VSwitch
	DBInstances   []DBInstance
	LoadBalancers []LoadBalancer
	Clusters      []Cluster
	Raw           [][]byte
}

// Clients holds one client per product endpoint; RDS, SLB and CS are optional.
type Clients struct {
	ECS, RDS, SLB, CS *Client
}

type pagedPayload struct {
	TotalCount int `json:"TotalCount"`
	PageNumber int `json:"PageNumber"`
	PageSize   int `json:"PageSize"`
	// TotalRecordCount is RDS's name for TotalCount (DescribeDBInstances pages by PageRecordCount).
	TotalRecordCount int `json:"TotalRecordCount"`
}

func (p pagedPayload) total() int {
	if p.TotalCount > 0 {
		return p.TotalCount
	}
	return p.TotalRecordCount
}

// paged follows PageNumber until TotalCount is reached; decode extracts the page's items.
func paged[T any](ctx context.Context, c *Client, action, apiVersion, region string, decode func(json.RawMessage) ([]T, pagedPayload, error)) ([]T, error) {
	var out []T
	page := 1
	for {
		var raw json.RawMessage
		if err := c.RPC(ctx, action, apiVersion, map[string]string{"RegionId": region, "PageNumber": strconv.Itoa(page), "PageSize": strconv.Itoa(pageSize)}, &raw); err != nil {
			return nil, err
		}
		items, meta, err := decode(raw)
		if err != nil {
			return nil, err
		}
		out = append(out, items...)
		if len(items) == 0 || len(out) >= meta.total() {
			return out, nil
		}
		page++
	}
}

func decodeListAt[T any](raw json.RawMessage, wrapper, key string) ([]T, pagedPayload, error) {
	var meta pagedPayload
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, meta, err
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return nil, meta, err
	}
	var inner map[string]json.RawMessage
	if err := json.Unmarshal(top[wrapper], &inner); err != nil {
		return nil, meta, err
	}
	var items []T
	if err := json.Unmarshal(inner[key], &items); err != nil {
		return nil, meta, err
	}
	return items, meta, nil
}

// Walk reads the region's inventory from every configured product.
func Walk(ctx context.Context, account, region string, c Clients) (*Inventory, error) {
	inv := &Inventory{Account: account, Region: region}
	var err error
	if inv.Instances, err = paged(ctx, c.ECS, "DescribeInstances", ecsVersion, region, func(raw json.RawMessage) ([]Instance, pagedPayload, error) {
		return decodeListAt[Instance](raw, "Instances", "Instance")
	}); err != nil {
		return nil, err
	}
	if inv.Vpcs, err = paged(ctx, c.ECS, "DescribeVpcs", ecsVersion, region, func(raw json.RawMessage) ([]Vpc, pagedPayload, error) { return decodeListAt[Vpc](raw, "Vpcs", "Vpc") }); err != nil {
		return nil, err
	}
	if inv.VSwitches, err = paged(ctx, c.ECS, "DescribeVSwitches", ecsVersion, region, func(raw json.RawMessage) ([]VSwitch, pagedPayload, error) {
		return decodeListAt[VSwitch](raw, "VSwitches", "VSwitch")
	}); err != nil {
		return nil, err
	}
	if c.RDS != nil {
		if inv.DBInstances, err = paged(ctx, c.RDS, "DescribeDBInstances", rdsVersion, region, func(raw json.RawMessage) ([]DBInstance, pagedPayload, error) {
			return decodeListAt[DBInstance](raw, "Items", "DBInstance")
		}); err != nil {
			return nil, err
		}
	}
	if c.SLB != nil {
		if inv.LoadBalancers, err = paged(ctx, c.SLB, "DescribeLoadBalancers", slbVersion, region, func(raw json.RawMessage) ([]LoadBalancer, pagedPayload, error) {
			return decodeListAt[LoadBalancer](raw, "LoadBalancers", "LoadBalancer")
		}); err != nil {
			return nil, err
		}
	}
	if c.CS != nil {
		clusters, err := listClusters(ctx, c.CS)
		if err != nil {
			return nil, err
		}
		for _, cl := range clusters {
			if cl.RegionID == "" || cl.RegionID == region {
				inv.Clusters = append(inv.Clusters, cl)
			}
		}
	}
	for _, cl := range []*Client{c.ECS, c.RDS, c.SLB, c.CS} {
		if cl != nil {
			inv.Raw = append(inv.Raw, cl.rawBodies()...)
		}
	}
	return inv, nil
}

// listClusters pages DescribeClustersV1 (GET /api/v1/clusters: {"clusters": [...], "page_info": {...}}) by
// page_number until page_info.total_count is reached. A bare array (the legacy DescribeClusters shape some
// Apsara Stack releases still serve on this path) is the whole list.
func listClusters(ctx context.Context, c *Client) ([]Cluster, error) {
	var out []Cluster
	for page := 1; ; page++ {
		var raw json.RawMessage
		q := url.Values{"page_number": {strconv.Itoa(page)}, "page_size": {strconv.Itoa(pageSize)}}
		if err := c.ROA(ctx, csClustersPath, q, csVersion, &raw); err != nil {
			return nil, err
		}
		if trimmed := strings.TrimSpace(string(raw)); strings.HasPrefix(trimmed, "[") {
			var legacy []Cluster
			if err := json.Unmarshal(raw, &legacy); err != nil {
				return nil, collector.Errorf(contract.ErrParse, false, "%s: invalid cluster list: %v", c.base, err)
			}
			return append(out, legacy...), nil
		}
		var v1 struct {
			Clusters []Cluster `json:"clusters"`
			PageInfo struct {
				TotalCount int `json:"total_count"`
			} `json:"page_info"`
		}
		if err := json.Unmarshal(raw, &v1); err != nil {
			return nil, collector.Errorf(contract.ErrParse, false, "%s: invalid cluster page: %v", c.base, err)
		}
		out = append(out, v1.Clusters...)
		if len(v1.Clusters) == 0 || len(out) >= v1.PageInfo.TotalCount {
			return out, nil
		}
	}
}

func lower(s string) string { return strings.ToLower(s) }

func healthFromState(state string) (string, bool) {
	switch lower(state) {
	case "running", "available", "active", "running_ok":
		return "healthy", true
	case "stopped", "inactive", "deleting", "failed", "locked":
		return "down", true
	case "starting", "stopping", "pending", "creating", "updating", "initializing", "rebooting":
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
	accountIdentity := map[string]string{"provider": provider, "accountId": inv.Account}
	account := contract.CiRef{Type: typeAccount, Identity: accountIdentity}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeAccount, Identity: accountIdentity, Name: inv.Account,
		Attributes: map[string]any{"provider": provider, "region": inv.Region, "instances": len(inv.Instances), "vpcs": len(inv.Vpcs), "vswitches": len(inv.VSwitches), "rdsInstances": len(inv.DBInstances), "loadBalancers": len(inv.LoadBalancers), "ackClusters": len(inv.Clusters)},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: inv.Account}}, ObservedAt: at})
	resource := func(id, name, kind string, attrs map[string]any) contract.CiRef {
		identity := map[string]string{"provider": provider, "resourceId": id}
		attrs["provider"] = provider
		attrs["resourceType"] = kind
		attrs["region"] = inv.Region
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeResource, Identity: identity, Name: name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: id}}, ObservedAt: at})
		ref := contract.CiRef{Type: typeResource, Identity: identity}
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: account, Attributes: map[string]any{}, ObservedAt: at})
		return ref
	}
	vpcName := map[string]string{}
	vpcRef := map[string]contract.CiRef{}
	for _, v := range inv.Vpcs {
		vpcName[v.VpcID] = firstNonEmpty(v.VpcName, v.VpcID)
		vpcRef[v.VpcID] = resource(v.VpcID, vpcName[v.VpcID], "vpc", map[string]any{"cidr": v.CidrBlock, "status": lower(v.Status)})
	}
	subnetRef := map[string]contract.CiRef{}
	for _, s := range inv.VSwitches {
		vrf := firstNonEmpty(vpcName[s.VpcID], s.VpcID)
		identity := map[string]string{"cidr": s.CidrBlock, "vrfRef": vrf}
		ref := contract.CiRef{Type: typeSubnet, Identity: identity}
		subnetRef[s.VSwitchID] = ref
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeSubnet, Identity: identity, Name: vrf + "/" + firstNonEmpty(s.VSwitchName, s.VSwitchID), Attributes: map[string]any{"provider": provider, "name": s.VSwitchName, "vpc": vrf, "cidr": s.CidrBlock, "zone": s.ZoneID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: s.VSwitchID}}, ObservedAt: at})
		if vr, ok := vpcRef[s.VpcID]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: vr, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	for _, i := range inv.Instances {
		fqdn := lower(firstNonEmpty(i.HostName, i.InstanceName, i.InstanceID))
		identity := map[string]string{"instanceUuid": i.InstanceID, "hypervisorRef": provider + ":" + lower(i.ZoneID), "fqdn": fqdn}
		vmRef := contract.CiRef{Type: typeVM, Identity: identity}
		attrs := map[string]any{"provider": provider, "name": firstNonEmpty(i.InstanceName, i.InstanceID), "zone": i.ZoneID, "region": firstNonEmpty(i.RegionID, inv.Region), "instanceType": i.InstanceType, "cpu": i.CPU, "memoryMb": i.Memory, "powerState": lower(i.Status), "created": i.CreationTime, "vpc": vpcName[i.VpcAttributes.VpcID]}
		if h, ok := healthFromState(i.Status); ok {
			attrs["health"] = h
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVM, Identity: identity, Name: firstNonEmpty(i.InstanceName, i.InstanceID), Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: i.InstanceID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: vmRef, To: account, Attributes: map[string]any{}, ObservedAt: at})
		vrf := firstNonEmpty(vpcName[i.VpcAttributes.VpcID], i.VpcAttributes.VpcID)
		for _, addr := range i.VpcAttributes.PrivateIPAddress.IPAddress {
			ipIdentity := map[string]string{"address": addr, "vrfRef": vrf}
			ipRef := contract.CiRef{Type: typeIP, Identity: ipIdentity}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: addr, Attributes: map[string]any{"assignedTo": i.InstanceName, "scope": "private", "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: ipRef, Attributes: map[string]any{}, ObservedAt: at})
			if sr, ok := subnetRef[i.VpcAttributes.VSwitchID]; ok {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInSubnet, From: ipRef, To: sr, Attributes: map[string]any{}, ObservedAt: at})
			}
		}
		public := append([]string{}, i.PublicIPAddress.IPAddress...)
		if i.EipAddress.IPAddress != "" {
			public = append(public, i.EipAddress.IPAddress)
		}
		for _, addr := range public {
			ipIdentity := map[string]string{"address": addr, "vrfRef": vrfInternet}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: addr, Attributes: map[string]any{"assignedTo": i.InstanceName, "scope": "public", "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{"scope": "public"}, ObservedAt: at})
		}
		if i.OSName != "" {
			family := lower(firstNonEmpty(i.OSType, "linux"))
			osIdentity := map[string]string{"hostRef": i.InstanceID, "family": family, "version": i.OSName}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: i.OSName, Attributes: map[string]any{"family": family, "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalled, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: vmRef, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	for _, db := range inv.DBInstances {
		identity := map[string]string{"clusterId": provider + ":" + db.DBInstanceID}
		ref := contract.CiRef{Type: typeDBClust, Identity: identity}
		attrs := map[string]any{"provider": provider, "engine": lower(db.Engine), "version": db.EngineVersion, "class": db.DBInstanceClass, "category": lower(db.Category), "state": lower(db.DBInstanceStatus), "zone": db.ZoneID, "vpc": vpcName[db.VpcID], "fqdn": lower(db.ConnectionString), "managed": true}
		if h, ok := healthFromState(db.DBInstanceStatus); ok {
			attrs["health"] = h
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeDBClust, Identity: identity, Name: firstNonEmpty(db.DBInstanceDescription, db.DBInstanceID), Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: db.DBInstanceID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: account, Attributes: map[string]any{}, ObservedAt: at})
		if sr, ok := subnetRef[db.VSwitchID]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: ref, To: sr, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	for _, lb := range inv.LoadBalancers {
		identity := map[string]string{"serialNumber": provider + ":" + lb.LoadBalancerID, "managementIp": lb.Address}
		lbRef := contract.CiRef{Type: typeLB, Identity: identity}
		attrs := map[string]any{"vendor": provider, "provider": provider, "model": firstNonEmpty(lb.LoadBalancerSpec, "slb"), "addressType": lower(lb.AddressType), "state": lower(lb.LoadBalancerStatus), "vpc": vpcName[lb.VpcID], "managementIp": lb.Address}
		if h, ok := healthFromState(lb.LoadBalancerStatus); ok {
			attrs["health"] = h
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeLB, Identity: identity, Name: firstNonEmpty(lb.LoadBalancerName, lb.LoadBalancerID), Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: lb.LoadBalancerID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: lbRef, To: account, Attributes: map[string]any{}, ObservedAt: at})
		if lb.Address != "" {
			vrf := vrfInternet
			if lower(lb.AddressType) == "intranet" {
				vrf = firstNonEmpty(vpcName[lb.VpcID], lb.VpcID)
			}
			ipIdentity := map[string]string{"address": lb.Address, "vrfRef": vrf}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: lb.Address, Attributes: map[string]any{"role": "vip", "assignedTo": lb.LoadBalancerName, "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: lbRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	for _, cl := range inv.Clusters {
		attrs := map[string]any{"name": cl.Name, "state": lower(cl.State), "kubernetesVersion": cl.CurrentVersion, "nodeCount": cl.Size, "clusterType": cl.ClusterType}
		if h, ok := healthFromState(cl.State); ok {
			attrs["health"] = h
		}
		ref := resource(cl.ClusterID, cl.Name, "cs.cluster", attrs)
		if vr, ok := vpcRef[cl.VpcID]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: ref, To: vr, Attributes: map[string]any{}, ObservedAt: at})
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
	if cred == nil || cred.Type != credType || cred.Fields[credKeyID] == "" || cred.Fields[credSecret] == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "cloud_alibaba requires an access_key credential with accessKeyId and accessKeySecret")
	}
	region := restjson.StringOption(options, optionRegion)
	ecs := restjson.StringOption(options, optionECS)
	if region == "" || ecs == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrInternal, false, "cloud_alibaba job must set the %s and %s options", optionRegion, optionECS)
	}
	keyID, secret, caPem := cred.Fields[credKeyID], cred.Fields[credSecret], restjson.StringOption(options, optionCA)
	clients := Clients{}
	for _, product := range []struct {
		base string
		into **Client
	}{
		{ecs, &clients.ECS}, {restjson.StringOption(options, optionRDS), &clients.RDS},
		{restjson.StringOption(options, optionSLB), &clients.SLB}, {restjson.StringOption(options, optionCS), &clients.CS},
	} {
		if product.base == "" {
			continue
		}
		c, err := newClient(product.base, keyID, secret, caPem)
		if err != nil {
			return collector.Observation{}, err
		}
		*product.into = c
	}
	inv, err := Walk(ctx, strings.TrimSpace(target.Value), region, clients)
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	return Emit(inv, time.Now().UTC()), nil
}
