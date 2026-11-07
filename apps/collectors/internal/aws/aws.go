// REQ-DISC-010 — AWS collector over the signed Query and REST APIs (no SDK): caller identity, EC2
// instances with addresses and network interfaces, VPCs and subnets, RDS instances, ELBv2 load
// balancers and EKS clusters across the job's regions. The partition's endpoint suffix comes from
// the job so GovCloud, China and local emulators work the same way.
package aws

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"encoding/xml"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
	"github.com/openmap/openmap/apps/collectors/internal/sigv4"
)

const (
	collectorID   = "cloud_aws"
	version       = "0.1.0"
	provider      = "aws"
	evidenceKind  = "api_response"
	httpTimeout   = 60 * time.Second
	optionRegions = "regions"
	optionSuffix  = "endpointSuffix" // amazonaws.com, amazonaws.com.cn, or an emulator host
	optionVerify  = "verifyTls"
	// optionEndpoint is one base URL for every service and region (a VPC-endpoint proxy, a sovereign or
	// isolated partition fronted by a single gateway, a local emulator). Requests stay signed for the real
	// service and region, which is how such gateways route.
	optionEndpoint  = "endpointUrl"
	optionCA        = "caCertPem"
	optionInsecure  = "plainHttp"
	defaultSuffix   = "amazonaws.com"
	defaultRegion   = "us-east-1"
	credAccessKey   = "accessKeyId"
	credSecretKey   = "secretAccessKey"
	credSession     = "sessionToken"
	ec2Version      = "2016-11-15"
	rdsVersion      = "2014-10-31"
	elbVersion      = "2015-12-01"
	stsVersion      = "2011-06-15"
	vrfInternet     = "internet"
	hypervisorLabel = "aws"

	typeAccount  = "cloud_account"
	typeResource = "cloud_resource"
	typeVM       = "vm"
	typeSubnet   = "subnet"
	typeIP       = "ip_address"
	typeDB       = "database_cluster"
	typeLB       = "load_balancer"
	relMemberOf  = "member_of"
	relHostedOn  = "hosted_on"
	relUsesIP    = "uses_ip"
	relInSubnet  = "in_subnet"
	relLocatedIn = "located_in"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "cloud_aws", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"api_token", "cloud_role"},
		TargetKinds: []string{"account"}, Emits: []string{typeAccount, typeResource, typeVM, typeSubnet, typeIP, typeDB, typeLB},
		ContractVersion: contract.Version,
	}
}

// Endpoint resolves a service and region to a base URL; tests replace it.
type Endpoint func(service, region string) string

// DefaultEndpoint builds https://<service>.<region>.<suffix> (global STS uses the region too, which AWS accepts).
func DefaultEndpoint(suffix string, plain bool) Endpoint {
	scheme := "https://"
	if plain {
		scheme = "http://"
	}
	return func(service, region string) string {
		return scheme + service + "." + region + "." + suffix
	}
}

// FixedEndpoint sends every service and region to one base URL (optionEndpoint).
func FixedEndpoint(base string) Endpoint {
	return func(_, _ string) string { return base }
}

type Client struct {
	creds    sigv4.Credentials
	endpoint Endpoint
	http     *http.Client
	raw      [][]byte
}

func NewClient(creds sigv4.Credentials, endpoint Endpoint, verifyTLS bool) *Client {
	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: !verifyTLS, MinVersion: tls.VersionTLS12}} //nolint:gosec // emulators and proxies use private CAs; verifyTls=true enforces the chain.
	return &Client{creds: creds, endpoint: endpoint, http: &http.Client{Timeout: httpTimeout, Transport: tr}}
}

// NewClientCA is NewClient trusting the job's private CA bundle (caCertPem): a non-empty bundle enforces the
// chain against it, so gateways and sovereign endpoints under a private CA verify instead of being skipped.
func NewClientCA(creds sigv4.Credentials, endpoint Endpoint, verifyTLS bool, caPem string) (*Client, error) {
	tr, err := restjson.TransportFor(verifyTLS, caPem)
	if err != nil {
		return nil, err
	}
	return &Client{creds: creds, endpoint: endpoint, http: &http.Client{Timeout: httpTimeout, Transport: tr}}, nil
}

func (c *Client) do(ctx context.Context, service, region, path string, query url.Values, out any) error {
	base, err := url.Parse(c.endpoint(service, region))
	if err != nil {
		return err
	}
	base.Path = strings.TrimSuffix(base.Path, "/") + path
	base.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json, text/xml")
	sigv4.Sign(req, c.creds, region, service, sigv4.EmptyPayloadHash, time.Now())
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode >= http.StatusBadRequest {
		code := errorCode(body)
		switch {
		case res.StatusCode == http.StatusForbidden && (strings.Contains(code, "InvalidClientTokenId") || strings.Contains(code, "SignatureDoesNotMatch") || strings.Contains(code, "AuthFailure") || strings.Contains(code, "ExpiredToken")):
			return collector.Errorf(contract.ErrAuthFailed, false, "%s %s rejected the credential (%s)", service, region, code)
		case res.StatusCode == http.StatusForbidden || strings.Contains(code, "UnauthorizedOperation") || strings.Contains(code, "AccessDenied"):
			return collector.Errorf(contract.ErrPermissionDenied, false, "%s %s denied %s (%s)", service, region, path, code)
		case res.StatusCode == http.StatusTooManyRequests || strings.Contains(code, "Throttling"):
			return collector.Errorf(contract.ErrRateLimited, true, "%s %s throttled", service, region)
		default:
			return collector.Errorf(contract.ErrUnsupportedDevice, false, "%s %s returned %d (%s)", service, region, res.StatusCode, code)
		}
	}
	c.raw = append(c.raw, body)
	if out == nil {
		return nil
	}
	if strings.HasPrefix(strings.TrimSpace(string(body)), "{") {
		return json.Unmarshal(body, out)
	}
	return xml.Unmarshal(body, out)
}

func errorCode(body []byte) string {
	var x struct {
		Code  string `xml:"Error>Code"`
		Code2 string `xml:"Errors>Error>Code"`
	}
	if err := xml.Unmarshal(body, &x); err == nil {
		if x.Code != "" {
			return x.Code
		}
		if x.Code2 != "" {
			return x.Code2
		}
	}
	var j struct {
		Code    string `json:"__type"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &j); err == nil && j.Code != "" {
		return j.Code
	}
	return strings.TrimSpace(string(body))
}

func query(action, version string, extra map[string]string) url.Values {
	q := url.Values{"Action": {action}, "Version": {version}}
	for k, v := range extra {
		q.Set(k, v)
	}
	return q
}

type tag struct {
	Key   string `xml:"key"`
	Value string `xml:"value"`
}

type Instance struct {
	InstanceID       string `xml:"instanceId"`
	ImageID          string `xml:"imageId"`
	InstanceType     string `xml:"instanceType"`
	State            string `xml:"instanceState>name"`
	PrivateIP        string `xml:"privateIpAddress"`
	PublicIP         string `xml:"ipAddress"`
	PrivateDNS       string `xml:"privateDnsName"`
	PublicDNS        string `xml:"dnsName"`
	VpcID            string `xml:"vpcId"`
	SubnetID         string `xml:"subnetId"`
	AvailabilityZone string `xml:"placement>availabilityZone"`
	PlatformDetails  string `xml:"platformDetails"`
	Architecture     string `xml:"architecture"`
	LaunchTime       string `xml:"launchTime"`
	Tags             []tag  `xml:"tagSet>item"`
	Interfaces       []struct {
		MacAddress string `xml:"macAddress"`
		PrivateIPs []struct {
			Address string `xml:"privateIpAddress"`
			Public  string `xml:"association>publicIp"`
		} `xml:"privateIpAddressesSet>item"`
	} `xml:"networkInterfaceSet>item"`
	Volumes []struct {
		VolumeID string `xml:"ebs>volumeId"`
	} `xml:"blockDeviceMapping>item"`
}

type describeInstances struct {
	NextToken    string `xml:"nextToken"`
	Reservations []struct {
		OwnerID   string     `xml:"ownerId"`
		Instances []Instance `xml:"instancesSet>item"`
	} `xml:"reservationSet>item"`
}

type Vpc struct {
	VpcID     string `xml:"vpcId"`
	CidrBlock string `xml:"cidrBlock"`
	IsDefault bool   `xml:"isDefault"`
	State     string `xml:"state"`
	Tags      []tag  `xml:"tagSet>item"`
}

type Subnet struct {
	SubnetID         string `xml:"subnetId"`
	VpcID            string `xml:"vpcId"`
	CidrBlock        string `xml:"cidrBlock"`
	AvailabilityZone string `xml:"availabilityZone"`
	AvailableIPs     int    `xml:"availableIpAddressCount"`
	Tags             []tag  `xml:"tagSet>item"`
}

type DBInstance struct {
	Identifier    string `xml:"DBInstanceIdentifier"`
	Arn           string `xml:"DBInstanceArn"`
	Engine        string `xml:"Engine"`
	EngineVersion string `xml:"EngineVersion"`
	Class         string `xml:"DBInstanceClass"`
	Status        string `xml:"DBInstanceStatus"`
	Address       string `xml:"Endpoint>Address"`
	Port          int    `xml:"Endpoint>Port"`
	MultiAZ       bool   `xml:"MultiAZ"`
	StorageGB     int    `xml:"AllocatedStorage"`
	ClusterID     string `xml:"DBClusterIdentifier"`
	VpcID         string `xml:"DBSubnetGroup>VpcId"`
	Public        bool   `xml:"PubliclyAccessible"`
}

type LoadBalancer struct {
	Arn     string `xml:"LoadBalancerArn"`
	Name    string `xml:"LoadBalancerName"`
	DNSName string `xml:"DNSName"`
	Scheme  string `xml:"Scheme"`
	Type    string `xml:"Type"`
	VpcID   string `xml:"VpcId"`
	State   string `xml:"State>Code"`
}

type eksCluster struct {
	Cluster struct {
		Name     string `json:"name"`
		Arn      string `json:"arn"`
		Version  string `json:"version"`
		Endpoint string `json:"endpoint"`
		Status   string `json:"status"`
		VpcID    string `json:"resourcesVpcConfig.vpcId"`
	} `json:"cluster"`
}

// Region is everything gathered in one region.
type Region struct {
	Name          string
	Instances     []Instance
	Vpcs          []Vpc
	Subnets       []Subnet
	Databases     []DBInstance
	LoadBalancers []LoadBalancer
	EKSClusters   []eksCluster
}

// Inventory is the account view across regions.
type Inventory struct {
	AccountID string
	CallerArn string
	Regions   []Region
	Raw       [][]byte
}

// Walk reads identity then every region.
func (c *Client) Walk(ctx context.Context, regions []string) (*Inventory, error) {
	inv := &Inventory{}
	var ident struct {
		Account string `xml:"GetCallerIdentityResult>Account"`
		Arn     string `xml:"GetCallerIdentityResult>Arn"`
	}
	first := defaultRegion
	if len(regions) > 0 {
		first = regions[0]
	}
	if err := c.do(ctx, "sts", first, "/", query("GetCallerIdentity", stsVersion, nil), &ident); err != nil {
		return nil, err
	}
	inv.AccountID, inv.CallerArn = ident.Account, ident.Arn
	for _, region := range regions {
		r := Region{Name: region}
		for token := ""; ; {
			var page describeInstances
			extra := map[string]string{}
			if token != "" {
				extra["NextToken"] = token
			}
			if err := c.do(ctx, "ec2", region, "/", query("DescribeInstances", ec2Version, extra), &page); err != nil {
				return nil, err
			}
			for _, res := range page.Reservations {
				r.Instances = append(r.Instances, res.Instances...)
			}
			if page.NextToken == "" {
				break
			}
			token = page.NextToken
		}
		var vpcs struct {
			Items []Vpc `xml:"vpcSet>item"`
		}
		if err := c.do(ctx, "ec2", region, "/", query("DescribeVpcs", ec2Version, nil), &vpcs); err != nil {
			return nil, err
		}
		r.Vpcs = vpcs.Items
		var subnets struct {
			Items []Subnet `xml:"subnetSet>item"`
		}
		if err := c.do(ctx, "ec2", region, "/", query("DescribeSubnets", ec2Version, nil), &subnets); err != nil {
			return nil, err
		}
		r.Subnets = subnets.Items
		// RDS, ELBv2 and EKS are optional (a credential may lack their rights); each follows its own page
		// token (Marker, NextMarker, nextToken) so large accounts are read whole.
		for marker := ""; ; {
			var dbs struct {
				Items  []DBInstance `xml:"DescribeDBInstancesResult>DBInstances>DBInstance"`
				Marker string       `xml:"DescribeDBInstancesResult>Marker"`
			}
			extra := map[string]string{}
			if marker != "" {
				extra["Marker"] = marker
			}
			if err := c.do(ctx, "rds", region, "/", query("DescribeDBInstances", rdsVersion, extra), &dbs); err != nil {
				break
			}
			r.Databases = append(r.Databases, dbs.Items...)
			if dbs.Marker == "" {
				break
			}
			marker = dbs.Marker
		}
		for marker := ""; ; {
			var lbs struct {
				Items      []LoadBalancer `xml:"DescribeLoadBalancersResult>LoadBalancers>member"`
				NextMarker string         `xml:"DescribeLoadBalancersResult>NextMarker"`
			}
			extra := map[string]string{}
			if marker != "" {
				extra["Marker"] = marker
			}
			if err := c.do(ctx, "elasticloadbalancing", region, "/", query("DescribeLoadBalancers", elbVersion, extra), &lbs); err != nil {
				break
			}
			r.LoadBalancers = append(r.LoadBalancers, lbs.Items...)
			if lbs.NextMarker == "" {
				break
			}
			marker = lbs.NextMarker
		}
		for token := ""; ; {
			var names struct {
				Clusters  []string `json:"clusters"`
				NextToken string   `json:"nextToken"`
			}
			q := url.Values{}
			if token != "" {
				q.Set("nextToken", token)
			}
			if err := c.do(ctx, "eks", region, "/clusters", q, &names); err != nil {
				break
			}
			for _, n := range names.Clusters {
				var cl eksCluster
				if err := c.do(ctx, "eks", region, "/clusters/"+n, url.Values{}, &cl); err == nil {
					r.EKSClusters = append(r.EKSClusters, cl)
				}
			}
			if names.NextToken == "" {
				break
			}
			token = names.NextToken
		}
		inv.Regions = append(inv.Regions, r)
	}
	inv.Raw = c.raw
	return inv, nil
}

func tagMap(tags []tag) map[string]string {
	out := map[string]string{}
	for _, t := range tags {
		out[t.Key] = t.Value
	}
	return out
}

func nameTag(tags []tag, fallback string) string {
	if n := tagMap(tags)["Name"]; n != "" {
		return n
	}
	return fallback
}

func arn(partitionSuffix, service, region, account, resource string) string {
	partition := "aws"
	if strings.HasSuffix(partitionSuffix, ".cn") {
		partition = "aws-cn"
	}
	return "arn:" + partition + ":" + service + ":" + region + ":" + account + ":" + resource
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, suffix string, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	accountIdentity := map[string]string{"provider": provider, "accountId": inv.AccountID}
	account := contract.CiRef{Type: typeAccount, Identity: accountIdentity}
	counts := map[string]int{}
	regionNames := []string{}
	for _, r := range inv.Regions {
		regionNames = append(regionNames, r.Name)
		counts["ec2"] += len(r.Instances)
		counts["vpc"] += len(r.Vpcs)
		counts["subnet"] += len(r.Subnets)
		counts["rds"] += len(r.Databases)
		counts["elbv2"] += len(r.LoadBalancers)
		counts["eks"] += len(r.EKSClusters)
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeAccount, Identity: accountIdentity, Name: "AWS " + inv.AccountID,
		Attributes: map[string]any{"provider": provider, "accountId": inv.AccountID, "callerArn": inv.CallerArn, "regions": regionNames, "resourceTypes": counts},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: inv.AccountID}}, ObservedAt: at})
	resource := func(id, name, rtype, region string, extra map[string]any, tags []tag) contract.CiRef {
		identity := map[string]string{"provider": provider, "resourceId": id}
		ref := contract.CiRef{Type: typeResource, Identity: identity}
		attrs := map[string]any{"provider": provider, "resourceType": rtype, "region": region, "accountId": inv.AccountID, "tags": tagMap(tags)}
		for k, v := range extra {
			attrs[k] = v
		}
		tagList := []string{}
		for _, t := range tags {
			tagList = append(tagList, t.Key+"="+t.Value)
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeResource, Identity: identity, Name: name, Attributes: attrs, Tags: tagList, ExternalIDs: []contract.ExternalID{{Source: provider, ID: id}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: account, Attributes: map[string]any{"region": region}, ObservedAt: at})
		return ref
	}
	for _, r := range inv.Regions {
		vpcRef := map[string]contract.CiRef{}
		for _, v := range r.Vpcs {
			vpcRef[v.VpcID] = resource(arn(suffix, "ec2", r.Name, inv.AccountID, "vpc/"+v.VpcID), nameTag(v.Tags, v.VpcID), "ec2:vpc", r.Name, map[string]any{"vpcId": v.VpcID, "cidr": v.CidrBlock, "default": v.IsDefault, "state": v.State}, v.Tags)
		}
		subnetRef := map[string]contract.CiRef{}
		for _, s := range r.Subnets {
			identity := map[string]string{"cidr": s.CidrBlock, "vrfRef": s.VpcID}
			subnetRef[s.SubnetID] = contract.CiRef{Type: typeSubnet, Identity: identity}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeSubnet, Identity: identity, Name: nameTag(s.Tags, s.SubnetID),
				Attributes: map[string]any{"cidr": s.CidrBlock, "subnetId": s.SubnetID, "vpcId": s.VpcID, "availabilityZone": s.AvailabilityZone, "availableIps": s.AvailableIPs, "provider": provider, "region": r.Name, "tags": tagMap(s.Tags)},
				Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: s.SubnetID}}, ObservedAt: at})
			if v, ok := vpcRef[s.VpcID]; ok {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: subnetRef[s.SubnetID], To: v, Attributes: map[string]any{}, ObservedAt: at})
			}
		}
		for _, i := range r.Instances {
			res := resource(arn(suffix, "ec2", r.Name, inv.AccountID, "instance/"+i.InstanceID), nameTag(i.Tags, i.InstanceID), "ec2:instance", r.Name, map[string]any{"instanceType": i.InstanceType, "state": i.State, "availabilityZone": i.AvailabilityZone, "vpcId": i.VpcID, "subnetId": i.SubnetID, "imageId": i.ImageID}, i.Tags)
			identity := map[string]string{"instanceUuid": i.InstanceID, "hypervisorRef": hypervisorLabel}
			if i.PrivateDNS != "" {
				identity["fqdn"] = strings.ToLower(i.PrivateDNS)
			}
			vmRef := contract.CiRef{Type: typeVM, Identity: identity}
			macs := []string{}
			for _, ni := range i.Interfaces {
				macs = append(macs, strings.ToLower(ni.MacAddress))
			}
			volumes := []string{}
			for _, v := range i.Volumes {
				volumes = append(volumes, v.VolumeID)
			}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVM, Identity: identity, Name: nameTag(i.Tags, i.InstanceID),
				Attributes: map[string]any{"platform": provider, "instanceType": i.InstanceType, "powerState": i.State, "availabilityZone": i.AvailabilityZone, "region": r.Name, "platformDetails": i.PlatformDetails, "architecture": i.Architecture, "launchTime": i.LaunchTime, "privateIp": i.PrivateIP, "publicIp": i.PublicIP, "publicDns": i.PublicDNS, "macAddresses": macs, "volumes": volumes, "diskCount": len(volumes), "internetExposed": i.PublicIP != "", "tags": tagMap(i.Tags), "resourceId": i.InstanceID},
				Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: i.InstanceID}}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relHostedOn, From: vmRef, To: res, Attributes: map[string]any{}, ObservedAt: at})
			if i.PrivateIP != "" {
				ipIdentity := map[string]string{"address": i.PrivateIP, "vrfRef": i.VpcID}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: i.PrivateIP, Attributes: map[string]any{"assignedTo": i.InstanceID, "scope": "private", "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				ipRef := contract.CiRef{Type: typeIP, Identity: ipIdentity}
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: ipRef, Attributes: map[string]any{}, ObservedAt: at})
				if sn, ok := subnetRef[i.SubnetID]; ok {
					obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInSubnet, From: ipRef, To: sn, Attributes: map[string]any{}, ObservedAt: at})
				}
			}
			if i.PublicIP != "" {
				ipIdentity := map[string]string{"address": i.PublicIP, "vrfRef": vrfInternet}
				obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: i.PublicIP, Attributes: map[string]any{"assignedTo": i.InstanceID, "scope": "public", "fqdn": i.PublicDNS, "internetExposed": true, "provider": provider}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{"scope": "public"}, ObservedAt: at})
			}
		}
		for _, d := range r.Databases {
			res := resource(d.Arn, d.Identifier, "rds:db", r.Name, map[string]any{"engine": d.Engine, "engineVersion": d.EngineVersion, "instanceClass": d.Class, "status": d.Status, "multiAz": d.MultiAZ, "storageGb": d.StorageGB, "endpoint": d.Address, "port": d.Port, "publiclyAccessible": d.Public}, nil)
			identity := map[string]string{"engine": d.Engine, "clusterId": firstNonEmpty(d.ClusterID, d.Arn)}
			dbRef := contract.CiRef{Type: typeDB, Identity: identity}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeDB, Identity: identity, Name: d.Identifier,
				Attributes: map[string]any{"engine": d.Engine, "version": d.EngineVersion, "role": map[bool]string{true: "multi-az", false: "single-az"}[d.MultiAZ], "host": d.Address, "port": d.Port, "managed": true, "provider": provider, "region": r.Name, "status": d.Status, "storageGb": d.StorageGB, "internetExposed": d.Public},
				Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: d.Arn}}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relHostedOn, From: dbRef, To: res, Attributes: map[string]any{}, ObservedAt: at})
		}
		for _, lb := range r.LoadBalancers {
			res := resource(lb.Arn, lb.Name, "elasticloadbalancing:"+lb.Type, r.Name, map[string]any{"dnsName": lb.DNSName, "scheme": lb.Scheme, "lbType": lb.Type, "vpcId": lb.VpcID, "state": lb.State}, nil)
			identity := map[string]string{"serialNumber": lb.Arn, "managementIp": strings.ToLower(lb.DNSName)}
			lbRef := contract.CiRef{Type: typeLB, Identity: identity}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeLB, Identity: identity, Name: lb.Name,
				Attributes: map[string]any{"vendor": provider, "model": "elbv2-" + lb.Type, "scheme": lb.Scheme, "fqdn": lb.DNSName, "state": lb.State, "vpcId": lb.VpcID, "region": r.Name, "internetExposed": lb.Scheme == "internet-facing", "managed": true},
				Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: lb.Arn}}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relHostedOn, From: lbRef, To: res, Attributes: map[string]any{}, ObservedAt: at})
		}
		for _, cl := range r.EKSClusters {
			resource(cl.Cluster.Arn, cl.Cluster.Name, "eks:cluster", r.Name, map[string]any{"kubernetesVersion": cl.Cluster.Version, "endpoint": cl.Cluster.Endpoint, "status": cl.Cluster.Status}, nil)
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
	if cred == nil || cred.Fields[credAccessKey] == "" || cred.Fields[credSecretKey] == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "aws requires a credential with accessKeyId and secretAccessKey (api_token or cloud_role with session fields)")
	}
	regions := []string{}
	if list, ok := options[optionRegions].([]any); ok {
		for _, r := range list {
			if s, ok := r.(string); ok && s != "" {
				regions = append(regions, s)
			}
		}
	}
	if len(regions) == 0 {
		regions = []string{defaultRegion}
	}
	suffix, _ := options[optionSuffix].(string)
	if suffix == "" {
		suffix = defaultSuffix
	}
	plain, _ := options[optionInsecure].(bool)
	verify, _ := options[optionVerify].(bool)
	endpoint, verifyTLS := DefaultEndpoint(suffix, plain), verify || suffix == defaultSuffix
	if base, _ := options[optionEndpoint].(string); base != "" {
		endpoint, verifyTLS = FixedEndpoint(base), verify
	}
	caPem, _ := options[optionCA].(string)
	c, err := NewClientCA(sigv4.Credentials{AccessKeyID: cred.Fields[credAccessKey], SecretAccessKey: cred.Fields[credSecretKey], SessionToken: cred.Fields[credSession]}, endpoint, verifyTLS, caPem)
	if err != nil {
		return collector.Observation{}, err
	}
	inv, err := c.Walk(ctx, regions)
	if err != nil {
		var ne net.Error
		if errorsAs(err, &ne) && ne.Timeout() {
			return collector.Observation{}, collector.Errorf(contract.ErrTimeout, true, "aws account %s timed out", target.Value)
		}
		if _, ok := err.(*collector.TargetError); ok {
			return collector.Observation{}, err
		}
		return collector.Observation{}, collector.Errorf(contract.ErrUnreachable, true, "aws account %s: %v", target.Value, err)
	}
	if target.Value != "" && inv.AccountID != "" && target.Value != inv.AccountID {
		return collector.Observation{}, collector.Errorf(contract.ErrPermissionDenied, false, "credential belongs to account %s, job targets %s", inv.AccountID, target.Value)
	}
	_ = strconv.Itoa
	return Emit(inv, suffix, time.Now().UTC()), nil
}

func errorsAs(err error, target *net.Error) bool {
	for e := err; e != nil; {
		if ne, ok := e.(net.Error); ok {
			*target = ne
			return true
		}
		u, ok := e.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		e = u.Unwrap()
	}
	return false
}
