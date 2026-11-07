// REQ-QA-005 REQ-DISC-010 — simulated AWS account behind one HTTPS gateway (the collector's endpointUrl option):
// every request is SigV4-verified for real against the simulated access key and secret, then routed by its signed
// credential scope (service and region) to STS GetCallerIdentity, EC2 DescribeInstances / DescribeVpcs /
// DescribeSubnets (Query API, XML, nextToken), RDS DescribeDBInstances (Marker), ELBv2 DescribeLoadBalancers
// (NextMarker) and EKS ListClusters / DescribeCluster (REST-JSON, nextToken). The job names the estate region and a
// second enabled region that holds nothing, so the collector's region loop runs.
//
// Rendered from the estate: the cloud_account and its member cloud_resources of the four types the collector reads
// (EC2 VPC, EC2 instance, RDS DB instance, ELBv2 load balancer); names, regions, tags, launch times and the EC2
// identifiers in the estate ARNs. ARNs the API returns verbatim (RDS, ELBv2) follow the documented AWS format, which
// the estate does not, so those identities are reported as drift. Generated deterministically (the estate has no
// such facts): VPC CIDRs, one private subnet per VPC, instance addresses, MACs, AMI and volume ids, RDS engine and
// class, load balancer scheme and DNS names. Estate resources of types the collector never calls (security groups,
// Lambda functions) are not served.
package aws

import (
	"context"
	"encoding/xml"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/cloudsim"
)

const (
	provider    = "aws"
	ec2Version  = "2016-11-15"
	rdsVersion  = "2014-10-31"
	elbVersion  = "2015-12-01"
	stsVersion  = "2011-06-15"
	ec2NS       = "http://ec2.amazonaws.com/doc/2016-11-15/"
	rdsNS       = "http://rds.amazonaws.com/doc/2014-10-31/"
	elbNS       = "http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/"
	stsNS       = "https://sts.amazonaws.com/doc/2011-06-15/"
	awsDomain   = "amazonaws.com"
	emptyRegion = "me-central-1" // an enabled region with nothing in it: the collector must iterate every job region
	idHexLen    = 17
	keyIDLen    = 16
	arnHexLen   = 16
	elbDigits   = 10
	firstHostIP = 10
	macOctets   = 5
	dbPort      = 5432
	dbStorageGb = 100
	runningCode = 16
	stoppedCode = 80

	typeVPC      = "AWS::EC2::VPC"
	typeInstance = "AWS::EC2::Instance"
	typeDB       = "AWS::RDS::DBInstance"
	typeLB       = "AWS::ElasticLoadBalancingV2::LoadBalancer"
)

type Vendor struct{}

func (Vendor) ID() string             { return "aws" }
func (Vendor) Collector() string      { return "cloud_aws" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-010"} }

// accessKey is the simulated AKIA access key id, derived from the process secret.
func accessKey(env *sim.Env) string {
	return "AKIA" + strings.ToUpper(cloudsim.Hex("aws-key"+env.Secret, keyIDLen))
}

type vpc struct {
	ci                       *estate.CI // nil for a generated default VPC
	id, name, region, cidr   string
	subnetID, subnetCIDR, az string
	subnetName, prefix       string
	tags                     map[string]string
	hosts                    int
	isDefault                bool
}

type instance struct {
	ci                   *estate.CI
	id, region, ip, dns  string
	mac, ami, volume, az string
	vpc                  *vpc
}

type database struct {
	ci                *estate.CI
	region, arn, host string
	vpc               *vpc
}

type balancer struct {
	ci               *estate.CI
	region, arn, dns string
	vpc              *vpc
}

type account struct {
	ci        *estate.CI
	id        string
	regions   []string
	vpcs      []*vpc
	instances []*instance
	dbs       []*database
	lbs       []*balancer
}

func accounts(e *estate.Estate) []*estate.CI {
	return e.OfType("cloud_account", func(c *estate.CI) bool { return c.ID("provider") == provider })
}

func lastSegment(arn string) string {
	if i := strings.LastIndex(arn, "/"); i >= 0 {
		return arn[i+1:]
	}
	return arn
}

func tagsOf(c *estate.CI) map[string]string {
	t := cloudsim.EstateTags(c.Str)
	t["Name"] = c.Name
	return t
}

func load(e *estate.Estate, a *estate.CI) *account {
	acct := &account{ci: a, id: a.ID("accountId")}
	regions := map[string]bool{}
	if r := a.Str("region"); r != "" {
		regions[r] = true
	}
	var members []*estate.CI
	for _, m := range e.To(a, "member_of") {
		if m.Type == "cloud_resource" && m.ID("provider") == provider {
			members = append(members, m)
		}
	}
	sort.SliceStable(members, func(i, j int) bool { return members[i].Name < members[j].Name })
	byRegion := map[string][]*vpc{}
	newVPC := func(ci *estate.CI, id, name, region string, isDefault bool) *vpc {
		b := cloudsim.Byte("aws-vpc"+id, 1, 254)
		prefix := "10." + strconv.Itoa(b) + ".1."
		v := &vpc{ci: ci, id: id, name: name, region: region, cidr: "10." + strconv.Itoa(b) + ".0.0/16", isDefault: isDefault,
			subnetID: "subnet-" + cloudsim.Hex("aws-subnet"+id, idHexLen), subnetCIDR: prefix + "0/24", az: region + "a",
			subnetName: name + "-private-a", prefix: prefix, tags: map[string]string{"Name": name}}
		if ci != nil {
			v.tags = tagsOf(ci)
		}
		byRegion[region] = append(byRegion[region], v)
		acct.vpcs = append(acct.vpcs, v)
		return v
	}
	for _, m := range members {
		if m.Str("resourceType") == typeVPC {
			region := m.Str("region")
			regions[region] = true
			newVPC(m, lastSegment(m.ID("resourceId")), m.Name, region, false)
		}
	}
	vpcFor := func(region, want string) *vpc {
		for _, v := range byRegion[region] {
			if v.id == want {
				return v
			}
		}
		if len(byRegion[region]) == 0 {
			return newVPC(nil, "vpc-"+cloudsim.Hex("aws-default-vpc"+acct.id+region, idHexLen), "default", region, true)
		}
		return byRegion[region][0]
	}
	for _, m := range members {
		region := m.Str("region")
		switch m.Str("resourceType") {
		case typeInstance:
			regions[region] = true
			v := vpcFor(region, m.Str("vpc"))
			v.hosts++
			ip := v.prefix + strconv.Itoa(firstHostIP+v.hosts)
			mac := "0a"
			for i := 0; i < macOctets; i++ {
				mac += ":" + cloudsim.Hex("aws-mac"+m.Name+strconv.Itoa(i), 2)
			}
			acct.instances = append(acct.instances, &instance{ci: m, id: lastSegment(m.ID("resourceId")), region: region, ip: ip,
				dns: "ip-" + strings.ReplaceAll(ip, ".", "-") + "." + region + ".compute.internal", mac: mac, vpc: v, az: v.az,
				ami: "ami-" + cloudsim.Hex("aws-ami"+region, idHexLen), volume: "vol-" + cloudsim.Hex("aws-vol"+m.Name, idHexLen)})
		case typeDB:
			regions[region] = true
			acct.dbs = append(acct.dbs, &database{ci: m, region: region, vpc: vpcFor(region, m.Str("vpc")),
				arn:  "arn:aws:rds:" + region + ":" + acct.id + ":db:" + m.Name,
				host: m.Name + "." + cloudsim.Hex("aws-rds"+acct.id+region, 12) + "." + region + ".rds." + awsDomain})
		case typeLB:
			regions[region] = true
			acct.lbs = append(acct.lbs, &balancer{ci: m, region: region, vpc: vpcFor(region, m.Str("vpc")),
				arn: "arn:aws:elasticloadbalancing:" + region + ":" + acct.id + ":loadbalancer/app/" + m.Name + "/" + cloudsim.Hex("aws-elb"+m.Name, arnHexLen),
				dns: "internal-" + m.Name + "-" + cloudsim.Digits("aws-elb-dns"+m.Name, elbDigits) + "." + region + ".elb." + awsDomain})
		}
	}
	for r := range regions {
		acct.regions = append(acct.regions, r)
	}
	sort.Strings(acct.regions)
	return acct
}

// --- EC2 Query API documents -------------------------------------------------------------------------------

type tagItem struct {
	Key   string `xml:"key"`
	Value string `xml:"value"`
}

func tagSet(t map[string]string) []tagItem {
	keys := make([]string, 0, len(t))
	for k := range t {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]tagItem, 0, len(keys))
	for _, k := range keys {
		out = append(out, tagItem{k, t[k]})
	}
	return out
}

type privateIP struct {
	Address string `xml:"privateIpAddress"`
	Primary bool   `xml:"primary"`
}

type eni struct {
	ID         string      `xml:"networkInterfaceId"`
	SubnetID   string      `xml:"subnetId"`
	VpcID      string      `xml:"vpcId"`
	Mac        string      `xml:"macAddress"`
	PrivateIP  string      `xml:"privateIpAddress"`
	PrivateDNS string      `xml:"privateDnsName"`
	Addresses  []privateIP `xml:"privateIpAddressesSet>item"`
}

type blockDevice struct {
	Device   string `xml:"deviceName"`
	VolumeID string `xml:"ebs>volumeId"`
	Status   string `xml:"ebs>status"`
}

type instanceDoc struct {
	ID           string        `xml:"instanceId"`
	ImageID      string        `xml:"imageId"`
	StateCode    int           `xml:"instanceState>code"`
	StateName    string        `xml:"instanceState>name"`
	PrivateDNS   string        `xml:"privateDnsName"`
	DNSName      string        `xml:"dnsName"`
	Type         string        `xml:"instanceType"`
	LaunchTime   string        `xml:"launchTime"`
	AZ           string        `xml:"placement>availabilityZone"`
	SubnetID     string        `xml:"subnetId"`
	VpcID        string        `xml:"vpcId"`
	PrivateIP    string        `xml:"privateIpAddress"`
	Architecture string        `xml:"architecture"`
	RootDevice   string        `xml:"rootDeviceName"`
	Devices      []blockDevice `xml:"blockDeviceMapping>item"`
	Interfaces   []eni         `xml:"networkInterfaceSet>item"`
	Platform     string        `xml:"platformDetails"`
	Tags         []tagItem     `xml:"tagSet>item"`
}

type reservation struct {
	ID        string        `xml:"reservationId"`
	OwnerID   string        `xml:"ownerId"`
	Instances []instanceDoc `xml:"instancesSet>item"`
}

type describeInstances struct {
	XMLName      xml.Name      `xml:"DescribeInstancesResponse"`
	NS           string        `xml:"xmlns,attr"`
	RequestID    string        `xml:"requestId"`
	Reservations []reservation `xml:"reservationSet>item"`
	NextToken    string        `xml:"nextToken,omitempty"`
}

type vpcDoc struct {
	ID        string    `xml:"vpcId"`
	OwnerID   string    `xml:"ownerId"`
	State     string    `xml:"state"`
	CIDR      string    `xml:"cidrBlock"`
	IsDefault bool      `xml:"isDefault"`
	Tags      []tagItem `xml:"tagSet>item"`
}

type describeVpcs struct {
	XMLName   xml.Name `xml:"DescribeVpcsResponse"`
	NS        string   `xml:"xmlns,attr"`
	RequestID string   `xml:"requestId"`
	Vpcs      []vpcDoc `xml:"vpcSet>item"`
	NextToken string   `xml:"nextToken,omitempty"`
}

type subnetDoc struct {
	ID        string    `xml:"subnetId"`
	State     string    `xml:"state"`
	VpcID     string    `xml:"vpcId"`
	OwnerID   string    `xml:"ownerId"`
	CIDR      string    `xml:"cidrBlock"`
	Available int       `xml:"availableIpAddressCount"`
	AZ        string    `xml:"availabilityZone"`
	Tags      []tagItem `xml:"tagSet>item"`
}

type describeSubnets struct {
	XMLName   xml.Name    `xml:"DescribeSubnetsResponse"`
	NS        string      `xml:"xmlns,attr"`
	RequestID string      `xml:"requestId"`
	Subnets   []subnetDoc `xml:"subnetSet>item"`
	NextToken string      `xml:"nextToken,omitempty"`
}

// --- RDS, ELBv2 and STS documents --------------------------------------------------------------------------

type dbDoc struct {
	Identifier  string `xml:"DBInstanceIdentifier"`
	Arn         string `xml:"DBInstanceArn"`
	Class       string `xml:"DBInstanceClass"`
	Engine      string `xml:"Engine"`
	Version     string `xml:"EngineVersion"`
	Status      string `xml:"DBInstanceStatus"`
	Address     string `xml:"Endpoint>Address"`
	Port        int    `xml:"Endpoint>Port"`
	Storage     int    `xml:"AllocatedStorage"`
	StorageType string `xml:"StorageType"`
	MultiAZ     bool   `xml:"MultiAZ"`
	AZ          string `xml:"AvailabilityZone"`
	VpcID       string `xml:"DBSubnetGroup>VpcId"`
	Public      bool   `xml:"PubliclyAccessible"`
	Created     string `xml:"InstanceCreateTime"`
}

type describeDBs struct {
	XMLName   xml.Name `xml:"DescribeDBInstancesResponse"`
	NS        string   `xml:"xmlns,attr"`
	DBs       []dbDoc  `xml:"DescribeDBInstancesResult>DBInstances>DBInstance"`
	Marker    string   `xml:"DescribeDBInstancesResult>Marker,omitempty"`
	RequestID string   `xml:"ResponseMetadata>RequestId"`
}

type lbDoc struct {
	Arn     string `xml:"LoadBalancerArn"`
	DNSName string `xml:"DNSName"`
	Created string `xml:"CreatedTime"`
	Name    string `xml:"LoadBalancerName"`
	Scheme  string `xml:"Scheme"`
	VpcID   string `xml:"VpcId"`
	State   string `xml:"State>Code"`
	Type    string `xml:"Type"`
	AZ      string `xml:"AvailabilityZones>member>ZoneName"`
	Subnet  string `xml:"AvailabilityZones>member>SubnetId"`
}

type describeLBs struct {
	XMLName    xml.Name `xml:"DescribeLoadBalancersResponse"`
	NS         string   `xml:"xmlns,attr"`
	LBs        []lbDoc  `xml:"DescribeLoadBalancersResult>LoadBalancers>member"`
	NextMarker string   `xml:"DescribeLoadBalancersResult>NextMarker,omitempty"`
	RequestID  string   `xml:"ResponseMetadata>RequestId"`
}

type callerIdentity struct {
	XMLName   xml.Name `xml:"GetCallerIdentityResponse"`
	NS        string   `xml:"xmlns,attr"`
	Arn       string   `xml:"GetCallerIdentityResult>Arn"`
	UserID    string   `xml:"GetCallerIdentityResult>UserId"`
	Account   string   `xml:"GetCallerIdentityResult>Account"`
	RequestID string   `xml:"ResponseMetadata>RequestId"`
}

type ec2Error struct {
	XMLName   xml.Name `xml:"Response"`
	Code      string   `xml:"Errors>Error>Code"`
	Message   string   `xml:"Errors>Error>Message"`
	RequestID string   `xml:"RequestID"`
}

type queryError struct {
	XMLName   xml.Name `xml:"ErrorResponse"`
	Type      string   `xml:"Error>Type"`
	Code      string   `xml:"Error>Code"`
	Message   string   `xml:"Error>Message"`
	RequestID string   `xml:"RequestId"`
}

func requestID(r *http.Request) string { return cloudsim.UUID("aws-req" + r.URL.RawQuery + r.URL.Path) }

func fail(w http.ResponseWriter, r *http.Request, service string, status int, code, message string) {
	switch service {
	case "ec2":
		sim.WriteXML(w, status, ec2Error{Code: code, Message: message, RequestID: requestID(r)})
	case "eks":
		w.Header().Set("x-amzn-ErrorType", code)
		sim.WriteJSON(w, status, map[string]string{"__type": code, "message": message})
	default:
		sim.WriteXML(w, status, queryError{Type: "Sender", Code: code, Message: message, RequestID: requestID(r)})
	}
}

func serviceFromHost(r *http.Request) string {
	if strings.HasPrefix(r.URL.Path, "/clusters") {
		return "eks"
	}
	return "ec2"
}

func stateName(c *estate.CI) (string, int) {
	if c.Str("state") == "stopped" {
		return "stopped", stoppedCode
	}
	return "running", runningCode
}

func (a *account) instancesIn(region string) []*instance {
	var out []*instance
	for _, i := range a.instances {
		if i.region == region {
			out = append(out, i)
		}
	}
	return out
}

func (a *account) vpcsIn(region string) []*vpc {
	var out []*vpc
	for _, v := range a.vpcs {
		if v.region == region {
			out = append(out, v)
		}
	}
	return out
}

func (a *account) ec2(w http.ResponseWriter, r *http.Request, region string) {
	q := r.URL.Query()
	if q.Get("Version") != ec2Version {
		fail(w, r, "ec2", http.StatusBadRequest, "InvalidParameterValue", "unsupported Version")
		return
	}
	offset, ok := cloudsim.Offset(q.Get("NextToken"))
	if !ok {
		fail(w, r, "ec2", http.StatusBadRequest, "InvalidParameterValue", "Invalid NextToken")
		return
	}
	size := cloudsim.Size(q.Get("MaxResults"))
	switch q.Get("Action") {
	case "DescribeInstances":
		list := a.instancesIn(region)
		start, end, next := cloudsim.Window(len(list), offset, size)
		doc := describeInstances{NS: ec2NS, RequestID: requestID(r), NextToken: next}
		for _, i := range list[start:end] {
			name, code := stateName(i.ci)
			doc.Reservations = append(doc.Reservations, reservation{ID: "r-" + cloudsim.Hex("aws-res"+i.id, idHexLen), OwnerID: a.id, Instances: []instanceDoc{{
				ID: i.id, ImageID: i.ami, StateCode: code, StateName: name, PrivateDNS: i.dns, Type: i.ci.Str("sku"), LaunchTime: i.ci.Str("createdAt"),
				AZ: i.az, SubnetID: i.vpc.subnetID, VpcID: i.vpc.id, PrivateIP: i.ip, Architecture: "x86_64", RootDevice: "/dev/xvda",
				Devices:    []blockDevice{{Device: "/dev/xvda", VolumeID: i.volume, Status: "attached"}},
				Interfaces: []eni{{ID: "eni-" + cloudsim.Hex("aws-eni"+i.id, idHexLen), SubnetID: i.vpc.subnetID, VpcID: i.vpc.id, Mac: i.mac, PrivateIP: i.ip, PrivateDNS: i.dns, Addresses: []privateIP{{i.ip, true}}}},
				Platform:   "Linux/UNIX", Tags: tagSet(tagsOf(i.ci)),
			}}})
		}
		sim.WriteXML(w, http.StatusOK, doc)
	case "DescribeVpcs":
		list := a.vpcsIn(region)
		start, end, next := cloudsim.Window(len(list), offset, size)
		doc := describeVpcs{NS: ec2NS, RequestID: requestID(r), NextToken: next}
		for _, v := range list[start:end] {
			doc.Vpcs = append(doc.Vpcs, vpcDoc{ID: v.id, OwnerID: a.id, State: "available", CIDR: v.cidr, IsDefault: v.isDefault, Tags: tagSet(v.tags)})
		}
		sim.WriteXML(w, http.StatusOK, doc)
	case "DescribeSubnets":
		list := a.vpcsIn(region)
		start, end, next := cloudsim.Window(len(list), offset, size)
		doc := describeSubnets{NS: ec2NS, RequestID: requestID(r), NextToken: next}
		for _, v := range list[start:end] {
			doc.Subnets = append(doc.Subnets, subnetDoc{ID: v.subnetID, State: "available", VpcID: v.id, OwnerID: a.id, CIDR: v.subnetCIDR,
				Available: subnetUsable - v.hosts, AZ: v.az, Tags: []tagItem{{"Name", v.subnetName}}})
		}
		sim.WriteXML(w, http.StatusOK, doc)
	default:
		fail(w, r, "ec2", http.StatusBadRequest, "InvalidAction", "The action "+q.Get("Action")+" is not valid for this web service.")
	}
}

// subnetUsable is the usable address count of a /24 in a VPC (AWS reserves five addresses per subnet).
const subnetUsable = 251

func (a *account) rds(w http.ResponseWriter, r *http.Request, region string) {
	q := r.URL.Query()
	if q.Get("Action") != "DescribeDBInstances" || q.Get("Version") != rdsVersion {
		fail(w, r, "rds", http.StatusBadRequest, "InvalidAction", "unsupported action or version")
		return
	}
	offset, ok := cloudsim.Offset(q.Get("Marker"))
	if !ok {
		fail(w, r, "rds", http.StatusBadRequest, "InvalidParameterValue", "Invalid Marker")
		return
	}
	var list []*database
	for _, d := range a.dbs {
		if d.region == region {
			list = append(list, d)
		}
	}
	start, end, next := cloudsim.Window(len(list), offset, cloudsim.Size(q.Get("MaxRecords")))
	doc := describeDBs{NS: rdsNS, Marker: next, RequestID: requestID(r)}
	for _, d := range list[start:end] {
		status := "available"
		if d.ci.Str("state") == "stopped" {
			status = "stopped"
		}
		doc.DBs = append(doc.DBs, dbDoc{Identifier: d.ci.Name, Arn: d.arn, Class: "db.r6g.large", Engine: "postgres", Version: "16.4", Status: status,
			Address: d.host, Port: dbPort, Storage: dbStorageGb, StorageType: d.ci.Str("sku"), MultiAZ: d.ci.Str("tagEnvironment") == "prod",
			AZ: d.vpc.az, VpcID: d.vpc.id, Created: d.ci.Str("createdAt")})
	}
	sim.WriteXML(w, http.StatusOK, doc)
}

func (a *account) elb(w http.ResponseWriter, r *http.Request, region string) {
	q := r.URL.Query()
	if q.Get("Action") != "DescribeLoadBalancers" || q.Get("Version") != elbVersion {
		fail(w, r, "elasticloadbalancing", http.StatusBadRequest, "InvalidAction", "unsupported action or version")
		return
	}
	offset, ok := cloudsim.Offset(q.Get("Marker"))
	if !ok {
		fail(w, r, "elasticloadbalancing", http.StatusBadRequest, "ValidationError", "Invalid Marker")
		return
	}
	var list []*balancer
	for _, l := range a.lbs {
		if l.region == region {
			list = append(list, l)
		}
	}
	start, end, next := cloudsim.Window(len(list), offset, cloudsim.Size(q.Get("PageSize")))
	doc := describeLBs{NS: elbNS, NextMarker: next, RequestID: requestID(r)}
	for _, l := range list[start:end] {
		doc.LBs = append(doc.LBs, lbDoc{Arn: l.arn, DNSName: l.dns, Created: l.ci.Str("createdAt"), Name: l.ci.Name, Scheme: "internal",
			VpcID: l.vpc.id, State: "active", Type: "application", AZ: l.vpc.az, Subnet: l.vpc.subnetID})
	}
	sim.WriteXML(w, http.StatusOK, doc)
}

// eks serves ListClusters and DescribeCluster; the estate has no EKS clusters, so every region lists none.
func (a *account) eks(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/clusters" {
		if _, ok := cloudsim.Offset(r.URL.Query().Get("nextToken")); !ok {
			fail(w, r, "eks", http.StatusBadRequest, "InvalidParameterException", "invalid nextToken")
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"clusters": []string{}})
		return
	}
	fail(w, r, "eks", http.StatusNotFound, "ResourceNotFoundException", "No cluster found for name: "+strings.TrimPrefix(r.URL.Path, "/clusters/")+".")
}

func (a *account) handler(env *sim.Env) http.Handler {
	key := accessKey(env)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sc, serr := verify(r, key, env.Secret, time.Now())
		if serr != nil {
			fail(w, r, serviceFromHost(r), http.StatusForbidden, serr.code, serr.message)
			return
		}
		if r.Method != http.MethodGet {
			fail(w, r, sc.service, http.StatusBadRequest, "InvalidAction", "the simulator serves GET requests")
			return
		}
		switch sc.service {
		case "sts":
			q := r.URL.Query()
			if q.Get("Action") != "GetCallerIdentity" || q.Get("Version") != stsVersion {
				fail(w, r, "sts", http.StatusBadRequest, "InvalidAction", "unsupported action or version")
				return
			}
			sim.WriteXML(w, http.StatusOK, callerIdentity{NS: stsNS, Arn: "arn:aws:iam::" + a.id + ":user/" + env.User, UserID: "AIDA" + strings.ToUpper(cloudsim.Hex("aws-user"+env.User, keyIDLen)), Account: a.id, RequestID: requestID(r)})
		case "ec2":
			a.ec2(w, r, sc.region)
		case "rds":
			a.rds(w, r, sc.region)
		case "elasticloadbalancing":
			a.elb(w, r, sc.region)
		case "eks":
			a.eks(w, r)
		default:
			fail(w, r, sc.service, http.StatusBadRequest, "UnknownService", "the simulator does not serve "+sc.service)
		}
	})
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	views := map[string]*account{}
	var keys []string
	for _, a := range accounts(e) {
		views[a.ID("accountId")] = load(e, a)
		keys = append(keys, a.ID("accountId"))
	}
	return sim.ServeEach(env, keys, true, func(k string) http.Handler { return views[k].handler(env) })
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	var runs []sim.Run
	for _, a := range accounts(e) {
		acct := load(e, a)
		regions := []any{}
		for _, r := range append(append([]string{}, acct.regions...), emptyRegion) {
			regions = append(regions, r)
		}
		run := sim.Run{
			Name:           acct.id,
			Targets:        []sim.Target{{Kind: "account", Value: acct.id, Label: a.Name}},
			Options:        map[string]any{"endpointUrl": ep.Devices[acct.id], "verifyTls": true, "caCertPem": env.CA.PEM, "regions": regions},
			CredentialType: "api_token",
			Credential:     &sim.Credential{Type: "api_token", Fields: map[string]string{"accessKeyId": accessKey(env), "secretAccessKey": env.Secret}},
		}
		accountName := "AWS " + acct.id
		run.Expect.CIs = append(run.Expect.CIs, sim.ExpectCI{Type: "cloud_account", Name: accountName, Identity: a.Identity})
		resource := func(ci *estate.CI, name string) {
			if ci != nil {
				run.Expect.EstateCI(ci)
			} else {
				run.Expect.CI("cloud_resource", name)
			}
			run.Expect.Rel("member_of", "cloud_resource", name, "cloud_account", accountName)
		}
		for _, v := range acct.vpcs {
			resource(v.ci, v.name)
			run.Expect.CI("subnet", v.subnetName)
			run.Expect.Rel("member_of", "subnet", v.subnetName, "cloud_resource", v.name)
		}
		for _, i := range acct.instances {
			resource(i.ci, i.ci.Name)
			run.Expect.CI("vm", i.ci.Name)
			run.Expect.CI("ip_address", i.ip)
			run.Expect.Rel("hosted_on", "vm", i.ci.Name, "cloud_resource", i.ci.Name)
			run.Expect.Rel("uses_ip", "vm", i.ci.Name, "ip_address", i.ip)
			run.Expect.Rel("in_subnet", "ip_address", i.ip, "subnet", i.vpc.subnetName)
		}
		for _, d := range acct.dbs {
			resource(d.ci, d.ci.Name)
			run.Expect.CI("database_cluster", d.ci.Name)
			run.Expect.Rel("hosted_on", "database_cluster", d.ci.Name, "cloud_resource", d.ci.Name)
		}
		for _, l := range acct.lbs {
			resource(l.ci, l.ci.Name)
			run.Expect.CI("load_balancer", l.ci.Name)
			run.Expect.Rel("hosted_on", "load_balancer", l.ci.Name, "cloud_resource", l.ci.Name)
		}
		runs = append(runs, run)
	}
	return runs
}
