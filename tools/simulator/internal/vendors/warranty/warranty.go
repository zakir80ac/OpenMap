// REQ-QA-005 REQ-CMDB-024 — simulated vendor warranty and EoX APIs on one HTTPS listener, answering for the estate's
// own hardware: Dell TechDirect (OAuth client credentials, asset entitlements v5) for Dell servers, Lenovo warranty
// v2.5 (ClientID header) for Lenovo servers, and Cisco SN2INFO coverage v2 plus EoX v5 (OAuth, paged) for Cisco
// network devices. Warranty terms are the estate's purchase date, warranty end and level. The EoX milestones are
// simulated: derived from a hash of the model, with one model in three answering "no bulletin" (EOXError) the way
// Cisco does for current products. They are not Cisco data.
package warranty

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
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
	dellPath         = "/PROD/sbil/eapi/v5/asset-entitlements"
	dellTokenPath    = "/auth/oauth/v2/token"
	dellMaxTags      = 100
	lenovoPath       = "/v2.5/warranty"
	ciscoTokenPath   = "/oauth2/default/v1/token"
	ciscoCoverage    = "/sn2info/v2/coverage/summary/serial_numbers/"
	ciscoEoX         = "/supporttools/eox/rest/5/EOXBySerialNumber/"
	ciscoMaxSerials  = 75
	ciscoMaxEoX      = 20
	coveragePageSize = 50
	eoxPageSize      = 10
	dateLayout       = "2006-01-02"
	tokenSeconds     = 3600
	// noBulletinEvery: one model in this many has no EoX bulletin.
	noBulletinEvery = 3
	// The simulated end of sale falls 0..saleSpreadMonths months after baseSale; support ends supportYears later.
	saleSpreadMonths = 72
	supportYears     = 5
	maintenanceYears = 1
	supportExtraDays = 365
)

var baseSale = time.Date(2022, time.January, 31, 0, 0, 0, 0, time.UTC)

const (
	manufacturerDell   = "Dell Technologies"
	manufacturerLenovo = "Lenovo"
	manufacturerCisco  = "Cisco Systems"
)

type Vendor struct{}

func (Vendor) ID() string             { return "vendor-warranty" }
func (Vendor) Collector() string      { return "warranty" }
func (Vendor) Requirements() []string { return []string{"REQ-CMDB-024"} }

func hardware(e *estate.Estate, ciType, manufacturer string) []*estate.CI {
	return e.OfType(ciType, func(c *estate.CI) bool {
		return c.Str("manufacturer") == manufacturer && c.ID("serialNumber") != "" && c.Str("warrantyEnd") != ""
	})
}

type book struct {
	bySerial map[string]*estate.CI
}

func index(cis ...[]*estate.CI) *book {
	b := &book{bySerial: map[string]*estate.CI{}}
	for _, list := range cis {
		for _, c := range list {
			b.bySerial[strings.ToUpper(c.ID("serialNumber"))] = c
		}
	}
	return b
}

func instant(day string) string {
	if day == "" {
		return ""
	}
	return day + "T00:00:00Z"
}

// eox returns the simulated milestones for a model, or ok=false when the model has no bulletin.
func eox(model string) (sale, maintenance, support, bulletin string, ok bool) {
	sum := sha256.Sum256([]byte(model))
	h := binary.BigEndian.Uint64(sum[:8])
	if h%noBulletinEvery == 0 {
		return "", "", "", "", false
	}
	s := baseSale.AddDate(0, int(h%saleSpreadMonths), 0)
	return s.Format(dateLayout), s.AddDate(maintenanceYears, 0, 0).Format(dateLayout), s.AddDate(supportYears, 0, supportExtraDays).Format(dateLayout), "EOL" + strconv.FormatUint(h%100000, 10), true
}

func pid(c *estate.CI) string {
	if p := c.Str("partNumber"); p != "" {
		return p
	}
	return strings.ToUpper(strings.ReplaceAll(c.Str("model"), " ", "-"))
}

func tokenHandler(env *sim.Env, scope string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil || r.PostForm.Get("grant_type") != "client_credentials" ||
			r.PostForm.Get("client_id") != env.User || r.PostForm.Get("client_secret") != env.Secret {
			sim.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_client"})
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"access_token": env.Token(scope), "token_type": "Bearer", "expires_in": tokenSeconds})
	}
}

func splitSerials(path, prefix string) []string {
	raw := strings.TrimPrefix(path, prefix)
	var out []string
	for _, s := range strings.Split(raw, ",") {
		if v, err := url.PathUnescape(strings.TrimSpace(s)); err == nil && v != "" {
			out = append(out, v)
		}
	}
	return out
}

func page[T any](items []T, index, size int) ([]T, int) {
	last := (len(items) + size - 1) / size
	if last == 0 {
		last = 1
	}
	start := (index - 1) * size
	if start < 0 || start > len(items) {
		return nil, last
	}
	end := start + size
	if end > len(items) {
		end = len(items)
	}
	return items[start:end], last
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	dell := index(hardware(e, "host", manufacturerDell))
	lenovo := index(hardware(e, "host", manufacturerLenovo))
	cisco := index(hardware(e, "network_device", manufacturerCisco))
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+dellTokenPath, tokenHandler(env, "dell"))
	mux.HandleFunc("POST "+ciscoTokenPath, tokenHandler(env, "cisco"))

	mux.HandleFunc("GET "+dellPath, func(w http.ResponseWriter, r *http.Request) {
		if !sim.BearerOK(r, env.Token("dell")) {
			sim.Unauthorized(w)
			return
		}
		tags := strings.Split(r.URL.Query().Get("servicetags"), ",")
		if len(tags) > dellMaxTags {
			sim.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "too many service tags"})
			return
		}
		out := []any{}
		for _, tag := range tags {
			c, ok := dell.bySerial[strings.ToUpper(tag)]
			if !ok {
				out = append(out, map[string]any{"serviceTag": tag, "invalid": true, "entitlements": []any{}})
				continue
			}
			out = append(out, map[string]any{
				"id": c.Num("lunId", 0), "serviceTag": c.ID("serialNumber"), "orderBuid": 0, "shipDate": instant(c.Str("purchaseDate")),
				"productCode": c.Str("partNumber"), "localChannel": "ENTP", "productId": strings.ToLower(strings.ReplaceAll(c.Str("model"), " ", "-")),
				"productLineDescription": strings.ToUpper(c.Str("model")), "productFamily": "Servers", "systemDescription": c.Str("model"),
				"productLobDescription": "PowerEdge", "countryCode": "SA", "duplicated": false, "invalid": false,
				"entitlements": []any{map[string]any{
					"itemNumber": "997-" + strings.ToUpper(c.ID("serialNumber"))[:4], "startDate": instant(c.Str("purchaseDate")),
					"endDate": c.Str("warrantyEnd") + "T23:59:59.000001Z", "entitlementType": "INITIAL", "serviceLevelCode": "PS",
					"serviceLevelDescription": c.Str("warrantyLevel"), "serviceLevelGroup": 5,
				}},
			})
		}
		sim.WriteJSON(w, http.StatusOK, out)
	})

	mux.HandleFunc("GET "+lenovoPath, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("ClientID") != env.Secret {
			sim.Unauthorized(w)
			return
		}
		c, ok := lenovo.bySerial[strings.ToUpper(r.URL.Query().Get("Serial"))]
		if !ok {
			sim.NotFound(w)
			return
		}
		end, _ := time.Parse(dateLayout, c.Str("warrantyEnd"))
		in := !end.Before(time.Now().UTC().Truncate(24 * time.Hour))
		sim.WriteJSON(w, http.StatusOK, map[string]any{
			"Serial": c.ID("serialNumber"), "Product": c.Str("partNumber"), "InWarranty": in, "Purchased": instant(c.Str("purchaseDate")),
			"Shipped": instant(c.Str("purchaseDate")), "Country": "sa",
			"Warranty": []any{map[string]any{"ID": "5WS", "Name": c.Str("warrantyLevel"), "Description": c.Str("warrantyLevel") + " for " + c.Str("model"),
				"Type": "BASE", "Start": instant(c.Str("purchaseDate")), "End": instant(c.Str("warrantyEnd"))}},
			"Contract": []any{},
		})
	})

	mux.HandleFunc("GET "+ciscoCoverage+"{serials}", func(w http.ResponseWriter, r *http.Request) {
		if !sim.BearerOK(r, env.Token("cisco")) {
			sim.Unauthorized(w)
			return
		}
		serials := splitSerials(r.URL.Path, ciscoCoverage)
		if len(serials) > ciscoMaxSerials {
			sim.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "too many serial numbers"})
			return
		}
		idx, _ := strconv.Atoi(r.URL.Query().Get("page_index"))
		if idx < 1 {
			idx = 1
		}
		var records []any
		for i, sn := range serials {
			c, ok := cisco.bySerial[strings.ToUpper(sn)]
			if !ok {
				continue
			}
			records = append(records, map[string]any{
				"id": strconv.Itoa(i + 1), "sr_no": c.ID("serialNumber"), "is_covered": "YES", "sr_no_owner": "YES",
				"coverage_end_date": c.Str("warrantyEnd"), "service_contract_number": "9" + strconv.Itoa(100000+i), "service_line_descr": "SNTC-24X7X4 " + c.Str("model"),
				"warranty_end_date": c.Str("warrantyEnd"), "warranty_type": "WARR-LTD-LIFE-HW", "covered_product_line_end_date": c.Str("warrantyEnd"),
				"orderable_pid_list": []any{map[string]any{"orderable_pid": pid(c), "item_description": c.Str("model"), "item_type": "PRODUCT", "item_position": ""}},
				"parent_sr_no":       "", "contract_site_customer_name": "BANK",
			})
		}
		rows, last := page(records, idx, coveragePageSize)
		sim.WriteJSON(w, http.StatusOK, map[string]any{
			"pagination_response_record": map[string]any{"last_index": last, "page_index": idx, "page_records": strconv.Itoa(len(rows)), "total_records": strconv.Itoa(len(records)), "title": "Coverage Summary by Serial Numbers"},
			"serial_numbers":             rows,
		})
	})

	mux.HandleFunc("GET "+ciscoEoX+"{page}/{serials}", func(w http.ResponseWriter, r *http.Request) {
		if !sim.BearerOK(r, env.Token("cisco")) {
			sim.Unauthorized(w)
			return
		}
		idx, err := strconv.Atoi(r.PathValue("page"))
		if err != nil || idx < 1 {
			sim.NotFound(w)
			return
		}
		serials := splitSerials(r.PathValue("serials"), "")
		if len(serials) > ciscoMaxEoX {
			sim.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "too many serial numbers"})
			return
		}
		var records []any
		for _, sn := range serials {
			c, ok := cisco.bySerial[strings.ToUpper(sn)]
			if !ok {
				continue
			}
			sale, maint, support, bulletin, has := eox(c.Str("model"))
			if !has {
				records = append(records, map[string]any{"EOXInputType": "ShowEOXBySerialNumber", "EOXInputValue": c.ID("serialNumber"),
					"EOXError": map[string]any{"ErrorID": "SSA_ERR_026", "ErrorDescription": "EOX information does not exist for the following product ID(s): " + pid(c)}})
				continue
			}
			date := func(v string) map[string]string { return map[string]string{"value": v, "dateFormat": "YYYY-MM-DD"} }
			records = append(records, map[string]any{
				"EOLProductID": pid(c), "ProductIDDescription": c.Str("model"), "ProductBulletinNumber": bulletin,
				"EndOfSaleDate": date(sale), "EndOfSWMaintenanceReleases": date(maint), "LastDateOfSupport": date(support),
				"EOXInputType": "ShowEOXBySerialNumber", "EOXInputValue": c.ID("serialNumber"),
			})
		}
		rows, last := page(records, idx, eoxPageSize)
		sim.WriteJSON(w, http.StatusOK, map[string]any{
			"PaginationResponseRecord": map[string]any{"PageIndex": idx, "LastIndex": last, "TotalRecords": len(records), "PageRecords": len(rows)},
			"EOXRecord":                rows,
		})
	})
	ep, _, err := sim.ServeHTTPS(env, mux)
	return ep, err
}

func assetsOf(list []*estate.CI, ciType string) []any {
	sorted := append([]*estate.CI(nil), list...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	out := make([]any, 0, len(sorted))
	for _, c := range sorted {
		out = append(out, map[string]any{"serialNumber": c.ID("serialNumber"), "ciType": ciType, "name": c.Name})
	}
	// An asset the vendor does not know: it must be skipped, not fail the job.
	out = append(out, map[string]any{"serialNumber": "SIMUNKNOWN0", "ciType": ciType, "name": "unknown-to-vendor"})
	return out
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	tls := map[string]any{"verifyTls": true, "caCertPem": env.CA.PEM, "apiUrl": ep.URL}
	opts := func(extra map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range tls {
			out[k] = v
		}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}
	oauth := &sim.Credential{Type: "oauth_client", Fields: map[string]string{"clientId": env.User, "clientSecret": env.Secret}}
	target := []sim.Target{{Kind: "account", Value: ep.URL, Label: "vendor support API (simulated)"}}
	var runs []sim.Run

	dell := hardware(e, "host", manufacturerDell)
	run := sim.Run{Name: "dell", Targets: target, CredentialType: "oauth_client", Credential: oauth,
		Options: opts(map[string]any{"vendor": "dell", "tokenUrl": ep.URL + dellTokenPath, "assets": assetsOf(dell, "host")})}
	for _, c := range dell {
		run.Expect.CIWith(c, "host", map[string]any{"warrantyEnd": c.Str("warrantyEnd"), "warrantyStart": c.Str("purchaseDate"), "warrantyLevel": c.Str("warrantyLevel"), "warrantyProvider": "Dell"})
	}
	runs = append(runs, run)

	lenovo := hardware(e, "host", manufacturerLenovo)
	run = sim.Run{Name: "lenovo", Targets: target, CredentialType: "api_token", Credential: &sim.Credential{Type: "api_token", Fields: map[string]string{"token": env.Secret}},
		Options: opts(map[string]any{"vendor": "lenovo", "assets": assetsOf(lenovo, "host")})}
	for _, c := range lenovo {
		run.Expect.CIWith(c, "host", map[string]any{"warrantyEnd": c.Str("warrantyEnd"), "warrantyLevel": c.Str("warrantyLevel"), "warrantyProvider": "Lenovo"})
	}
	runs = append(runs, run)

	cisco := hardware(e, "network_device", manufacturerCisco)
	run = sim.Run{Name: "cisco", Targets: target, CredentialType: "oauth_client", Credential: oauth,
		Options: opts(map[string]any{"vendor": "cisco", "eox": true, "tokenUrl": ep.URL + ciscoTokenPath, "assets": assetsOf(cisco, "network_device")})}
	for _, c := range cisco {
		attrs := map[string]any{"warrantyEnd": c.Str("warrantyEnd"), "supportEnd": c.Str("warrantyEnd"), "vendorProductId": pid(c)}
		if sale, maint, support, _, ok := eox(c.Str("model")); ok {
			attrs["endOfSale"], attrs["endOfSoftwareMaintenance"], attrs["endOfSupport"], attrs["eolSource"] = sale, maint, support, "vendor_api"
		}
		run.Expect.CIWith(c, "network_device", attrs)
	}
	runs = append(runs, run)
	return runs
}
