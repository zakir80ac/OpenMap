// REQ-QA-005 REQ-DISC-010 — server-side AWS Signature Version 4 verification, written from the AWS General
// Reference (canonical request, string to sign, derived signing key) independently of the collector's signer, so
// a run proves the collector signs the way AWS checks: access key, credential scope, signed headers, payload hash
// and request time are all enforced.
package aws

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/vendors/cloudsim"
)

const (
	sigAlgorithm  = "AWS4-HMAC-SHA256"
	amzDateLayout = "20060102T150405Z"
	scopeTerm     = "aws4_request"
	scopeParts    = 5
)

// sigError is an AWS error code with its message.
type sigError struct {
	code, message string
}

// scope is what a verified request was signed for.
type scope struct {
	region, service string
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func awsEncode(s string, encodeSlash bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && !encodeSlash:
			b.WriteByte(c)
		default:
			b.WriteString("%" + strings.ToUpper(hex.EncodeToString([]byte{c})))
		}
	}
	return b.String()
}

func canonicalQuery(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		vs := append([]string(nil), q[k]...)
		sort.Strings(vs)
		for _, v := range vs {
			parts = append(parts, awsEncode(k, true)+"="+awsEncode(v, true))
		}
	}
	return strings.Join(parts, "&")
}

func headerValue(r *http.Request, name string) string {
	if name == "host" {
		return strings.ToLower(r.Host)
	}
	v := strings.TrimSpace(strings.Join(r.Header.Values(name), ","))
	return strings.Join(strings.Fields(v), " ")
}

// verify checks the request's SigV4 Authorization header against the simulated key pair.
func verify(r *http.Request, accessKey, secret string, now time.Time) (scope, *sigError) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, sigAlgorithm+" ") {
		return scope{}, &sigError{"MissingAuthenticationToken", "Request is missing Authentication Token"}
	}
	fields := map[string]string{}
	for _, part := range strings.Split(strings.TrimPrefix(auth, sigAlgorithm+" "), ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok {
			fields[k] = v
		}
	}
	cred := strings.Split(fields["Credential"], "/")
	if len(cred) != scopeParts || cred[4] != scopeTerm || fields["SignedHeaders"] == "" || fields["Signature"] == "" {
		return scope{}, &sigError{"IncompleteSignature", "Authorization header requires Credential, SignedHeaders and Signature"}
	}
	if cred[0] != accessKey {
		return scope{}, &sigError{"InvalidClientTokenId", "The security token included in the request is invalid."}
	}
	amzDate := r.Header.Get("X-Amz-Date")
	at, err := time.Parse(amzDateLayout, amzDate)
	if err != nil || !strings.HasPrefix(amzDate, cred[1]) {
		return scope{}, &sigError{"IncompleteSignature", "X-Amz-Date is missing or does not match the credential scope date"}
	}
	if !cloudsim.WithinSkew(at, now) {
		return scope{}, &sigError{"SignatureDoesNotMatch", "Signature expired: request time is outside the allowed window"}
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return scope{}, &sigError{"IncompleteSignature", "unreadable body"}
	}
	payload := sha256Hex(body)
	if h := r.Header.Get("X-Amz-Content-Sha256"); h != "" && h != payload {
		return scope{}, &sigError{"XAmzContentSHA256Mismatch", "The provided x-amz-content-sha256 header does not match what was computed."}
	}
	signed := strings.Split(fields["SignedHeaders"], ";")
	hasHost := false
	var canonicalHeaders strings.Builder
	for _, name := range signed {
		hasHost = hasHost || name == "host"
		canonicalHeaders.WriteString(name + ":" + headerValue(r, name) + "\n")
	}
	if !hasHost || !sort.StringsAreSorted(signed) {
		return scope{}, &sigError{"SignatureDoesNotMatch", "SignedHeaders must be sorted and include host"}
	}
	path := r.URL.EscapedPath()
	if path == "" {
		path = "/"
	}
	canonical := strings.Join([]string{r.Method, awsEncode(path, false), canonicalQuery(r.URL.Query()), canonicalHeaders.String(), fields["SignedHeaders"], payload}, "\n")
	credScope := strings.Join(cred[1:], "/")
	toSign := strings.Join([]string{sigAlgorithm, amzDate, credScope, sha256Hex([]byte(canonical))}, "\n")
	key := hmacSHA256([]byte("AWS4"+secret), cred[1])
	key = hmacSHA256(key, cred[2])
	key = hmacSHA256(key, cred[3])
	key = hmacSHA256(key, scopeTerm)
	want := hex.EncodeToString(hmacSHA256(key, toSign))
	if !hmac.Equal([]byte(want), []byte(fields["Signature"])) {
		return scope{}, &sigError{"SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided."}
	}
	return scope{region: cred[2], service: cred[3]}, nil
}
