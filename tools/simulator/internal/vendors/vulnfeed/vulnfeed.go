// REQ-QA-005 REQ-DISC-027 — simulated NVD CVE API 2.0 (services.nvd.nist.gov/rest/json/cves/2.0, or an
// air-gapped mirror of it) rendered from the estate's vulnerability_feed result: every estate vulnerability
// becomes an NVD_CVE 2.0 record (shape from the recorded captures in packages/testing/fixtures/vendor/
// vulnerability_feed/nist-nvd-cve-api-2.0, values from the estate). CVSS 3.1 Primary metric with the vector's
// components and exploitability/impact subscores computed by the CVSS 3.1 formulas; CISA KEV fields for KEV
// CVEs; an Exploit-tagged reference for CVEs exploited in the wild; one vulnerable cpeMatch per estate
// affected_by software (versionEndExcluding the fixed release). The API behaves as the NVD documents it:
// lastModStartDate/lastModEndDate must come as a pair spanning at most 120 days, startIndex/resultsPerPage
// (max 2000) paging with totalResults, the apiKey header (a wrong key answers 404 with a message header),
// and the public rate limits (5 requests per rolling 30 s without a key, 50 with one; over the limit is 403).
// Tenable.io/Tenable.sc, Qualys VMDR and Rapid7 InsightVM imports are not simulated: the vulnerability_feed
// collector implements only the NVD 2.0 API.
package vulnfeed

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
)

const (
	basePath     = "/rest/json/cves/2.0"
	nvdLayout    = "2006-01-02T15:04:05.000"
	maxPerPage   = 2000
	maxRange     = 120 * 24 * time.Hour
	sourceNVD    = "nvd@nist.gov"
	sourceMitre  = "cve@mitre.org"
	advisoryBase = "https://advisories.simulated.invalid/"
	kevBase      = "https://kev.simulated.invalid/"
	// kevAddedAfter and kevDueAfter place the KEV listing and its remediation due date after publication
	// (CISA's binding operational directive gives federal agencies three weeks from listing).
	kevAddedAfter = 7 * 24 * time.Hour
	kevDueAfter   = 21 * 24 * time.Hour
	kevAction     = "Apply mitigations per vendor instructions or discontinue use of the product if mitigations are unavailable."
	// rateWindow and the two limits are the NVD's published public rate limits.
	rateWindow   = 30 * time.Second
	limitKeyless = 5
	limitKeyed   = 50
	// runPerPage is the page size the simulated run asks for, so paging is exercised on a small estate.
	runPerPage = 5
	// windowMargin widens the run's modification window past the oldest estate record.
	windowMargin = 24 * time.Hour
	tenths       = 10
	cpeWildcard  = "*"
)

type Vendor struct{}

func (Vendor) ID() string             { return "nvd-cve-api-2.0" }
func (Vendor) Collector() string      { return "vulnerability_feed" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-027"} }

// record is one CVE with the instant it was last modified (for window filtering).
type record struct {
	id        string
	published time.Time
	modified  time.Time
	doc       map[string]any
}

func vulns(e *estate.Estate) []*estate.CI {
	out := e.OfType("vulnerability", nil)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func parseEstateTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t.UTC()
}

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

// cpeToken renders a vendor or product name the way CPE 2.3 dictionary names look (lower case, underscores).
func cpeToken(s string) string {
	return strings.Trim(nonAlnum.ReplaceAllString(strings.ToLower(s), "_"), "_")
}

func hashUUID(s string) string {
	sum := sha256.Sum256([]byte(s))
	h := strings.ToUpper(hex.EncodeToString(sum[:]))
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// CPEProduct is the vendor:product pair the collector derives from a cpeMatch criteria string.
func CPEProduct(softwareVendor, softwareName string) string {
	return cpeToken(softwareVendor) + ":" + cpeToken(softwareName)
}

// cpeMatches builds one vulnerable cpeMatch per affected_by relationship into the CVE.
func cpeMatches(e *estate.Estate, cveID string) []any {
	var out []any
	for _, r := range e.Rels {
		if r.Type != "affected_by" || r.To.Identity["cveId"] != cveID {
			continue
		}
		part := "a"
		if sw := e.Resolve(r.From); sw != nil && sw.Str("category") == "os" {
			part = "o"
		}
		criteria := strings.Join([]string{"cpe", "2.3", part, cpeToken(r.From.Identity["vendor"]), cpeToken(r.From.Identity["name"]),
			cpeWildcard, cpeWildcard, cpeWildcard, cpeWildcard, cpeWildcard, cpeWildcard, cpeWildcard, cpeWildcard}, ":")
		m := map[string]any{"vulnerable": true, "criteria": criteria, "matchCriteriaId": hashUUID(cveID + "|" + criteria + "|" + r.From.Identity["version"])}
		fixed, _ := r.Attributes["fixedIn"].(string)
		affected, _ := r.Attributes["affectedVersions"].(string)
		switch {
		case fixed != "":
			m["versionEndExcluding"] = fixed
		case strings.HasPrefix(affected, "<="):
			m["versionEndIncluding"] = strings.TrimSpace(strings.TrimPrefix(affected, "<="))
		default:
			m["criteria"] = strings.Replace(criteria, ":"+cpeWildcard+":", ":"+r.From.Identity["version"]+":", 1)
		}
		out = append(out, m)
	}
	return out
}

func buildRecord(e *estate.Estate, v *estate.CI) record {
	id := v.ID("cveId")
	pub := parseEstateTime(v.Str("publishedAt"))
	mod := parseEstateTime(v.Str("lastModifiedAt"))
	vector := v.Str("cvssVector")
	cvssData, exploitability, impact := cvss31(vector)
	cvssData["version"] = "3.1"
	cvssData["vectorString"] = vector
	cvssData["baseScore"] = v.Num("cvssScore", 0)
	cvssData["baseSeverity"] = strings.ToUpper(v.Str("severity"))
	refs := []any{}
	advisoryTags := []string{"Vendor Advisory"}
	if v.Bool("patchAvailable") {
		advisoryTags = append(advisoryTags, "Patch")
	}
	refs = append(refs, map[string]any{"url": advisoryBase + id, "source": sourceMitre, "tags": advisoryTags})
	if v.Bool("exploitedInWild") {
		refs = append(refs, map[string]any{"url": advisoryBase + id + "/exploit", "source": sourceMitre, "tags": []string{"Exploit", "Third Party Advisory"}})
	}
	cve := map[string]any{
		"id": id, "sourceIdentifier": sourceMitre, "published": pub.Format(nvdLayout), "lastModified": mod.Format(nvdLayout),
		"vulnStatus": "Analyzed", "cveTags": []any{},
		"descriptions": []any{map[string]string{"lang": "en", "value": v.Str("title")}},
		"metrics": map[string]any{"cvssMetricV31": []any{map[string]any{
			"source": sourceNVD, "type": "Primary", "cvssData": cvssData, "exploitabilityScore": exploitability, "impactScore": impact,
		}}},
		"weaknesses":     []any{map[string]any{"source": sourceNVD, "type": "Primary", "description": []any{map[string]string{"lang": "en", "value": "NVD-CWE-noinfo"}}}},
		"configurations": []any{map[string]any{"nodes": []any{map[string]any{"operator": "OR", "negate": false, "cpeMatch": cpeMatches(e, id)}}}},
		"references":     refs,
	}
	if v.Bool("cisaKev") {
		cve["cisaExploitAdd"] = pub.Add(kevAddedAfter).Format(time.DateOnly)
		cve["cisaActionDue"] = pub.Add(kevAddedAfter + kevDueAfter).Format(time.DateOnly)
		cve["cisaRequiredAction"] = kevAction
		cve["cisaVulnerabilityName"] = v.Str("title")
		refs = append(refs, map[string]any{"url": kevBase + id, "source": sourceMitre, "tags": []string{"US Government Resource"}})
		cve["references"] = refs
	}
	return record{id: id, published: pub, modified: mod, doc: map[string]any{"cve": cve}}
}

// CVSS 3.1 metric weights (FIRST CVSS v3.1 specification §7.4) and the names the NVD's cvssData uses.
var (
	cvssNames = map[string]map[string]string{
		"AV": {"N": "NETWORK", "A": "ADJACENT_NETWORK", "L": "LOCAL", "P": "PHYSICAL"},
		"AC": {"L": "LOW", "H": "HIGH"},
		"PR": {"N": "NONE", "L": "LOW", "H": "HIGH"},
		"UI": {"N": "NONE", "R": "REQUIRED"},
		"S":  {"U": "UNCHANGED", "C": "CHANGED"},
		"C":  {"H": "HIGH", "L": "LOW", "N": "NONE"},
		"I":  {"H": "HIGH", "L": "LOW", "N": "NONE"},
		"A":  {"H": "HIGH", "L": "LOW", "N": "NONE"},
	}
	cvssFields = map[string]string{"AV": "attackVector", "AC": "attackComplexity", "PR": "privilegesRequired", "UI": "userInteraction", "S": "scope",
		"C": "confidentialityImpact", "I": "integrityImpact", "A": "availabilityImpact"}
	weightAV       = map[string]float64{"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.2}
	weightAC       = map[string]float64{"L": 0.77, "H": 0.44}
	weightPR       = map[string]float64{"N": 0.85, "L": 0.62, "H": 0.27}
	weightPRScoped = map[string]float64{"N": 0.85, "L": 0.68, "H": 0.5}
	weightUI       = map[string]float64{"N": 0.85, "R": 0.62}
	weightCIA      = map[string]float64{"H": 0.56, "L": 0.22, "N": 0}
)

const (
	exploitabilityCoefficient = 8.22
	impactUnchanged           = 6.42
	impactChanged             = 7.52
	impactChangedOffset       = 0.029
	impactChangedTail         = 3.25
	impactChangedTailOffset   = 0.02
	impactChangedTailPower    = 15
)

// cvss31 decodes a CVSS 3.1 vector into the NVD's cvssData fields and the exploitability and impact subscores.
func cvss31(vector string) (map[string]any, float64, float64) {
	data := map[string]any{}
	m := map[string]string{}
	for _, part := range strings.Split(vector, "/")[1:] {
		k, val, ok := strings.Cut(part, ":")
		if !ok {
			continue
		}
		m[k] = val
		if names, ok := cvssNames[k]; ok {
			data[cvssFields[k]] = names[val]
		}
	}
	scoped := m["S"] == "C"
	pr := weightPR[m["PR"]]
	if scoped {
		pr = weightPRScoped[m["PR"]]
	}
	exploitability := exploitabilityCoefficient * weightAV[m["AV"]] * weightAC[m["AC"]] * pr * weightUI[m["UI"]]
	iss := 1 - (1-weightCIA[m["C"]])*(1-weightCIA[m["I"]])*(1-weightCIA[m["A"]])
	impact := impactUnchanged * iss
	if scoped {
		impact = impactChanged*(iss-impactChangedOffset) - impactChangedTail*math.Pow(iss-impactChangedTailOffset, impactChangedTailPower)
	}
	round := func(x float64) float64 { return math.Round(x*tenths) / tenths }
	return data, round(exploitability), round(impact)
}

// limiter is the NVD's rolling-window rate limit, one budget for keyed and one for keyless callers.
type limiter struct {
	mu   sync.Mutex
	hits map[bool][]time.Time
}

func (l *limiter) allow(keyed bool, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	limit := limitKeyless
	if keyed {
		limit = limitKeyed
	}
	kept := l.hits[keyed][:0]
	for _, t := range l.hits[keyed] {
		if now.Sub(t) < rateWindow {
			kept = append(kept, t)
		}
	}
	if len(kept) >= limit {
		l.hits[keyed] = kept
		return false
	}
	l.hits[keyed] = append(kept, now)
	return true
}

var timeLayouts = []string{nvdLayout, "2006-01-02T15:04:05.000Z07:00", "2006-01-02T15:04:05Z07:00", "2006-01-02T15:04:05"}

func parseNVDTime(s string) (time.Time, bool) {
	for _, layout := range timeLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

var knownParams = map[string]bool{"cveId": true, "lastModStartDate": true, "lastModEndDate": true, "resultsPerPage": true, "startIndex": true}

// invalid answers the way the NVD does for a rejected request: 404 with the reason in a message header.
func invalid(w http.ResponseWriter, message string) {
	w.Header().Set("message", message)
	w.WriteHeader(http.StatusNotFound)
}

func handler(env *sim.Env, records []record) http.Handler {
	lim := &limiter{hits: map[bool][]time.Time{}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+basePath, func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("apiKey")
		if key != "" && key != env.Secret {
			invalid(w, "Invalid apiKey")
			return
		}
		if !lim.allow(key != "", time.Now()) {
			sim.WriteJSON(w, http.StatusForbidden, map[string]string{"message": "rate limit exceeded", "provenance": sim.Provenance})
			return
		}
		q := r.URL.Query()
		for k := range q {
			if !knownParams[k] {
				invalid(w, "parameter not supported by the simulated API: "+k)
				return
			}
		}
		perPage := maxPerPage
		if s := q.Get("resultsPerPage"); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil || n < 1 || n > maxPerPage {
				invalid(w, "Invalid resultsPerPage")
				return
			}
			perPage = n
		}
		start := 0
		if s := q.Get("startIndex"); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil || n < 0 {
				invalid(w, "Invalid startIndex")
				return
			}
			start = n
		}
		from, to := q.Get("lastModStartDate"), q.Get("lastModEndDate")
		if (from == "") != (to == "") {
			invalid(w, "Both lastModStartDate and lastModEndDate are required when either is present")
			return
		}
		var lo, hi time.Time
		windowed := from != ""
		if windowed {
			var ok1, ok2 bool
			lo, ok1 = parseNVDTime(from)
			hi, ok2 = parseNVDTime(to)
			if !ok1 || !ok2 || hi.Before(lo) {
				invalid(w, "Invalid lastModStartDate or lastModEndDate")
				return
			}
			if hi.Sub(lo) > maxRange {
				invalid(w, "The date range must not exceed 120 days")
				return
			}
		}
		var match []record
		for _, rec := range records {
			if id := q.Get("cveId"); id != "" && !strings.EqualFold(id, rec.id) {
				continue
			}
			if windowed && (rec.modified.Before(lo) || rec.modified.After(hi)) {
				continue
			}
			match = append(match, rec)
		}
		if start > len(match) {
			start = len(match)
		}
		end := start + perPage
		if end > len(match) {
			end = len(match)
		}
		page := make([]any, 0, end-start)
		for _, rec := range match[start:end] {
			page = append(page, rec.doc)
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{
			"resultsPerPage": len(page), "startIndex": start, "totalResults": len(match), "format": "NVD_CVE", "version": "2.0",
			"timestamp": time.Now().UTC().Format(nvdLayout), "vulnerabilities": page,
		})
	})
	return mux
}

func records(e *estate.Estate) []record {
	var out []record
	for _, v := range vulns(e) {
		out = append(out, buildRecord(e, v))
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].published.Equal(out[j].published) {
			return out[i].published.Before(out[j].published)
		}
		return out[i].id < out[j].id
	})
	return out
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	ep, _, err := sim.ServeHTTPS(env, handler(env, records(e)))
	return ep, err
}

// WindowHours is the modification window (whole hours back from now) that reaches the oldest estate record.
func WindowHours(e *estate.Estate, now time.Time) int {
	oldest := now
	for _, v := range vulns(e) {
		if t := parseEstateTime(v.Str("lastModifiedAt")); !t.IsZero() && t.Before(oldest) {
			oldest = t
		}
	}
	return int(math.Ceil((now.Sub(oldest) + windowMargin).Hours()))
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	vs := vulns(e)
	if len(vs) == 0 {
		return nil
	}
	run := sim.Run{
		Name:           "nvd-2.0",
		Targets:        []sim.Target{{Kind: "url", Value: ep.URL + basePath, Label: "NVD CVE API 2.0 (simulated)"}},
		Options:        map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM, "lastModifiedHours": WindowHours(e, time.Now()), "resultsPerPage": runPerPage},
		CredentialType: "api_token",
		Credential:     &sim.Credential{Type: "api_token", Fields: map[string]string{"token": env.Secret}},
	}
	for _, v := range vs {
		run.Expect.EstateCI(v)
	}
	return []sim.Run{run}
}
