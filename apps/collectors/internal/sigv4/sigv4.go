// REQ-DISC-017 REQ-DISC-010 — AWS Signature Version 4 request signing (S3 and every other AWS-style
// service, MinIO and Ceph RGW included). Implemented here so collectors carry no cloud SDK and work
// identically against sovereign S3-compatible endpoints.
package sigv4

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	algorithm     = "AWS4-HMAC-SHA256"
	dateFormat    = "20060102"
	amzDateFormat = "20060102T150405Z"
	// EmptyPayloadHash is SHA-256 of the empty string, the payload hash for bodyless requests.
	EmptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
)

// Credentials are the caller's access key pair plus an optional STS session token.
type Credentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// uriEncode applies the AWS URI encoding rules (RFC 3986 unreserved characters kept; '/' kept when encodeSlash is false).
func uriEncode(s string, encodeSlash bool) string {
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

func canonicalQuery(values url.Values) string {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		vs := append([]string{}, values[k]...)
		sort.Strings(vs)
		for _, v := range vs {
			parts = append(parts, uriEncode(k, true)+"="+uriEncode(v, true))
		}
	}
	return strings.Join(parts, "&")
}

// Sign adds X-Amz-Date, X-Amz-Content-Sha256, optional X-Amz-Security-Token and Authorization to req.
// payloadHash is the hex SHA-256 of the body (EmptyPayloadHash for none, or "UNSIGNED-PAYLOAD").
func Sign(req *http.Request, creds Credentials, region, service, payloadHash string, now time.Time) {
	amzDate := now.UTC().Format(amzDateFormat)
	date := now.UTC().Format(dateFormat)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)
	if creds.SessionToken != "" {
		req.Header.Set("X-Amz-Security-Token", creds.SessionToken)
	}
	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	headers := map[string]string{"host": strings.ToLower(host)}
	for k, v := range req.Header {
		lk := strings.ToLower(k)
		if lk == "host" || lk == "authorization" || lk == "user-agent" || lk == "accept-encoding" || lk == "content-length" {
			continue
		}
		headers[lk] = strings.TrimSpace(strings.Join(v, ","))
	}
	names := make([]string, 0, len(headers))
	for k := range headers {
		names = append(names, k)
	}
	sort.Strings(names)
	var canonicalHeaders strings.Builder
	for _, n := range names {
		canonicalHeaders.WriteString(n + ":" + headers[n] + "\n")
	}
	signedHeaders := strings.Join(names, ";")
	path := req.URL.EscapedPath()
	if path == "" {
		path = "/"
	}
	if service != "s3" {
		path = uriEncode(req.URL.Path, false)
		if path == "" {
			path = "/"
		}
	}
	canonicalRequest := strings.Join([]string{req.Method, path, canonicalQuery(req.URL.Query()), canonicalHeaders.String(), signedHeaders, payloadHash}, "\n")
	scope := date + "/" + region + "/" + service + "/aws4_request"
	stringToSign := strings.Join([]string{algorithm, amzDate, scope, sha256Hex(canonicalRequest)}, "\n")
	kDate := hmacSHA256([]byte("AWS4"+creds.SecretAccessKey), date)
	kRegion := hmacSHA256(kDate, region)
	kService := hmacSHA256(kRegion, service)
	kSigning := hmacSHA256(kService, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(kSigning, stringToSign))
	req.Header.Set("Authorization", algorithm+" Credential="+creds.AccessKeyID+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature)
}
