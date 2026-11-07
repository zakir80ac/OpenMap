// T-425 REQ-DISC-010 REQ-QA-005 — a job's endpointUrl sends every service and region to one gateway (sovereign
// partitions, VPC-endpoint proxies, emulators) while each request stays signed for its own service and region;
// caCertPem makes that gateway's private CA verify instead of failing or being skipped; and RDS, ELBv2 and EKS
// follow Marker / NextMarker / nextToken so accounts with more than one page are read whole.
package aws

import (
	"context"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func gateway(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		q := r.URL.Query()
		service := ""
		switch {
		case q.Get("Action") == "GetCallerIdentity":
			service = "sts"
		case q.Get("Action") == "DescribeDBInstances":
			service = "rds"
		case q.Get("Action") == "DescribeLoadBalancers":
			service = "elasticloadbalancing"
		case strings.HasPrefix(r.URL.Path, "/clusters"):
			service = "eks"
		default:
			service = "ec2"
		}
		if !strings.Contains(auth, "/me-south-1/"+service+"/aws4_request") {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`<Response><Errors><Error><Code>SignatureDoesNotMatch</Code></Error></Errors></Response>`))
			return
		}
		switch {
		case q.Get("Action") == "GetCallerIdentity":
			_, _ = w.Write([]byte(`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account><Arn>arn:aws:iam::123456789012:user/openmap</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`))
		case q.Get("Action") == "DescribeInstances":
			_, _ = w.Write([]byte(`<DescribeInstancesResponse><reservationSet/></DescribeInstancesResponse>`))
		case q.Get("Action") == "DescribeVpcs":
			_, _ = w.Write([]byte(`<DescribeVpcsResponse><vpcSet/></DescribeVpcsResponse>`))
		case q.Get("Action") == "DescribeSubnets":
			_, _ = w.Write([]byte(`<DescribeSubnetsResponse><subnetSet/></DescribeSubnetsResponse>`))
		case q.Get("Action") == "DescribeDBInstances" && q.Get("Marker") == "":
			_, _ = w.Write([]byte(`<DescribeDBInstancesResponse><DescribeDBInstancesResult><Marker>m2</Marker><DBInstances><DBInstance><DBInstanceIdentifier>db-a</DBInstanceIdentifier><DBInstanceArn>arn:aws:rds:me-south-1:123456789012:db:db-a</DBInstanceArn><Engine>postgres</Engine></DBInstance></DBInstances></DescribeDBInstancesResult></DescribeDBInstancesResponse>`))
		case q.Get("Action") == "DescribeDBInstances" && q.Get("Marker") == "m2":
			_, _ = w.Write([]byte(`<DescribeDBInstancesResponse><DescribeDBInstancesResult><DBInstances><DBInstance><DBInstanceIdentifier>db-b</DBInstanceIdentifier><DBInstanceArn>arn:aws:rds:me-south-1:123456789012:db:db-b</DBInstanceArn><Engine>mysql</Engine></DBInstance></DBInstances></DescribeDBInstancesResult></DescribeDBInstancesResponse>`))
		case q.Get("Action") == "DescribeLoadBalancers" && q.Get("Marker") == "":
			_, _ = w.Write([]byte(`<DescribeLoadBalancersResponse><DescribeLoadBalancersResult><NextMarker>n2</NextMarker><LoadBalancers><member><LoadBalancerArn>arn:aws:elasticloadbalancing:me-south-1:123456789012:loadbalancer/app/lb-a/1</LoadBalancerArn><LoadBalancerName>lb-a</LoadBalancerName><Type>application</Type></member></LoadBalancers></DescribeLoadBalancersResult></DescribeLoadBalancersResponse>`))
		case q.Get("Action") == "DescribeLoadBalancers":
			_, _ = w.Write([]byte(`<DescribeLoadBalancersResponse><DescribeLoadBalancersResult><LoadBalancers><member><LoadBalancerArn>arn:aws:elasticloadbalancing:me-south-1:123456789012:loadbalancer/net/lb-b/2</LoadBalancerArn><LoadBalancerName>lb-b</LoadBalancerName><Type>network</Type></member></LoadBalancers></DescribeLoadBalancersResult></DescribeLoadBalancersResponse>`))
		case r.URL.Path == "/clusters" && q.Get("nextToken") == "":
			_, _ = w.Write([]byte(`{"clusters":["k-a"],"nextToken":"t2"}`))
		case r.URL.Path == "/clusters":
			_, _ = w.Write([]byte(`{"clusters":["k-b"]}`))
		case strings.HasPrefix(r.URL.Path, "/clusters/"):
			n := strings.TrimPrefix(r.URL.Path, "/clusters/")
			_, _ = w.Write([]byte(`{"cluster":{"name":"` + n + `","arn":"arn:aws:eks:me-south-1:123456789012:cluster/` + n + `","status":"ACTIVE"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func gatewayJob(srv *httptest.Server, caPem string) map[string]any {
	return map[string]any{optionEndpoint: srv.URL, optionVerify: true, optionCA: caPem, optionRegions: []any{"me-south-1"}}
}

func TestEndpointURLWithPrivateCA(t *testing.T) {
	srv := gateway(t)
	defer srv.Close()
	caPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
	cred := &contract.Credential{Type: "api_token", Fields: map[string]string{credAccessKey: "AKIATEST", credSecretKey: "s"}}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "123456789012"}, cred, gatewayJob(srv, caPem))
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, c := range obs.Cis {
		names[c.Type+"/"+c.Name] = true
	}
	for _, want := range []string{typeDB + "/db-a", typeDB + "/db-b", typeLB + "/lb-a", typeLB + "/lb-b", typeResource + "/k-a", typeResource + "/k-b"} {
		if !names[want] {
			t.Errorf("second page not followed: %s missing from %v", want, names)
		}
	}
	// Without the bundle the gateway's private CA must fail verification, not be skipped.
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: "123456789012"}, cred, gatewayJob(srv, "")); err == nil || !strings.Contains(err.Error(), "unreachable") {
		t.Fatalf("expected an unverified private CA to fail as unreachable, got %v", err)
	}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account"}, cred, gatewayJob(srv, "not a pem")); err == nil {
		t.Fatal("expected a caCertPem without a certificate to be rejected")
	}
}
