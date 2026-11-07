// T-438 REQ-QA-005 REQ-DISC-018 — regression found by the simulated HAProxy: a stats page behind a private CA
// is collected with verifyTls=true when the job pins that CA (caCertPem), and still refused without it.
package haproxy

import (
	"context"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const statsCSV = "# pxname,svname,status,weight,type,addr,mode,algo,check_status\n" +
	"fe_api,FRONTEND,OPEN,,0,,http,,\n" +
	"be_api,api1,UP,1,2,10.4.0.30:8443,http,,L4OK\n" +
	"be_api,BACKEND,UP,1,1,,http,leastconn,\n"

func TestStatsBehindPrivateCA(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() != defaultPath+csvSuffix {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte(statsCSV))
	}))
	defer srv.Close()
	caPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
	target := contract.Target{Kind: "url", Value: srv.URL}

	obs, err := Collector{}.Collect(context.Background(), target, nil, map[string]any{optionVerify: true, optionCA: caPem})
	if err != nil {
		t.Fatalf("pinned CA rejected: %v", err)
	}
	members := 0
	for _, ci := range obs.Cis {
		if ci.Type == typeListener && ci.Identity["hostRef"] == "10.4.0.30" {
			members++
		}
	}
	if members != 1 {
		t.Fatalf("expected the be_api member listener, got %+v", obs.Cis)
	}
	if _, err := (Collector{}).Collect(context.Background(), target, nil, map[string]any{optionVerify: true}); err == nil {
		t.Fatal("an unknown CA was accepted with verification on")
	}
}
