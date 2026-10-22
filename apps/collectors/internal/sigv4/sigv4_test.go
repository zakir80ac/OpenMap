// T-056 REQ-DISC-017 — SigV4 against the worked example in the AWS S3 "Signature Calculations for
// the Authorization Header" documentation (GET object with a Range header).
package sigv4

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestKnownAnswer(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	req.Header.Set("Range", "bytes=0-9")
	at := time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC)
	Sign(req, Credentials{AccessKeyID: "AKIAIOSFODNN7EXAMPLE", SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}, "us-east-1", "s3", EmptyPayloadHash, at)
	auth := req.Header.Get("Authorization")
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if auth != want {
		t.Fatalf("authorization mismatch:\n got %s\nwant %s", auth, want)
	}
	if req.Header.Get("X-Amz-Date") != "20130524T000000Z" {
		t.Fatalf("x-amz-date wrong: %s", req.Header.Get("X-Amz-Date"))
	}
}

func TestQueryCanonicalisation(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://s3.example/?list-type=2&prefix=a%2Fb&max-keys=10", nil)
	Sign(req, Credentials{AccessKeyID: "k", SecretAccessKey: "s", SessionToken: "tok"}, "eu-central-1", "s3", EmptyPayloadHash, time.Unix(0, 0))
	if !strings.Contains(req.Header.Get("Authorization"), "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,") {
		t.Fatalf("session token not signed: %s", req.Header.Get("Authorization"))
	}
}
