// T-351 REQ-QA-005 REQ-DISC-014 — TransportFor pins a private CA for token and login endpoints: the server's own
// CA is accepted, a request without it fails verification, and a bundle without a certificate is refused.
package restjson

import (
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTransportForPinsCA(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer srv.Close()
	caPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))

	pinned, err := TransportFor(true, caPem)
	if err != nil {
		t.Fatal(err)
	}
	res, err := (&http.Client{Transport: pinned}).Get(srv.URL)
	if err != nil {
		t.Fatalf("pinned CA rejected: %v", err)
	}
	res.Body.Close()

	plain, err := TransportFor(true, "")
	if err != nil {
		t.Fatal(err)
	}
	if res, err := (&http.Client{Transport: plain}).Get(srv.URL); err == nil {
		res.Body.Close()
		t.Fatal("an unknown CA was accepted with verification on")
	}

	if _, err := TransportFor(true, "not a certificate"); err == nil {
		t.Fatal("a bundle without a certificate was accepted")
	}
}
