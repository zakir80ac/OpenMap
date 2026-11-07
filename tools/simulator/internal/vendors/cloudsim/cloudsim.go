// REQ-QA-005 REQ-DISC-010 — helpers shared by the public-cloud simulators (AWS, Azure, GCP, OCI, Alibaba Cloud):
// deterministic identifiers derived from a seed (SHA-256, never random, so every run renders the same estate),
// opaque page tokens over offsets, and the request-time window the signed APIs enforce.
package cloudsim

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"math/big"
	"strconv"
	"strings"
	"time"
)

const (
	// MaxSkew is the request-time tolerance the signed cloud APIs document (SigV4, OCI signatures and Alibaba
	// timestamps are all rejected outside roughly this window).
	MaxSkew = 15 * time.Minute
	// PageCap bounds every list page the simulators serve when the collector sends no page size, and caps the size
	// it sends. Each of these APIs documents that a caller must follow the page token whenever one is returned, so
	// a small cap is a legitimate server choice; it makes the collectors' paging loops run on a small estate.
	PageCap   = 2
	tokenPref = "o:"
)

// Hex returns n lowercase hex characters derived from seed.
func Hex(seed string, n int) string {
	var b strings.Builder
	for i := 0; b.Len() < n; i++ {
		sum := sha256.Sum256([]byte(seed + "#" + strconv.Itoa(i)))
		b.WriteString(hex.EncodeToString(sum[:]))
	}
	return b.String()[:n]
}

// Digits returns n decimal digits derived from seed (the first is never zero).
func Digits(seed string, n int) string {
	sum := sha256.Sum256([]byte(seed))
	s := new(big.Int).SetBytes(sum[:]).String()
	for len(s) < n {
		s += Digits(s, n)
	}
	s = s[:n]
	if s[0] == '0' {
		s = "1" + s[1:]
	}
	return s
}

// Byte returns a value in [lo, hi] derived from seed.
func Byte(seed string, lo, hi int) int {
	sum := sha256.Sum256([]byte(seed))
	return lo + int(sum[0])%(hi-lo+1)
}

// UUID returns an RFC 4122 version-4-shaped UUID derived from seed.
func UUID(seed string) string {
	h := Hex(seed, 32)
	return h[0:8] + "-" + h[8:12] + "-4" + h[13:16] + "-8" + h[17:20] + "-" + h[20:32]
}

// Token encodes an offset as an opaque page token.
func Token(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(tokenPref + strconv.Itoa(offset)))
}

// Offset decodes a page token ("" is the first page); ok is false for a token this simulator never issued.
func Offset(token string) (int, bool) {
	if token == "" {
		return 0, true
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || !strings.HasPrefix(string(raw), tokenPref) {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimPrefix(string(raw), tokenPref))
	return n, err == nil && n >= 0
}

// Size is the page size to serve: the requested size capped at PageCap (PageCap when none was requested).
func Size(requested string) int {
	if n, err := strconv.Atoi(requested); err == nil && n > 0 && n < PageCap {
		return n
	}
	return PageCap
}

// Window slices [offset, offset+size) out of total items and returns the end and the next token ("" on the last page).
func Window(total, offset, size int) (start, end int, next string) {
	if offset > total {
		offset = total
	}
	end = offset + size
	if end >= total {
		return offset, total, ""
	}
	return offset, end, Token(end)
}

// WithinSkew reports whether t lies within MaxSkew of now.
func WithinSkew(t, now time.Time) bool {
	d := now.Sub(t)
	if d < 0 {
		d = -d
	}
	return d <= MaxSkew
}

// EstateTags maps the estate's tag attributes to cloud tag keys (empty values are skipped).
func EstateTags(attrs func(string) string) map[string]string {
	out := map[string]string{}
	for key, attr := range map[string]string{"Environment": "tagEnvironment", "Owner": "tagOwner", "CostCentre": "tagCostCentre"} {
		if v := attrs(attr); v != "" {
			out[key] = v
		}
	}
	return out
}
