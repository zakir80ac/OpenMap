// REQ-DISC-027 — vulnerability feed collector: pulls CVE records from an NVD 2.0-compatible API
// (NVD itself, or a mirror inside an air-gapped estate) for a modification window, and emits
// `vulnerability` CIs carrying CVSS, severity, affected CPE match strings and references. The CMDB
// correlates CPEs with discovered software; this collector never touches a device.
package vulnfeed

import (
	"context"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID     = "vulnerability_feed"
	version         = "0.1.0"
	evidenceKind    = "api_response"
	defaultPort     = 443
	pageSize        = 2000 // NVD 2.0 maximum resultsPerPage
	defaultWindowH  = 24 * 7
	optionWindow    = "lastModifiedHours"
	optionSeverity  = "minimumSeverity" // LOW | MEDIUM | HIGH | CRITICAL
	optionApiKeyHdr = "apiKeyHeader"
	defaultKeyHdr   = "apiKey"
	credField       = "token"
	typeVuln        = "vulnerability"
	nvdTimeLayout   = "2006-01-02T15:04:05.000"
)

var severityRank = map[string]int{"LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "vulnerability_feed", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"none", "api_token"},
		TargetKinds: []string{"url"}, Emits: []string{typeVuln},
		ContractVersion: contract.Version,
	}
}

type cvssMetric struct {
	CvssData struct {
		Version      string  `json:"version"`
		VectorString string  `json:"vectorString"`
		BaseScore    float64 `json:"baseScore"`
		BaseSeverity string  `json:"baseSeverity"`
	} `json:"cvssData"`
	BaseSeverity        string  `json:"baseSeverity"`
	ExploitabilityScore float64 `json:"exploitabilityScore"`
	ImpactScore         float64 `json:"impactScore"`
}

type cveItem struct {
	Cve struct {
		ID           string `json:"id"`
		Published    string `json:"published"`
		LastModified string `json:"lastModified"`
		VulnStatus   string `json:"vulnStatus"`
		Descriptions []struct {
			Lang  string `json:"lang"`
			Value string `json:"value"`
		} `json:"descriptions"`
		Metrics struct {
			CvssMetricV31 []cvssMetric `json:"cvssMetricV31"`
			CvssMetricV40 []cvssMetric `json:"cvssMetricV40"`
			CvssMetricV2  []cvssMetric `json:"cvssMetricV2"`
		} `json:"metrics"`
		Weaknesses []struct {
			Description []struct {
				Value string `json:"value"`
			} `json:"description"`
		} `json:"weaknesses"`
		Configurations []struct {
			Nodes []struct {
				CpeMatch []struct {
					Vulnerable            bool   `json:"vulnerable"`
					Criteria              string `json:"criteria"`
					VersionStartIncluding string `json:"versionStartIncluding"`
					VersionEndExcluding   string `json:"versionEndExcluding"`
					VersionEndIncluding   string `json:"versionEndIncluding"`
				} `json:"cpeMatch"`
			} `json:"nodes"`
		} `json:"configurations"`
		References []struct {
			URL  string   `json:"url"`
			Tags []string `json:"tags"`
		} `json:"references"`
	} `json:"cve"`
}

type page struct {
	ResultsPerPage  int       `json:"resultsPerPage"`
	StartIndex      int       `json:"startIndex"`
	TotalResults    int       `json:"totalResults"`
	Vulnerabilities []cveItem `json:"vulnerabilities"`
}

// Fetch pages through the feed for the modification window ending now.
func Fetch(ctx context.Context, c *restjson.Client, basePath string, window time.Duration, now time.Time) ([]cveItem, [][]byte, error) {
	var items []cveItem
	start := now.Add(-window)
	for index := 0; ; index += pageSize {
		q := url.Values{}
		q.Set("lastModStartDate", start.UTC().Format(nvdTimeLayout))
		q.Set("lastModEndDate", now.UTC().Format(nvdTimeLayout))
		q.Set("resultsPerPage", strconv.Itoa(pageSize))
		q.Set("startIndex", strconv.Itoa(index))
		var p page
		if err := c.Get(ctx, basePath+"?"+q.Encode(), &p); err != nil {
			return nil, nil, err
		}
		items = append(items, p.Vulnerabilities...)
		if index+len(p.Vulnerabilities) >= p.TotalResults || len(p.Vulnerabilities) == 0 {
			break
		}
	}
	return items, c.Raw(), nil
}

func primaryMetric(item cveItem) (cvssMetric, bool) {
	m := item.Cve.Metrics
	switch {
	case len(m.CvssMetricV40) > 0:
		return m.CvssMetricV40[0], true
	case len(m.CvssMetricV31) > 0:
		return m.CvssMetricV31[0], true
	case len(m.CvssMetricV2) > 0:
		return m.CvssMetricV2[0], true
	}
	return cvssMetric{}, false
}

func severityOf(m cvssMetric) string {
	return strings.ToUpper(firstNonEmpty(m.CvssData.BaseSeverity, m.BaseSeverity, "UNKNOWN"))
}

// Emit converts CVE items into vulnerability observations, filtered by the minimum severity.
func Emit(items []cveItem, raw [][]byte, minimumSeverity string, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	minRank := severityRank[strings.ToUpper(minimumSeverity)]
	for _, item := range items {
		metric, hasMetric := primaryMetric(item)
		sev := "UNKNOWN"
		if hasMetric {
			sev = severityOf(metric)
		}
		if minRank > 0 && severityRank[sev] < minRank {
			continue
		}
		description := ""
		for _, d := range item.Cve.Descriptions {
			if d.Lang == "en" {
				description = d.Value
				break
			}
		}
		cpes := []map[string]any{}
		products := map[string]bool{}
		for _, cfg := range item.Cve.Configurations {
			for _, n := range cfg.Nodes {
				for _, m := range n.CpeMatch {
					if !m.Vulnerable {
						continue
					}
					cpes = append(cpes, map[string]any{"cpe": m.Criteria, "versionStartIncluding": m.VersionStartIncluding, "versionEndExcluding": m.VersionEndExcluding, "versionEndIncluding": m.VersionEndIncluding})
					if parts := strings.Split(m.Criteria, ":"); len(parts) > 4 {
						products[parts[3]+":"+parts[4]] = true // vendor:product
					}
				}
			}
		}
		productList := make([]string, 0, len(products))
		for p := range products {
			productList = append(productList, p)
		}
		cwes := []string{}
		for _, w := range item.Cve.Weaknesses {
			for _, d := range w.Description {
				cwes = append(cwes, d.Value)
			}
		}
		refs := []string{}
		exploitKnown := false
		for _, ref := range item.Cve.References {
			refs = append(refs, ref.URL)
			for _, tag := range ref.Tags {
				if strings.EqualFold(tag, "Exploit") {
					exploitKnown = true
				}
			}
		}
		identity := map[string]string{"cveId": item.Cve.ID}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVuln, Identity: identity, Name: item.Cve.ID,
			Attributes: map[string]any{"severity": sev, "cvssScore": metric.CvssData.BaseScore, "cvssVector": metric.CvssData.VectorString, "cvssVersion": metric.CvssData.Version, "exploitabilityScore": metric.ExploitabilityScore, "impactScore": metric.ImpactScore,
				"published": item.Cve.Published, "lastModified": item.Cve.LastModified, "status": item.Cve.VulnStatus, "description": description, "cpeMatches": cpes, "affectedProducts": productList, "cwe": cwes, "references": refs, "exploitKnown": exploitKnown, "source": "nvd"},
			Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: "nvd", ID: item.Cve.ID}}, ObservedAt: at})
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
	headers := map[string]string{}
	if cred != nil && cred.Type == "api_token" && cred.Fields[credField] != "" {
		headers[firstNonEmpty(restjson.StringOption(options, optionApiKeyHdr), defaultKeyHdr)] = cred.Fields[credField]
	}
	base, err := url.Parse(target.Value)
	if err != nil || base.Host == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrInternal, false, "feed target must be a URL, got %q", target.Value)
	}
	c, err := restjson.New(base.Scheme+"://"+base.Host, defaultPort, restjson.Auth{}, restjson.Options{VerifyTLS: true, Headers: headers})
	if err != nil {
		return collector.Observation{}, err
	}
	window := time.Duration(restjson.IntOption(options, optionWindow, defaultWindowH)) * time.Hour
	items, raw, err := Fetch(ctx, c, base.Path, window, time.Now())
	if err != nil {
		return collector.Observation{}, restjson.Classify(base.Host, err)
	}
	return Emit(items, raw, restjson.StringOption(options, optionSeverity), time.Now().UTC()), nil
}
