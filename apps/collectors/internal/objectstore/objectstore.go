// REQ-DISC-017 — object storage collector for S3-compatible endpoints (MinIO, Ceph RGW, Dell ECS,
// NetApp StorageGRID, AWS S3): lists buckets, reads each bucket's region, versioning, encryption
// and public-access settings, samples object counts and sizes, and emits object_bucket CIs.
package objectstore

import (
	"context"
	"crypto/tls"
	"encoding/xml"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
	"github.com/openmap/openmap/apps/collectors/internal/sigv4"
)

const (
	collectorID     = "object_storage"
	version         = "0.1.0"
	evidenceKind    = "api_response"
	defaultRegion   = "us-east-1"
	defaultSample   = 1000
	maxKeysCap      = 1000
	httpTimeout     = 30 * time.Second
	optionRegion    = "region"
	optionPathStyle = "pathStyle"
	optionVerify    = "verifyTls"
	optionCA        = "caCertPem"
	optionSample    = "sampleObjects"
	credAccessKey   = "accessKeyId"
	credSecretKey   = "secretAccessKey"
	credSession     = "sessionToken"
	typeBucket      = "object_bucket"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "object_storage", Version: version, Language: "go",
		Protocols: []string{"s3"}, CredentialTypes: []string{"api_token"},
		TargetKinds: []string{"url", "host"}, Emits: []string{typeBucket},
		ContractVersion: contract.Version,
	}
}

// Client signs and sends S3 requests against one endpoint.
type Client struct {
	endpoint  *url.URL
	creds     sigv4.Credentials
	region    string
	pathStyle bool
	http      *http.Client
	raw       [][]byte
}

func NewClient(endpoint string, creds sigv4.Credentials, region string, pathStyle, verifyTLS bool) (*Client, error) {
	if !strings.Contains(endpoint, "://") {
		endpoint = "https://" + endpoint
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" {
		return nil, collector.Errorf(contract.ErrInternal, false, "object storage target must be a host or URL, got %q", endpoint)
	}
	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: !verifyTLS, MinVersion: tls.VersionTLS12}} //nolint:gosec // private S3 endpoints often use enterprise CAs; verifyTls=true enforces them.
	return &Client{endpoint: u, creds: creds, region: firstNonEmpty(region, defaultRegion), pathStyle: pathStyle, http: &http.Client{Timeout: httpTimeout, Transport: tr}}, nil
}

// NewClientCA is NewClient with the job's private CA bundle (caCertPem), which enforces the chain when set.
func NewClientCA(endpoint string, creds sigv4.Credentials, region string, pathStyle, verifyTLS bool, caPem string) (*Client, error) {
	c, err := NewClient(endpoint, creds, region, pathStyle, verifyTLS)
	if err != nil {
		return nil, err
	}
	tr, err := restjson.TransportFor(verifyTLS, caPem)
	if err != nil {
		return nil, err
	}
	c.http.Transport = tr
	return c, nil
}

func (c *Client) bucketURL(bucket string, query url.Values) *url.URL {
	u := *c.endpoint
	if bucket == "" {
		u.Path = "/"
	} else if c.pathStyle {
		u.Path = "/" + bucket
	} else {
		u.Host = bucket + "." + c.endpoint.Host
		u.Path = "/"
	}
	u.RawQuery = query.Encode()
	return &u
}

func (c *Client) get(ctx context.Context, bucket string, query url.Values, out any) (int, error) {
	u := c.bucketURL(bucket, query)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return 0, err
	}
	sigv4.Sign(req, c.creds, c.region, "s3", sigv4.EmptyPayloadHash, time.Now())
	res, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return res.StatusCode, err
	}
	if res.StatusCode >= http.StatusBadRequest {
		var e s3Error
		_ = xml.Unmarshal(body, &e)
		switch {
		case res.StatusCode == http.StatusForbidden && (e.Code == "SignatureDoesNotMatch" || e.Code == "InvalidAccessKeyId"):
			return res.StatusCode, collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the access key (%s)", c.endpoint.Host, e.Code)
		case res.StatusCode == http.StatusForbidden:
			return res.StatusCode, collector.Errorf(contract.ErrPermissionDenied, false, "%s denied %s on %s", c.endpoint.Host, e.Code, firstNonEmpty(bucket, "/"))
		case res.StatusCode == http.StatusNotFound, res.StatusCode == http.StatusNotImplemented:
			return res.StatusCode, nil
		default:
			return res.StatusCode, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s returned %d (%s)", c.endpoint.Host, res.StatusCode, e.Code)
		}
	}
	c.raw = append(c.raw, body)
	if out != nil {
		if err := xml.Unmarshal(body, out); err != nil {
			return res.StatusCode, collector.Errorf(contract.ErrParse, false, "%s: invalid XML: %v", c.endpoint.Host, err)
		}
	}
	return res.StatusCode, nil
}

type s3Error struct {
	Code    string `xml:"Code"`
	Message string `xml:"Message"`
}

type listAllMyBuckets struct {
	Owner struct {
		ID          string `xml:"ID"`
		DisplayName string `xml:"DisplayName"`
	} `xml:"Owner"`
	Buckets struct {
		Bucket []struct {
			Name         string `xml:"Name"`
			CreationDate string `xml:"CreationDate"`
		} `xml:"Bucket"`
	} `xml:"Buckets"`
}

type locationConstraint struct {
	Value string `xml:",chardata"`
}

type versioningConfiguration struct {
	Status string `xml:"Status"`
}

type encryptionConfiguration struct {
	Rule []struct {
		Default struct {
			SSEAlgorithm string `xml:"SSEAlgorithm"`
		} `xml:"ApplyServerSideEncryptionByDefault"`
	} `xml:"Rule"`
}

type publicAccessBlock struct {
	BlockPublicAcls  bool `xml:"BlockPublicAcls"`
	RestrictBuckets  bool `xml:"RestrictPublicBuckets"`
	IgnorePublicAcls bool `xml:"IgnorePublicAcls"`
}

type listObjectsV2 struct {
	KeyCount    int  `xml:"KeyCount"`
	IsTruncated bool `xml:"IsTruncated"`
	Contents    []struct {
		Key          string `xml:"Key"`
		Size         int64  `xml:"Size"`
		LastModified string `xml:"LastModified"`
		StorageClass string `xml:"StorageClass"`
	} `xml:"Contents"`
}

// Bucket is one bucket's gathered facts.
type Bucket struct {
	Name           string
	Created        string
	Region         string
	Versioning     string
	Encryption     string
	PublicBlocked  *bool
	ObjectsSampled int
	BytesSampled   int64
	Truncated      bool
	StorageClasses map[string]int
	NewestObject   string
}

// Inventory is the endpoint's bucket list with per-bucket facts.
type Inventory struct {
	Endpoint string
	Owner    string
	Buckets  []Bucket
	Raw      [][]byte
}

// Walk lists buckets and reads each one's configuration and an object sample.
func (c *Client) Walk(ctx context.Context, sample int) (*Inventory, error) {
	var list listAllMyBuckets
	if _, err := c.get(ctx, "", url.Values{}, &list); err != nil {
		return nil, err
	}
	inv := &Inventory{Endpoint: c.endpoint.Host, Owner: firstNonEmpty(list.Owner.DisplayName, list.Owner.ID)}
	if sample <= 0 || sample > maxKeysCap {
		sample = defaultSample
	}
	for _, b := range list.Buckets.Bucket {
		bucket := Bucket{Name: b.Name, Created: b.CreationDate, StorageClasses: map[string]int{}}
		var loc locationConstraint
		if _, err := c.get(ctx, b.Name, url.Values{"location": {""}}, &loc); err == nil {
			bucket.Region = firstNonEmpty(strings.TrimSpace(loc.Value), c.region)
		}
		var ver versioningConfiguration
		if _, err := c.get(ctx, b.Name, url.Values{"versioning": {""}}, &ver); err == nil {
			bucket.Versioning = firstNonEmpty(ver.Status, "Disabled")
		}
		var enc encryptionConfiguration
		if status, err := c.get(ctx, b.Name, url.Values{"encryption": {""}}, &enc); err == nil && status < http.StatusBadRequest && len(enc.Rule) > 0 {
			bucket.Encryption = enc.Rule[0].Default.SSEAlgorithm
		}
		var pab publicAccessBlock
		if status, err := c.get(ctx, b.Name, url.Values{"publicAccessBlock": {""}}, &pab); err == nil && status < http.StatusBadRequest {
			blocked := pab.BlockPublicAcls && pab.RestrictBuckets
			bucket.PublicBlocked = &blocked
		}
		var objects listObjectsV2
		if _, err := c.get(ctx, b.Name, url.Values{"list-type": {"2"}, "max-keys": {strconv.Itoa(sample)}}, &objects); err == nil {
			bucket.ObjectsSampled = len(objects.Contents)
			bucket.Truncated = objects.IsTruncated
			for _, o := range objects.Contents {
				bucket.BytesSampled += o.Size
				bucket.StorageClasses[firstNonEmpty(o.StorageClass, "STANDARD")]++
				if o.LastModified > bucket.NewestObject {
					bucket.NewestObject = o.LastModified
				}
			}
		}
		inv.Buckets = append(inv.Buckets, bucket)
	}
	inv.Raw = c.raw
	return inv, nil
}

// Emit converts the inventory into object_bucket observations.
func Emit(inv *Inventory, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	for _, b := range inv.Buckets {
		identity := map[string]string{"endpoint": strings.ToLower(inv.Endpoint), "name": b.Name}
		attrs := map[string]any{"endpoint": inv.Endpoint, "owner": inv.Owner, "region": b.Region, "createdAt": b.Created, "versioning": b.Versioning, "encryption": firstNonEmpty(b.Encryption, "none"), "objectsSampled": b.ObjectsSampled, "bytesSampled": b.BytesSampled, "sampleTruncated": b.Truncated, "storageClasses": b.StorageClasses, "newestObject": b.NewestObject}
		if b.PublicBlocked != nil {
			attrs["publicAccessBlocked"] = *b.PublicBlocked
			attrs["internetExposed"] = !*b.PublicBlocked
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeBucket, Identity: identity, Name: b.Name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
	}
	return obs
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	if cred == nil || cred.Type != "api_token" || cred.Fields[credAccessKey] == "" || cred.Fields[credSecretKey] == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "object storage requires an api_token credential with accessKeyId and secretAccessKey")
	}
	region, _ := options[optionRegion].(string)
	pathStyle, _ := options[optionPathStyle].(bool)
	verify, _ := options[optionVerify].(bool)
	sample := defaultSample
	if v, ok := options[optionSample].(float64); ok && v > 0 {
		sample = int(v)
	}
	caPem, _ := options[optionCA].(string)
	c, err := NewClientCA(target.Value, sigv4.Credentials{AccessKeyID: cred.Fields[credAccessKey], SecretAccessKey: cred.Fields[credSecretKey], SessionToken: cred.Fields[credSession]}, region, pathStyle, verify, caPem)
	if err != nil {
		return collector.Observation{}, err
	}
	inv, err := c.Walk(ctx, sample)
	if err != nil {
		var ne net.Error
		if errorsAs(err, &ne) && ne.Timeout() {
			return collector.Observation{}, collector.Errorf(contract.ErrTimeout, true, "%s timed out", target.Value)
		}
		if _, ok := err.(*collector.TargetError); ok {
			return collector.Observation{}, err
		}
		return collector.Observation{}, collector.Errorf(contract.ErrUnreachable, true, "%s: %v", target.Value, err)
	}
	return Emit(inv, time.Now().UTC()), nil
}

func errorsAs(err error, target *net.Error) bool {
	for e := err; e != nil; {
		if ne, ok := e.(net.Error); ok {
			*target = ne
			return true
		}
		u, ok := e.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		e = u.Unwrap()
	}
	return false
}
