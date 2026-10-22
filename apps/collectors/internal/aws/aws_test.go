// T-060 REQ-DISC-010 — serves STS, EC2 (with a NextToken page), RDS, ELBv2 and EKS responses from
// one httptest server standing in for every regional endpoint, checks SigV4 headers and emission.
package aws

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/sigv4"
)

const instancesPage1 = `<DescribeInstancesResponse><nextToken>p2</nextToken><reservationSet><item><ownerId>123456789012</ownerId><instancesSet><item>
<instanceId>i-0abc</instanceId><imageId>ami-1</imageId><instanceState><name>running</name></instanceState><privateDnsName>ip-10-50-1-10.me-south-1.compute.internal</privateDnsName><dnsName>ec2-3-29-1-1.me-south-1.compute.amazonaws.com</dnsName>
<instanceType>m6i.large</instanceType><privateIpAddress>10.50.1.10</privateIpAddress><ipAddress>3.29.1.1</ipAddress><vpcId>vpc-1</vpcId><subnetId>subnet-1</subnetId><placement><availabilityZone>me-south-1a</availabilityZone></placement><platformDetails>Linux/UNIX</platformDetails><architecture>x86_64</architecture><launchTime>2026-09-01T00:00:00.000Z</launchTime>
<tagSet><item><key>Name</key><value>erp-app-01</value></item><item><key>env</key><value>prod</value></item></tagSet>
<networkInterfaceSet><item><macAddress>0a:1b:2c:3d:4e:5f</macAddress></item></networkInterfaceSet><blockDeviceMapping><item><ebs><volumeId>vol-1</volumeId></ebs></item></blockDeviceMapping>
</item></instancesSet></item></reservationSet></DescribeInstancesResponse>`

const instancesPage2 = `<DescribeInstancesResponse><reservationSet><item><instancesSet><item><instanceId>i-0def</instanceId><instanceState><name>stopped</name></instanceState><instanceType>t3.small</instanceType><privateIpAddress>10.50.1.11</privateIpAddress><vpcId>vpc-1</vpcId><subnetId>subnet-1</subnetId></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`

func server(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 Credential=AKIATEST/") || !strings.Contains(auth, "/aws4_request, SignedHeaders=") {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`<Response><Errors><Error><Code>AuthFailure</Code></Error></Errors></Response>`))
			return
		}
		q := r.URL.Query()
		switch {
		case q.Get("Action") == "GetCallerIdentity":
			_, _ = w.Write([]byte(`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account><Arn>arn:aws:iam::123456789012:user/openmap</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`))
		case q.Get("Action") == "DescribeInstances" && q.Get("NextToken") == "":
			_, _ = w.Write([]byte(instancesPage1))
		case q.Get("Action") == "DescribeInstances":
			_, _ = w.Write([]byte(instancesPage2))
		case q.Get("Action") == "DescribeVpcs":
			_, _ = w.Write([]byte(`<DescribeVpcsResponse><vpcSet><item><vpcId>vpc-1</vpcId><cidrBlock>10.50.0.0/16</cidrBlock><isDefault>false</isDefault><state>available</state><tagSet><item><key>Name</key><value>prod-vpc</value></item></tagSet></item></vpcSet></DescribeVpcsResponse>`))
		case q.Get("Action") == "DescribeSubnets":
			_, _ = w.Write([]byte(`<DescribeSubnetsResponse><subnetSet><item><subnetId>subnet-1</subnetId><vpcId>vpc-1</vpcId><cidrBlock>10.50.1.0/24</cidrBlock><availabilityZone>me-south-1a</availabilityZone><availableIpAddressCount>240</availableIpAddressCount></item></subnetSet></DescribeSubnetsResponse>`))
		case q.Get("Action") == "DescribeDBInstances":
			_, _ = w.Write([]byte(`<DescribeDBInstancesResponse><DescribeDBInstancesResult><DBInstances><DBInstance><DBInstanceIdentifier>erp-pg</DBInstanceIdentifier><DBInstanceArn>arn:aws:rds:me-south-1:123456789012:db:erp-pg</DBInstanceArn><Engine>postgres</Engine><EngineVersion>16.4</EngineVersion><DBInstanceClass>db.r6g.large</DBInstanceClass><DBInstanceStatus>available</DBInstanceStatus><Endpoint><Address>erp-pg.abc.me-south-1.rds.amazonaws.com</Address><Port>5432</Port></Endpoint><MultiAZ>true</MultiAZ><AllocatedStorage>200</AllocatedStorage><PubliclyAccessible>false</PubliclyAccessible></DBInstance></DBInstances></DescribeDBInstancesResult></DescribeDBInstancesResponse>`))
		case q.Get("Action") == "DescribeLoadBalancers":
			_, _ = w.Write([]byte(`<DescribeLoadBalancersResponse><DescribeLoadBalancersResult><LoadBalancers><member><LoadBalancerArn>arn:aws:elasticloadbalancing:me-south-1:123456789012:loadbalancer/app/erp/abc</LoadBalancerArn><LoadBalancerName>erp</LoadBalancerName><DNSName>erp-123.me-south-1.elb.amazonaws.com</DNSName><Scheme>internet-facing</Scheme><Type>application</Type><VpcId>vpc-1</VpcId><State><Code>active</Code></State></member></LoadBalancers></DescribeLoadBalancersResult></DescribeLoadBalancersResponse>`))
		case r.URL.Path == "/clusters":
			_, _ = w.Write([]byte(`{"clusters":["prod-eks"]}`))
		case r.URL.Path == "/clusters/prod-eks":
			_, _ = w.Write([]byte(`{"cluster":{"name":"prod-eks","arn":"arn:aws:eks:me-south-1:123456789012:cluster/prod-eks","version":"1.31","endpoint":"https://eks.example","status":"ACTIVE"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func count(cis []contract.ObservedCi, typ string) int {
	n := 0
	for _, c := range cis {
		if c.Type == typ {
			n++
		}
	}
	return n
}

func TestWalkAndEmit(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c := NewClient(sigv4.Credentials{AccessKeyID: "AKIATEST", SecretAccessKey: "s"}, func(_, _ string) string { return srv.URL }, false)
	inv, err := c.Walk(context.Background(), []string{"me-south-1"})
	if err != nil {
		t.Fatal(err)
	}
	if inv.AccountID != "123456789012" || len(inv.Regions) != 1 || len(inv.Regions[0].Instances) != 2 || len(inv.Regions[0].EKSClusters) != 1 {
		t.Fatalf("walk wrong: %+v", inv)
	}
	obs := Emit(inv, defaultSuffix, time.Now())
	if count(obs.Cis, typeAccount) != 1 || count(obs.Cis, typeResource) != 6 || count(obs.Cis, typeVM) != 2 || count(obs.Cis, typeSubnet) != 1 || count(obs.Cis, typeIP) != 3 || count(obs.Cis, typeDB) != 1 || count(obs.Cis, typeLB) != 1 {
		t.Fatalf("unexpected CI mix: acct=%d res=%d vm=%d subnet=%d ip=%d db=%d lb=%d", count(obs.Cis, typeAccount), count(obs.Cis, typeResource), count(obs.Cis, typeVM), count(obs.Cis, typeSubnet), count(obs.Cis, typeIP), count(obs.Cis, typeDB), count(obs.Cis, typeLB))
	}
	for _, ci := range obs.Cis {
		if ci.Type == typeVM && ci.Name == "erp-app-01" {
			if ci.Identity["instanceUuid"] != "i-0abc" || ci.Identity["fqdn"] != "ip-10-50-1-10.me-south-1.compute.internal" || ci.Attributes["internetExposed"] != true {
				t.Fatalf("vm wrong: %+v", ci)
			}
		}
		if ci.Type == typeDB && (ci.Identity["engine"] != "postgres" || ci.Attributes["role"] != "multi-az") {
			t.Fatalf("rds wrong: %+v", ci)
		}
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relMemberOf] != 7 || rels[relHostedOn] != 4 || rels[relUsesIP] != 3 || rels[relInSubnet] != 2 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
}

func TestAuthFailure(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c := NewClient(sigv4.Credentials{AccessKeyID: "WRONG", SecretAccessKey: "s"}, func(_, _ string) string { return srv.URL }, false)
	if _, err := c.Walk(context.Background(), []string{"me-south-1"}); err == nil || !strings.Contains(err.Error(), "auth_failed") {
		t.Fatalf("expected auth_failed, got %v", err)
	}
}
