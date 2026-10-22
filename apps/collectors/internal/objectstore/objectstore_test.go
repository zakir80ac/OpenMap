// T-057 REQ-DISC-017 — serves S3-shaped XML (ListBuckets, location, versioning, encryption, public
// access block, ListObjectsV2) from httptest in path style, checks the SigV4 header shape and the
// emitted bucket CIs.
package objectstore

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/sigv4"
)

func server(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 Credential=AKIATEST/") || !strings.Contains(auth, "/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=") || r.Header.Get("X-Amz-Content-Sha256") == "" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`<Error><Code>SignatureDoesNotMatch</Code></Error>`))
			return
		}
		w.Header().Set("Content-Type", "application/xml")
		q := r.URL.Query()
		switch {
		case r.URL.Path == "/":
			_, _ = w.Write([]byte(`<ListAllMyBucketsResult><Owner><ID>abc</ID><DisplayName>minio-admin</DisplayName></Owner><Buckets><Bucket><Name>backups</Name><CreationDate>2026-01-02T03:04:05.000Z</CreationDate></Bucket><Bucket><Name>public-assets</Name><CreationDate>2026-02-02T00:00:00.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>`))
		case q.Has("location"):
			_, _ = w.Write([]byte(`<LocationConstraint>me-south-1</LocationConstraint>`))
		case q.Has("versioning"):
			if r.URL.Path == "/backups" {
				_, _ = w.Write([]byte(`<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>`))
			} else {
				_, _ = w.Write([]byte(`<VersioningConfiguration/>`))
			}
		case q.Has("encryption"):
			if r.URL.Path == "/backups" {
				_, _ = w.Write([]byte(`<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>`))
			} else {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`<Error><Code>ServerSideEncryptionConfigurationNotFoundError</Code></Error>`))
			}
		case q.Has("publicAccessBlock"):
			if r.URL.Path == "/backups" {
				_, _ = w.Write([]byte(`<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>`))
			} else {
				_, _ = w.Write([]byte(`<PublicAccessBlockConfiguration><BlockPublicAcls>false</BlockPublicAcls><RestrictPublicBuckets>false</RestrictPublicBuckets></PublicAccessBlockConfiguration>`))
			}
		case q.Get("list-type") == "2":
			_, _ = w.Write([]byte(`<ListBucketResult><KeyCount>2</KeyCount><IsTruncated>true</IsTruncated><Contents><Key>a</Key><Size>1024</Size><LastModified>2026-10-01T00:00:00.000Z</LastModified><StorageClass>STANDARD</StorageClass></Contents><Contents><Key>b</Key><Size>2048</Size><LastModified>2026-10-20T00:00:00.000Z</LastModified><StorageClass>GLACIER</StorageClass></Contents></ListBucketResult>`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestWalkAndEmit(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c, err := NewClient(srv.URL, sigv4.Credentials{AccessKeyID: "AKIATEST", SecretAccessKey: "secret"}, "", true, false)
	if err != nil {
		t.Fatal(err)
	}
	inv, err := c.Walk(context.Background(), 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(inv.Buckets) != 2 || inv.Owner != "minio-admin" {
		t.Fatalf("walk wrong: %+v", inv)
	}
	obs := Emit(inv, time.Now())
	if len(obs.Cis) != 2 {
		t.Fatalf("expected two buckets, got %d", len(obs.Cis))
	}
	backups := obs.Cis[0]
	if backups.Identity["name"] != "backups" || backups.Attributes["region"] != "me-south-1" || backups.Attributes["versioning"] != "Enabled" || backups.Attributes["encryption"] != "AES256" || backups.Attributes["bytesSampled"] != int64(3072) || backups.Attributes["sampleTruncated"] != true || backups.Attributes["internetExposed"] != false {
		t.Fatalf("backups wrong: %+v", backups.Attributes)
	}
	public := obs.Cis[1]
	if public.Attributes["encryption"] != "none" || public.Attributes["internetExposed"] != true || public.Attributes["versioning"] != "Disabled" {
		t.Fatalf("public bucket wrong: %+v", public.Attributes)
	}
	if len(obs.Evidence) < 2 {
		t.Fatalf("expected evidence documents, got %d", len(obs.Evidence))
	}
}

func TestBadKey(t *testing.T) {
	srv := server(t)
	defer srv.Close()
	c, _ := NewClient(srv.URL, sigv4.Credentials{AccessKeyID: "WRONG", SecretAccessKey: "x"}, "", true, false)
	if _, err := c.Walk(context.Background(), 10); err == nil || !strings.Contains(err.Error(), "auth_failed") {
		t.Fatalf("expected auth_failed, got %v", err)
	}
}
