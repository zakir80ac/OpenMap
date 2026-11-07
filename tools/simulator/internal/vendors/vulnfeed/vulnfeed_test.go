// T-441 REQ-QA-005 REQ-DISC-027 — the real vulnerability_feed collector, TLS pinned to the simulated-mode CA and
// sending its apiKey, reads the simulated NVD CVE API 2.0 over a modification window longer than the API's
// 120-day range limit (several consecutive ranges) at five records a page, and reconstructs every estate
// vulnerability: identity, severity, CVSS score and vector, KEV listing, exploit knowledge and the affected
// vendor:product pairs of the estate's affected_by software.
package vulnfeed

import (
	"context"
	"encoding/json"
	"os/exec"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/simtest"
	"github.com/openmap/openmap/tools/simulator/internal/verify"
)

func TestSimulatedNVD(t *testing.T) {
	reports := simtest.Run(t, Vendor{})
	e := simtest.Estate(t)
	if hours := WindowHours(e, time.Now()); time.Duration(hours)*time.Hour <= maxRange {
		t.Fatalf("the estate window (%d h) no longer exceeds one 120-day range; the range split is not exercised", hours)
	}
	for _, r := range reports {
		if pages := (r.ExpectedCis + runPerPage - 1) / runPerPage; r.Requests < pages {
			t.Fatalf("expected at least %d paged requests, saw %d", pages, r.Requests)
		}
		t.Logf("%d requests, first: %v", r.Requests, r.RequestSample)
	}
}

func TestSimulatedNVDAttributes(t *testing.T) {
	e := simtest.Estate(t)
	ctx := context.Background()
	env, err := sim.NewEnv()
	if err != nil {
		t.Fatal(err)
	}
	repo, err := verify.RepoRoot()
	if err != nil {
		t.Fatal(err)
	}
	v := Vendor{}
	bin, err := verify.NewBinaries(repo, t.TempDir()).Path(ctx, v.Collector())
	if err != nil {
		t.Fatal(err)
	}
	out, err := exec.CommandContext(ctx, bin, "--manifest").Output()
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		ContractVersion string `json:"contractVersion"`
	}
	if err := json.Unmarshal(out, &manifest); err != nil {
		t.Fatal(err)
	}
	ep, err := v.Start(ctx, e, env)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ep.Close() }()
	run := v.Runs(e, ep, env)[0]
	res, stderr, err := verify.Execute(ctx, bin, verify.Invocation(e, v.Collector(), manifest.ContractVersion, run), time.Minute)
	if err != nil {
		t.Fatalf("%v: %s", err, stderr)
	}
	got := map[string]map[string]any{}
	for _, c := range res.Cis {
		got[c.Identity["cveId"]] = c.Attributes
	}
	for _, want := range vulns(e) {
		id := want.ID("cveId")
		a, ok := got[id]
		if !ok {
			t.Errorf("%s not emitted", id)
			continue
		}
		if a["severity"] != strings.ToUpper(want.Str("severity")) || a["cvssScore"] != want.Num("cvssScore", -1) || a["cvssVector"] != want.Str("cvssVector") {
			t.Errorf("%s CVSS: got %v %v %v, estate %s %v %s", id, a["severity"], a["cvssScore"], a["cvssVector"], want.Str("severity"), want.Num("cvssScore", -1), want.Str("cvssVector"))
		}
		if a["kev"] != want.Bool("cisaKev") || a["exploitKnown"] != (want.Bool("exploitedInWild") || want.Bool("cisaKev")) {
			t.Errorf("%s exploitation: kev %v exploitKnown %v, estate cisaKev %v exploitedInWild %v", id, a["kev"], a["exploitKnown"], want.Bool("cisaKev"), want.Bool("exploitedInWild"))
		}
		var products []string
		seen := map[string]bool{}
		for _, r := range e.Rels {
			if r.Type == "affected_by" && r.To.Identity["cveId"] == id {
				p := CPEProduct(r.From.Identity["vendor"], r.From.Identity["name"])
				if !seen[p] {
					seen[p] = true
					products = append(products, p)
				}
			}
		}
		sort.Strings(products)
		var emitted []string
		list, _ := a["affectedProducts"].([]any)
		for _, p := range list {
			s, _ := p.(string)
			emitted = append(emitted, s)
		}
		if strings.Join(emitted, ",") != strings.Join(products, ",") {
			t.Errorf("%s affected products: got %v, estate %v", id, emitted, products)
		}
	}
}
