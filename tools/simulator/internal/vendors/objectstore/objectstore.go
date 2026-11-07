// REQ-QA-005 REQ-DISC-017 — simulated S3-compatible object stores, path-style over HTTPS. Every request must
// carry a valid AWS Signature Version 4 (AWS4-HMAC-SHA256) made with the simulated access key (env.User) and
// secret (env.Secret): the simulator rebuilds the canonical request from what it received (canonical URI and
// query, the signed headers, x-amz-content-sha256 checked against the body), derives the signing key and
// compares signatures, answering InvalidAccessKeyId, SignatureDoesNotMatch, RequestTimeTooSkewed or
// AuthorizationHeaderMalformed (wrong region) as S3 does. Three flavours, shaped after the recorded MinIO and
// Ceph RGW exchanges and the S3 API reference: "aws-s3" serves the estate's object_bucket CIs with their region,
// versioning, SSE-KMS encryption and public access block; "minio" and "ceph-rgw" serve buckets seeded
// deterministically from their names (the estate holds no on-premises object store), with MinIO's empty
// LocationConstraint and 501 NotImplemented for publicAccessBlock and RGW's "default" location and
// BlockPublicAccessBlockConfiguration. ListObjectsV2 honours max-keys and continuation tokens; object keys and
// sizes are derived by hash, so each run is reproducible. The collector does not branch on the flavour; the three
// endpoints exercise the response variants it must parse.
package objectstore

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	algorithm       = "AWS4-HMAC-SHA256"
	amzDateFormat   = "20060102T150405Z"
	scopeDateFormat = "20060102"
	maxSkew         = 15 * time.Minute
	unsignedPayload = "UNSIGNED-PAYLOAD"
	s3NS            = "http://s3.amazonaws.com/doc/2006-03-01/"
	defaultMaxKeys  = 1000
	maxBody         = 1 << 20
	listedObjects   = 1500 // objects an estate bucket lists before the sample cut (it holds far more)
	objectMinBytes  = 4096
	objectSpanBytes = 1 << 22
	minioRegion     = "us-east-1"
	// created is the fixed creation instant of seeded buckets (2025-01-01T00:00:00Z) so runs are reproducible.
	created = 1735689600
	dayHrs  = 24
)

type Vendor struct{}

func (Vendor) ID() string             { return "s3-object-storage" }
func (Vendor) Collector() string      { return "object_storage" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-017"} }

func digest(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])
}

func hashInt(span int, parts ...string) int {
	n, _ := strconv.ParseUint(digest(parts...)[:8], 16, 32)
	return int(n % uint64(span))
}

type bucket struct {
	ci           *estate.CI
	name         string
	created      time.Time
	region       string
	versioning   string // "", Enabled or Suspended
	sse          string // "", AES256 or aws:kms
	pab          *bool  // nil when the store has no public access block for the bucket
	objects      int
	storageClass string
}

type flavour struct {
	key       string
	server    string
	region    string // "" accepts the region the request was signed for (RGW)
	location  func(b *bucket) string
	pabStatus int // 0 serves the configuration; otherwise the status answered (501 on MinIO)
	pabRoot   string
	ownerID   string
	ownerName string
	buckets   []*bucket
}

func boolp(b bool) *bool { return &b }

func seededBucket(store, name, versioning, sse string, objects int) *bucket {
	return &bucket{name: name, created: time.Unix(created, 0).UTC().Add(time.Duration(hashInt(dayHrs*365, store, name)) * time.Hour),
		versioning: versioning, sse: sse, objects: objects, storageClass: "STANDARD"}
}

func flavours(e *estate.Estate) []*flavour {
	aws := &flavour{key: "aws-s3", server: "AmazonS3", ownerID: digest("aws-owner", e.TenantID), pabRoot: "PublicAccessBlockConfiguration",
		location: func(b *bucket) string { return b.region }}
	for _, c := range e.OfType("object_bucket", func(c *estate.CI) bool { return strings.HasSuffix(c.ID("endpoint"), ".amazonaws.com") }) {
		b := &bucket{ci: c, name: c.ID("name"), created: time.Unix(created, 0).UTC(), region: c.Str("region"), storageClass: c.Str("storageClass"), objects: listedObjects}
		if c.Bool("versioning") {
			b.versioning = "Enabled"
		}
		switch c.Str("encryption") {
		case "SSE-KMS":
			b.sse = "aws:kms"
		case "SSE-S3":
			b.sse = "AES256"
		}
		if v, ok := c.Attributes["publicAccessBlocked"].(bool); ok {
			b.pab = boolp(v)
		}
		if n := int(c.Num("objectCount", listedObjects)); n < listedObjects {
			b.objects = n
		}
		aws.buckets = append(aws.buckets, b)
		if aws.region == "" {
			aws.region = b.region
		}
	}
	minio := &flavour{key: "minio", server: "MinIO", region: minioRegion, ownerID: digest("minio-owner", e.TenantID), ownerName: "minio",
		location: func(*bucket) string { return "" }, pabStatus: http.StatusNotImplemented,
		buckets: []*bucket{
			seededBucket("minio", "veeam-repo-ryd", "Enabled", "AES256", 6),
			seededBucket("minio", "app-artifacts", "Enabled", "", 4),
			seededBucket("minio", "public-downloads", "", "", 2),
		}}
	rgw := &flavour{key: "ceph-rgw", server: "", ownerID: "openmap-sim", ownerName: "OpenMap simulated RGW user", pabRoot: "BlockPublicAccessBlockConfiguration",
		location: func(*bucket) string { return "default" },
		buckets: []*bucket{
			seededBucket("ceph-rgw", "archive", "Suspended", "AES256", 0),
			seededBucket("ceph-rgw", "inventory-exports", "Enabled", "", 3),
			seededBucket("ceph-rgw", "loki-chunks", "", "", listedObjects),
		}}
	for _, b := range rgw.buckets {
		b.pab = boolp(false)
	}
	out := []*flavour{minio, rgw}
	if len(aws.buckets) > 0 {
		out = append([]*flavour{aws}, out...)
	}
	return out
}

// --- SigV4 verification -------------------------------------------------------------------------------

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
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func canonicalQuery(q url.Values) string {
	type kv struct{ k, v string }
	var pairs []kv
	for k, vs := range q {
		for _, v := range vs {
			pairs = append(pairs, kv{uriEncode(k, true), uriEncode(v, true)})
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return pairs[i].v < pairs[j].v
	})
	parts := make([]string, 0, len(pairs))
	for _, p := range pairs {
		parts = append(parts, p.k+"="+p.v)
	}
	return strings.Join(parts, "&")
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

type sigError struct {
	status int
	code   string
	msg    string
}

// verifySigV4 checks the request's SigV4 signature; region "" accepts the scope's region.
func verifySigV4(r *http.Request, body []byte, accessKey, secret, region string, now time.Time) *sigError {
	auth := r.Header.Get("Authorization")
	if auth == "" {
		return &sigError{http.StatusForbidden, "AccessDenied", "Access Denied."}
	}
	if !strings.HasPrefix(auth, algorithm+" ") {
		return &sigError{http.StatusBadRequest, "AuthorizationHeaderMalformed", "The authorization header is malformed; unsupported algorithm."}
	}
	fields := map[string]string{}
	for _, part := range strings.Split(strings.TrimPrefix(auth, algorithm+" "), ",") {
		if k, v, ok := strings.Cut(strings.TrimSpace(part), "="); ok {
			fields[k] = v
		}
	}
	scope := strings.Split(fields["Credential"], "/")
	if len(scope) != len([]string{"key", "date", "region", "service", "terminator"}) || fields["SignedHeaders"] == "" || fields["Signature"] == "" {
		return &sigError{http.StatusBadRequest, "AuthorizationHeaderMalformed", "The authorization header is malformed."}
	}
	key, date, scopeRegion, service, term := scope[0], scope[1], scope[2], scope[3], scope[4]
	if key != accessKey {
		return &sigError{http.StatusForbidden, "InvalidAccessKeyId", "The Access Key Id you provided does not exist in our records."}
	}
	if service != "s3" || term != "aws4_request" {
		return &sigError{http.StatusBadRequest, "AuthorizationHeaderMalformed", "The authorization header is malformed; incorrect service or terminator."}
	}
	if region != "" && scopeRegion != region {
		return &sigError{http.StatusBadRequest, "AuthorizationHeaderMalformed", "The authorization header is malformed; the region '" + scopeRegion + "' is wrong; expecting '" + region + "'"}
	}
	amzDate := r.Header.Get("X-Amz-Date")
	at, err := time.Parse(amzDateFormat, amzDate)
	if err != nil || at.Format(scopeDateFormat) != date {
		return &sigError{http.StatusForbidden, "AccessDenied", "X-Amz-Date is missing or does not match the credential scope."}
	}
	if d := now.Sub(at); d > maxSkew || d < -maxSkew {
		return &sigError{http.StatusForbidden, "RequestTimeTooSkewed", "The difference between the request time and the current time is too large."}
	}
	payload := r.Header.Get("X-Amz-Content-Sha256")
	sum := sha256.Sum256(body)
	if payload != unsignedPayload && payload != hex.EncodeToString(sum[:]) {
		return &sigError{http.StatusBadRequest, "XAmzContentSHA256Mismatch", "The provided 'x-amz-content-sha256' header does not match what was computed."}
	}
	signed := strings.Split(fields["SignedHeaders"], ";")
	var ch strings.Builder
	hasHost, hasDate := false, false
	for _, name := range signed {
		var v string
		switch name {
		case "host":
			v, hasHost = r.Host, true
		default:
			v = strings.Join(r.Header.Values(name), ",")
		}
		hasDate = hasDate || name == "x-amz-date"
		ch.WriteString(name + ":" + strings.TrimSpace(v) + "\n")
	}
	if !hasHost || !hasDate || !sort.StringsAreSorted(signed) {
		return &sigError{http.StatusBadRequest, "AuthorizationHeaderMalformed", "SignedHeaders must be sorted and include host and x-amz-date."}
	}
	path := r.URL.Path
	if path == "" {
		path = "/"
	}
	canonical := strings.Join([]string{r.Method, uriEncode(path, false), canonicalQuery(r.URL.Query()), ch.String(), fields["SignedHeaders"], payload}, "\n")
	cr := sha256.Sum256([]byte(canonical))
	toSign := strings.Join([]string{algorithm, amzDate, date + "/" + scopeRegion + "/s3/aws4_request", hex.EncodeToString(cr[:])}, "\n")
	k := hmacSHA256([]byte("AWS4"+secret), date)
	k = hmacSHA256(k, scopeRegion)
	k = hmacSHA256(k, "s3")
	k = hmacSHA256(k, "aws4_request")
	want := hex.EncodeToString(hmacSHA256(k, toSign))
	if !hmac.Equal([]byte(want), []byte(fields["Signature"])) {
		return &sigError{http.StatusForbidden, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided. Check your key and signing method."}
	}
	return nil
}

// --- S3 responses ---------------------------------------------------------------------------------------

func s3Error(w http.ResponseWriter, status int, code, msg, resource string) {
	body := `<?xml version="1.0" encoding="UTF-8"?>` + "\n<Error><Code>" + code + "</Code><Message>" + esc(msg) + "</Message><Resource>" + esc(resource) +
		"</Resource><RequestId>" + strings.ToUpper(digest(resource, code)[:16]) + "</RequestId></Error>"
	sim.WriteRaw(w, status, "application/xml", []byte(body))
}

func esc(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func writeXML(w http.ResponseWriter, body string) {
	sim.WriteRaw(w, http.StatusOK, "application/xml", []byte(`<?xml version="1.0" encoding="UTF-8"?>`+"\n"+body))
}

func objectKey(b *bucket, i int) string {
	return fmt.Sprintf("%s/%04d/%s.bin", b.name, i/defaultMaxKeys, digest(b.name, strconv.Itoa(i))[:16])
}

func (f *flavour) listObjects(w http.ResponseWriter, b *bucket, q url.Values) {
	maxKeys := defaultMaxKeys
	if n, err := strconv.Atoi(q.Get("max-keys")); err == nil && n >= 0 && n < defaultMaxKeys {
		maxKeys = n
	}
	start, _ := strconv.Atoi(q.Get("continuation-token"))
	if start < 0 || start > b.objects {
		start = b.objects
	}
	end := start + maxKeys
	if end > b.objects {
		end = b.objects
	}
	var sb strings.Builder
	sb.WriteString(`<ListBucketResult xmlns="` + s3NS + `"><Name>` + esc(b.name) + "</Name><Prefix></Prefix><KeyCount>" + strconv.Itoa(end-start) +
		"</KeyCount><MaxKeys>" + strconv.Itoa(maxKeys) + "</MaxKeys><IsTruncated>" + strconv.FormatBool(end < b.objects) + "</IsTruncated>")
	if tok := q.Get("continuation-token"); tok != "" {
		sb.WriteString("<ContinuationToken>" + esc(tok) + "</ContinuationToken>")
	}
	if end < b.objects {
		sb.WriteString("<NextContinuationToken>" + strconv.Itoa(end) + "</NextContinuationToken>")
	}
	for i := start; i < end; i++ {
		mod := b.created.Add(time.Duration(hashInt(dayHrs*365, b.name, "mod", strconv.Itoa(i))) * time.Hour)
		size := objectMinBytes + hashInt(objectSpanBytes, b.name, "size", strconv.Itoa(i))
		sb.WriteString("<Contents><Key>" + esc(objectKey(b, i)) + "</Key><LastModified>" + mod.Format("2006-01-02T15:04:05.000Z") + `</LastModified><ETag>&#34;` +
			digest(b.name, "etag", strconv.Itoa(i))[:32] + `&#34;</ETag><Size>` + strconv.Itoa(size) + "</Size><StorageClass>" + b.storageClass + "</StorageClass></Contents>")
	}
	sb.WriteString("</ListBucketResult>")
	writeXML(w, sb.String())
}

func (f *flavour) handler(env *sim.Env) http.Handler {
	byName := map[string]*bucket{}
	for _, b := range f.buckets {
		byName[b.name] = b
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if f.server != "" {
			w.Header().Set("Server", f.server)
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxBody))
		if err != nil {
			s3Error(w, http.StatusBadRequest, "IncompleteBody", "The request body could not be read.", r.URL.Path)
			return
		}
		if e := verifySigV4(r, body, env.User, env.Secret, f.region, time.Now().UTC()); e != nil {
			s3Error(w, e.status, e.code, e.msg, r.URL.Path)
			return
		}
		if r.Method != http.MethodGet {
			s3Error(w, http.StatusMethodNotAllowed, "MethodNotAllowed", "The specified method is not allowed against this resource.", r.URL.Path)
			return
		}
		name := strings.Trim(r.URL.Path, "/")
		if name == "" {
			f.listBuckets(w)
			return
		}
		b, ok := byName[name]
		if !ok || strings.Contains(name, "/") {
			s3Error(w, http.StatusNotFound, "NoSuchBucket", "The specified bucket does not exist", "/"+name)
			return
		}
		q := r.URL.Query()
		switch {
		case q.Has("location"):
			writeXML(w, `<LocationConstraint xmlns="`+s3NS+`">`+esc(f.location(b))+"</LocationConstraint>")
		case q.Has("versioning"):
			status := ""
			if b.versioning != "" {
				status = "<Status>" + b.versioning + "</Status>"
			}
			writeXML(w, `<VersioningConfiguration xmlns="`+s3NS+`">`+status+"</VersioningConfiguration>")
		case q.Has("encryption"):
			if b.sse == "" {
				s3Error(w, http.StatusNotFound, "ServerSideEncryptionConfigurationNotFoundError", "The server side encryption configuration was not found", "/"+name)
				return
			}
			kms := ""
			if b.sse == "aws:kms" {
				kms = "<KMSMasterKeyID>arn:aws:kms:" + b.region + ":" + digest(name)[:12] + ":key/" + digest(name, "kms")[:36] + "</KMSMasterKeyID>"
			}
			writeXML(w, `<ServerSideEncryptionConfiguration xmlns="`+s3NS+`"><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>`+b.sse+"</SSEAlgorithm>"+kms+"</ApplyServerSideEncryptionByDefault><BucketKeyEnabled>false</BucketKeyEnabled></Rule></ServerSideEncryptionConfiguration>")
		case q.Has("publicAccessBlock"):
			if f.pabStatus != 0 {
				s3Error(w, f.pabStatus, "NotImplemented", "A header you provided implies functionality that is not implemented", "/"+name)
				return
			}
			if b.pab == nil {
				s3Error(w, http.StatusNotFound, "NoSuchPublicAccessBlockConfiguration", "The public access block configuration was not found", "/"+name)
				return
			}
			v := strconv.FormatBool(*b.pab)
			writeXML(w, "<"+f.pabRoot+` xmlns="`+s3NS+`"><BlockPublicAcls>`+v+"</BlockPublicAcls><IgnorePublicAcls>"+v+"</IgnorePublicAcls><BlockPublicPolicy>"+v+"</BlockPublicPolicy><RestrictPublicBuckets>"+v+"</RestrictPublicBuckets></"+f.pabRoot+">")
		case q.Get("list-type") == "2":
			f.listObjects(w, b, q)
		default:
			s3Error(w, http.StatusNotImplemented, "NotImplemented", "A header you provided implies functionality that is not implemented", "/"+name)
		}
	})
}

func (f *flavour) listBuckets(w http.ResponseWriter) {
	var sb strings.Builder
	sb.WriteString(`<ListAllMyBucketsResult xmlns="` + s3NS + `"><Owner><ID>` + esc(f.ownerID) + "</ID>")
	if f.ownerName != "" {
		sb.WriteString("<DisplayName>" + esc(f.ownerName) + "</DisplayName>")
	}
	sb.WriteString("</Owner><Buckets>")
	sorted := append([]*bucket(nil), f.buckets...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].name < sorted[j].name })
	for _, b := range sorted {
		sb.WriteString("<Bucket><Name>" + esc(b.name) + "</Name><CreationDate>" + b.created.Format("2006-01-02T15:04:05.000Z") + "</CreationDate></Bucket>")
	}
	sb.WriteString("</Buckets></ListAllMyBucketsResult>")
	writeXML(w, sb.String())
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	fls := flavours(e)
	byKey := map[string]*flavour{}
	keys := []string{}
	for _, f := range fls {
		byKey[f.key] = f
		keys = append(keys, f.key)
	}
	return sim.ServeEach(env, keys, true, func(k string) http.Handler { return byKey[k].handler(env) })
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	var runs []sim.Run
	for _, f := range flavours(e) {
		base := ep.Devices[f.key]
		u, err := url.Parse(base)
		if err != nil {
			continue
		}
		opts := map[string]any{"pathStyle": true, "verifyTls": true, "caCertPem": env.CA.PEM}
		if f.region != "" {
			opts["region"] = f.region
		}
		run := sim.Run{
			Name:           f.key,
			Targets:        []sim.Target{{Kind: "url", Value: base, Label: f.key}},
			Options:        opts,
			CredentialType: "api_token",
			Credential:     &sim.Credential{Type: "api_token", Fields: map[string]string{"accessKeyId": env.User, "secretAccessKey": env.Secret}},
		}
		for _, b := range f.buckets {
			if b.ci != nil {
				run.Expect.EstateCI(b.ci)
				continue
			}
			run.Expect.CIs = append(run.Expect.CIs, sim.ExpectCI{Type: "object_bucket", Name: b.name, Identity: map[string]string{"endpoint": strings.ToLower(u.Host), "name": b.name}})
		}
		runs = append(runs, run)
	}
	return runs
}
