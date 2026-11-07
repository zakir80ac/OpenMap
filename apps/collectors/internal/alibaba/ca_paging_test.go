// T-429 REQ-DISC-010 REQ-QA-005 — every Alibaba product client trusts the job's caCertPem (Financial Cloud, Apsara
// Stack, proxies behind a private CA); RDS DescribeDBInstances pages by TotalRecordCount (its name for TotalCount),
// so a second page is read instead of silently dropped; and ACK DescribeClustersV1 ({"clusters", "page_info"}) is
// decoded and paged by page_number with the query in the ROA canonical resource. Credential errors Alibaba returns
// as HTTP 400/404 with a Code (SignatureDoesNotMatch, InvalidAccessKeyId.NotFound) classify as auth_failed, and
// Forbidden.* as permission_denied.
package alibaba

import (
	"context"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func pagingServers(t *testing.T) (*httptest.Server, *httptest.Server) {
	t.Helper()
	rpc := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		params := map[string]string{}
		for k := range q {
			params[k] = q.Get(k)
		}
		if q.Get("Signature") != RPCSignature(http.MethodGet, params, secret) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch q.Get("Action") {
		case "DescribeInstances":
			_, _ = w.Write([]byte(`{"TotalCount":0,"PageNumber":1,"PageSize":100,"Instances":{"Instance":[]}}`))
		case "DescribeVpcs":
			_, _ = w.Write([]byte(`{"TotalCount":0,"PageNumber":1,"PageSize":100,"Vpcs":{"Vpc":[]}}`))
		case "DescribeVSwitches":
			_, _ = w.Write([]byte(`{"TotalCount":0,"PageNumber":1,"PageSize":100,"VSwitches":{"VSwitch":[]}}`))
		case "DescribeDBInstances":
			id := "rm-a"
			if q.Get("PageNumber") == "2" {
				id = "rm-b"
			}
			_, _ = w.Write([]byte(`{"TotalRecordCount":2,"PageNumber":` + q.Get("PageNumber") + `,"PageRecordCount":1,"Items":{"DBInstance":[{"DBInstanceId":"` + id + `","DBInstanceDescription":"` + id + `","Engine":"MySQL","DBInstanceStatus":"Running"}]}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	roa := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		acs := map[string]string{}
		for k, v := range r.Header {
			if strings.HasPrefix(strings.ToLower(k), "x-acs-") {
				acs[strings.ToLower(k)] = v[0]
			}
		}
		resource := canonicalResource(r.URL.Path, r.URL.Query())
		if r.Header.Get("Authorization") != "acs "+keyID+":"+ROASignature(r.Method, r.Header.Get("Accept"), r.Header.Get("Date"), acs, resource, secret) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		page := r.URL.Query().Get("page_number")
		_, _ = w.Write([]byte(`{"clusters":[{"cluster_id":"c-` + page + `","name":"ack-` + page + `","state":"running","region_id":"me-central-1"}],"page_info":{"page_number":` + page + `,"page_size":1,"total_count":2}}`))
	}))
	return rpc, roa
}

func TestPrivateCAAndSecondPages(t *testing.T) {
	rpc, roa := pagingServers(t)
	defer rpc.Close()
	defer roa.Close()
	pool := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: rpc.Certificate().Raw})) + string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: roa.Certificate().Raw}))
	cred := &contract.Credential{Type: credType, Fields: map[string]string{credKeyID: keyID, credSecret: secret}}
	job := func(ca string) map[string]any {
		return map[string]any{optionRegion: "me-central-1", optionECS: rpc.URL, optionRDS: rpc.URL, optionCS: roa.URL, optionCA: ca}
	}
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "account", Value: "acct"}, cred, job(pool))
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, c := range obs.Cis {
		names[c.Type+"/"+c.Name] = true
	}
	for _, want := range []string{typeDBClust + "/rm-a", typeDBClust + "/rm-b", typeResource + "/ack-1", typeResource + "/ack-2"} {
		if !names[want] {
			t.Errorf("%s missing: %v", want, names)
		}
	}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: "acct"}, cred, job("")); err == nil || !strings.Contains(err.Error(), contract.ErrUnreachable) {
		t.Fatalf("expected the unverified private CA to fail as unreachable, got %v", err)
	}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "account", Value: "acct"}, cred, job("not a pem")); err == nil {
		t.Fatal("expected a caCertPem without a certificate to be rejected")
	}
}

func TestCredentialErrorCodes(t *testing.T) {
	cases := map[string]struct {
		status int
		body   string
		want   string
	}{
		"bad signature":   {http.StatusBadRequest, `{"Code":"SignatureDoesNotMatch","Message":"Specified signature is not matched with our calculation."}`, contract.ErrAuthFailed},
		"unknown key":     {http.StatusNotFound, `{"Code":"InvalidAccessKeyId.NotFound","Message":"Specified access key is not found."}`, contract.ErrAuthFailed},
		"expired":         {http.StatusBadRequest, `{"Code":"InvalidTimeStamp.Expired"}`, contract.ErrAuthFailed},
		"ram denied":      {http.StatusForbidden, `{"Code":"Forbidden.RAM","Message":"User not authorized to operate on the specified resource."}`, contract.ErrPermissionDenied},
		"roa bad sig":     {http.StatusBadRequest, `{"code":"SignatureDoesNotMatch","message":"signature mismatch"}`, contract.ErrAuthFailed},
		"plain not found": {http.StatusNotFound, `{"Code":"InvalidAction.NotFound"}`, contract.ErrUnsupportedDevice},
	}
	for name, tc := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		c, err := newClient(srv.URL, keyID, secret, "")
		if err != nil {
			t.Fatal(err)
		}
		var out any
		err = c.RPC(context.Background(), "DescribeInstances", ecsVersion, nil, &out)
		srv.Close()
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: want %s, got %v", name, tc.want, err)
		}
	}
}
