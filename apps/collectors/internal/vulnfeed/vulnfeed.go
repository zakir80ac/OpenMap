// REQ-DISC-027 — vulnerability feed collector: pulls CVE records from an NVD 2.0-compatible API
// (NVD itself, or a mirror inside an air-gapped estate) for a modification window, and emits
// `vulnerability` CIs carrying CVSS, severity, affected CPE match strings and references. The CMDB
// correlates CPEs with discovered software; this collector never touches a device. A window longer
// than the API's 120-day range limit is read as consecutive ranges; pages advance by the records a page
// really held (a mirror may cap resultsPerPage below the request); a mirror behind a private CA is
// pinned with caCertPem.
package vulnfeed

import (
	"context"
	"net/url"
	"sort"
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
	optionPageSize  = "resultsPerPage" // at most pageSize; a lower value suits mirrors with a smaller cap
	optionCA        = "caCertPem"
	// maxRange is the NVD 2.0 limit on one lastModStartDate..lastModEndDate range: 120 consecutive days.
	maxRange      = 120 * 24 * time.Hour
	defaultKeyHdr = "apiKey"
	credField     = "token"
	typeVuln      = "vulnerability"
	nvdTimeLayout = "2006-01-02T15:04:05.000"
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
	Source   string `json:"source"`
	Type     string `json:"type"` // Primary (the NVD's own score) or Secondary (a CNA's)
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
		// CISA Known Exploited Vulnerabilities catalogue entry, present only for listed CVEs.
		CisaExploitAdd        string `json:"cisaExploitAdd"`
		CisaActionDue         string `json:"cisaActionDue"`
		CisaRequiredAction    string `json:"cisaRequiredAction"`
		CisaVulnerabilityName string `json:"cisaVulnerabilityName"`
		Descriptions          []struct {
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

// Fetch pages through the feed for the modification window ending now, at the API's maximum page size.
func Fetch(ctx context.Context, c *restjson.Client, basePath string, window time.Duration, now time.Time) ([]cveItem, [][]byte, error) {
	return FetchPages(ctx, c, basePath, window, now, pageSize)
}

// FetchPages is Fetch with a page size (1..pageSize). The window is split into ranges of at most maxRange,
// oldest first; a CVE modified on a range boundary is returned by both ranges and kept once (the later copy).
func FetchPages(ctx context.Context, c *restjson.Client, basePath string, window time.Duration, now time.Time, perPage int) ([]cveItem, [][]byte, error) {
	if perPage <= 0 || perPage > pageSize {
		perPage = pageSize
	}
	var items []cveItem
	seen := map[string]int{}
	for from := now.Add(-window); from.Before(now); {
		to := from.Add(maxRange)
		if to.After(now) {
			to = now
		}
		for index := 0; ; {
			q := url.Values{}
			q.Set("lastModStartDate", from.UTC().Format(nvdTimeLayout))
			q.Set("lastModEndDate", to.UTC().Format(nvdTimeLayout))
			q.Set("resultsPerPage", strconv.Itoa(perPage))
			q.Set("startIndex", strconv.Itoa(index))
			var p page
			if err := c.Get(ctx, basePath+"?"+q.Encode(), &p); err != nil {
				return nil, nil, err
			}
			for _, it := range p.Vulnerabilities {
				if i, dup := seen[it.Cve.ID]; dup {
					items[i] = it
					continue
				}
				seen[it.Cve.ID] = len(items)
				items = append(items, it)
			}
			index += len(p.Vulnerabilities)
			if index >= p.TotalResults || len(p.Vulnerabilities) == 0 {
				break
			}
		}
		from = to
	}
	return items, c.Raw(), nil
}

// metricTypePrimary marks the score the NVD itself assigned; CNAs publish theirs as Secondary.
const metricTypePrimary = "Primary"

// primaryMetric takes the newest CVSS version present and, within it, the NVD's Primary score: the
// NVD lists CNA (Secondary) scores first for some records (CVE-2024-3094 starts with Red Hat's).
func primaryMetric(item cveItem) (cvssMetric, bool) {
	m := item.Cve.Metrics
	for _, list := range [][]cvssMetric{m.CvssMetricV40, m.CvssMetricV31, m.CvssMetricV2} {
		if len(list) == 0 {
			continue
		}
		for _, metric := range list {
			if metric.Type == metricTypePrimary {
				return metric, true
			}
		}
		return list[0], true
	}
	return cvssMetric{}, false
}

// cpeMatchText renders one vulnerable CPE match as a scalar (attributes carry scalars or arrays of
// scalars only): the criteria followed by whichever version bounds the NVD gives.
func cpeMatchText(criteria, startIncluding, endExcluding, endIncluding string) string {
	s := criteria
	for _, b := range []struct{ key, value string }{{"versionStartIncluding", startIncluding}, {"versionEndExcluding", endExcluding}, {"versionEndIncluding", endIncluding}} {
		if b.value != "" {
			s += " " + b.key + "=" + b.value
		}
	}
	return s
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
		cpes := []string{}
		products := map[string]bool{}
		for _, cfg := range item.Cve.Configurations {
			for _, n := range cfg.Nodes {
				for _, m := range n.CpeMatch {
					if !m.Vulnerable {
						continue
					}
					cpes = append(cpes, cpeMatchText(m.Criteria, m.VersionStartIncluding, m.VersionEndExcluding, m.VersionEndIncluding))
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
		sort.Strings(productList)
		// The NVD and the CNA often both list the same CWE; keep each once.
		cwes := []string{}
		seenCwe := map[string]bool{}
		for _, w := range item.Cve.Weaknesses {
			for _, d := range w.Description {
				if !seenCwe[d.Value] {
					seenCwe[d.Value] = true
					cwes = append(cwes, d.Value)
				}
			}
		}
		refs := []string{}
		// A CISA KEV listing means exploitation in the wild is confirmed.
		kev := item.Cve.CisaExploitAdd != ""
		exploitKnown := kev
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
				"published": item.Cve.Published, "lastModified": item.Cve.LastModified, "status": item.Cve.VulnStatus, "description": description, "cpeMatches": cpes, "affectedProducts": productList, "cwe": cwes, "references": refs, "exploitKnown": exploitKnown, "source": "nvd",
				"cvssSource": metric.Source, "kev": kev, "kevDateAdded": item.Cve.CisaExploitAdd, "kevDueDate": item.Cve.CisaActionDue, "kevRequiredAction": item.Cve.CisaRequiredAction, "kevName": item.Cve.CisaVulnerabilityName},
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
	c, err := restjson.New(base.Scheme+"://"+base.Host, defaultPort, restjson.Auth{}, restjson.Options{VerifyTLS: true, CAPem: restjson.StringOption(options, optionCA), Headers: headers})
	if err != nil {
		return collector.Observation{}, err
	}
	window := time.Duration(restjson.IntOption(options, optionWindow, defaultWindowH)) * time.Hour
	items, raw, err := FetchPages(ctx, c, base.Path, window, time.Now(), restjson.IntOption(options, optionPageSize, pageSize))
	if err != nil {
		return collector.Observation{}, restjson.Classify(base.Host, err)
	}
	return Emit(items, raw, restjson.StringOption(options, optionSeverity), time.Now().UTC()), nil
}
