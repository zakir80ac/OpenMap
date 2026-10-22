// T-072 REQ-DISC-010 — ECS, RDS, SLB (RPC signature) and ACK (ROA signature) served by httptest: every signature is
// recomputed server-side from the request, DescribeInstances pages twice, and the emitted account, VPC, VSwitch
// subnet, instances with addresses and OS, RDS cluster, SLB and ACK cluster are checked.
package alibaba

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	keyID  = "LTAI5tTestKey"
	secret = "test-secret-value"
)

func rpcServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		params := map[string]string{}
		for k := range q {
			params[k] = q.Get(k)
		}
		if params["AccessKeyId"] != keyID || params["Format"] != "JSON" || RPCSignature(http.MethodGet, params, secret) != params["Signature"] {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"Code":"SignatureDoesNotMatch"}`))
			return
		}
		if params["RegionId"] != "me-central-1" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch params["Action"] {
		case "DescribeInstances":
			if params["PageNumber"] == "1" {
				_, _ = w.Write([]byte(`{"TotalCount":2,"PageNumber":1,"PageSize":100,"Instances":{"Instance":[{"InstanceId":"i-abc1","InstanceName":"app-ryd-01","HostName":"app-ryd-01","ZoneId":"me-central-1a","RegionId":"me-central-1","InstanceType":"ecs.g7.xlarge","Status":"Running","OSName":"Alibaba Cloud Linux 3.2104","OSType":"linux","Cpu":4,"Memory":16384,"CreationTime":"2026-03-01T08:00Z","PublicIpAddress":{"IpAddress":[]},"EipAddress":{"IpAddress":"47.80.1.5"},"VpcAttributes":{"VpcId":"vpc-prod","VSwitchId":"vsw-app","PrivateIpAddress":{"IpAddress":["10.80.1.11"]}}}]}}`))
				return
			}
			_, _ = w.Write([]byte(`{"TotalCount":2,"PageNumber":2,"PageSize":100,"Instances":{"Instance":[{"InstanceId":"i-abc2","InstanceName":"app-ryd-02","ZoneId":"me-central-1a","InstanceType":"ecs.g7.xlarge","Status":"Stopped","OSName":"Windows Server 2022","OSType":"windows","Cpu":4,"Memory":16384,"PublicIpAddress":{"IpAddress":["47.80.1.6"]},"VpcAttributes":{"VpcId":"vpc-prod","VSwitchId":"vsw-app","PrivateIpAddress":{"IpAddress":["10.80.1.12"]}}}]}}`))
		case "DescribeVpcs":
			_, _ = w.Write([]byte(`{"TotalCount":1,"PageNumber":1,"PageSize":100,"Vpcs":{"Vpc":[{"VpcId":"vpc-prod","VpcName":"prod-vpc","CidrBlock":"10.80.0.0/16","Status":"Available"}]}}`))
		case "DescribeVSwitches":
			_, _ = w.Write([]byte(`{"TotalCount":1,"PageNumber":1,"PageSize":100,"VSwitches":{"VSwitch":[{"VSwitchId":"vsw-app","VSwitchName":"app","VpcId":"vpc-prod","CidrBlock":"10.80.1.0/24","ZoneId":"me-central-1a"}]}}`))
		case "DescribeDBInstances":
			_, _ = w.Write([]byte(`{"TotalRecordCount":1,"PageNumber":1,"PageRecordCount":1,"Items":{"DBInstance":[{"DBInstanceId":"rm-ledger","DBInstanceDescription":"ledger","Engine":"PostgreSQL","EngineVersion":"16.0","DBInstanceStatus":"Running","DBInstanceClass":"pg.n4.2c.2m","Category":"HighAvailability","ZoneId":"me-central-1a","VpcId":"vpc-prod","VSwitchId":"vsw-app","ConnectionString":"rm-ledger.pg.rds.aliyuncs.com"}]}}`))
		case "DescribeLoadBalancers":
			_, _ = w.Write([]byte(`{"TotalCount":1,"PageNumber":1,"PageSize":100,"LoadBalancers":{"LoadBalancer":[{"LoadBalancerId":"lb-web","LoadBalancerName":"web-slb","LoadBalancerStatus":"active","Address":"10.80.1.250","AddressType":"intranet","LoadBalancerSpec":"slb.s2.small","VpcId":"vpc-prod","VSwitchId":"vsw-app"}]}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func roaServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		acs := map[string]string{}
		for k, v := range r.Header {
			if strings.HasPrefix(strings.ToLower(k), "x-acs-") {
				acs[strings.ToLower(k)] = v[0]
			}
		}
		expected := "acs " + keyID + ":" + ROASignature(r.Method, r.Header.Get("Accept"), r.Header.Get("Date"), acs, r.URL.RequestURI(), secret)
		if r.Header.Get("Authorization") != expected || acs["x-acs-version"] != csVersion {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"cluster_id":"c-pay","name":"payments-ack","state":"running","current_version":"1.32.1-aliyun.1","size":5,"vpc_id":"vpc-prod","region_id":"me-central-1","cluster_type":"ManagedKubernetes"},{"cluster_id":"c-other","name":"other-region","state":"running","vpc_id":"vpc-x","region_id":"cn-hangzhou","cluster_type":"ManagedKubernetes"}]`))
	}))
}

func TestWalkAndEmit(t *testing.T) {
	rpc := rpcServer(t)
	defer rpc.Close()
	roa := roaServer(t)
	defer roa.Close()
	cred := &contract.Credential{Type: credType, Fields: map[string]string{credKeyID: keyID, credSecret: secret}}
	options := map[string]any{optionRegion: "me-central-1", optionECS: rpc.URL, optionRDS: rpc.URL, optionSLB: rpc.URL, optionCS: roa.URL}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "bank-alibaba"}, cred, options)
	if err != nil {
		t.Fatal(err)
	}
	types := map[string]int{}
	byName := map[string]contract.ObservedCi{}
	for _, ci := range obs.Cis {
		types[ci.Type]++
		byName[ci.Name] = ci
	}
	if types[typeAccount] != 1 || types[typeResource] != 2 || types[typeVM] != 2 || types[typeSubnet] != 1 || types[typeOS] != 2 || types[typeDBClust] != 1 || types[typeLB] != 1 {
		t.Fatalf("unexpected CI mix: %+v", types)
	}
	// 2 private + eip + public + slb vip
	if types[typeIP] != 5 {
		t.Fatalf("expected 5 addresses, got %d", types[typeIP])
	}
	vm := byName["app-ryd-01"]
	if vm.Identity["hypervisorRef"] != "alibaba:me-central-1a" || vm.Attributes["health"] != "healthy" || vm.Attributes["vpc"] != "prod-vpc" {
		t.Fatalf("vm wrong: %+v", vm)
	}
	if byName["app-ryd-02"].Attributes["health"] != "down" || byName["Windows Server 2022"].Identity["family"] != "windows" {
		t.Fatalf("second vm wrong")
	}
	if byName["prod-vpc/app"].Identity["cidr"] != "10.80.1.0/24" || byName["ledger"].Attributes["engine"] != "postgresql" || byName["web-slb"].Attributes["addressType"] != "intranet" || byName["payments-ack"].Attributes["nodeCount"] != 5 {
		t.Fatalf("managed services wrong")
	}
	if _, ok := byName["other-region"]; ok {
		t.Fatal("clusters from other regions must be filtered")
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relInSubnet] != 2 || rels[relInstalled] != 2 || rels[relRunsOn] != 2 || rels[relUsesIP] != 5 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
	var vipVrf string
	for _, ci := range obs.Cis {
		if ci.Type == typeIP && ci.Identity["address"] == "10.80.1.250" {
			vipVrf = ci.Identity["vrfRef"]
		}
	}
	if vipVrf != "prod-vpc" {
		t.Fatalf("intranet VIP must sit in the VPC vrf, got %q", vipVrf)
	}
}

func TestBadSecret(t *testing.T) {
	rpc := rpcServer(t)
	defer rpc.Close()
	cred := &contract.Credential{Type: credType, Fields: map[string]string{credKeyID: keyID, credSecret: "wrong"}}
	_, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "x"}, cred, map[string]any{optionRegion: "me-central-1", optionECS: rpc.URL})
	if err == nil || !strings.Contains(err.Error(), contract.ErrAuthFailed) {
		t.Fatalf("expected auth_failed, got %v", err)
	}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: "x"}, cred, map[string]any{}); err == nil || !strings.Contains(err.Error(), optionRegion) {
		t.Fatalf("expected missing options to be named, got %v", err)
	}
	// Known-answer: the RFC 3986 encoding Alibaba expects.
	if percentEncode("a b*c~d") != "a%20b%2Ac~d" {
		t.Fatalf("percentEncode wrong: %q", percentEncode("a b*c~d"))
	}
	var meta pagedPayload
	_ = json.Unmarshal([]byte(`{"TotalCount":3}`), &meta)
	if meta.TotalCount != 3 {
		t.Fatal("paged payload decode wrong")
	}
	_ = time.Now()
}
