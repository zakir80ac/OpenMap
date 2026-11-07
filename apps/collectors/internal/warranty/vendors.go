// REQ-CMDB-024 — the vendor adapters behind the warranty collector (ADR-043), each following the vendor's published
// API: Dell TechDirect asset entitlements v5 (OAuth client credentials, up to 100 service tags per call), Lenovo
// warranty v2.5 (ClientID header, one serial per call), Cisco SN2INFO coverage summary v2 (up to 75 serials per call,
// paged) and Cisco EoX v5 by serial (up to 20 per call, paged), the last two behind one Cisco API console token.
package warranty

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	dellPath       = "/PROD/sbil/eapi/v5/asset-entitlements"
	dellBatch      = 100
	lenovoPath     = "/v2.5/warranty"
	lenovoHeader   = "ClientID"
	ciscoCoverage  = "/sn2info/v2/coverage/summary/serial_numbers/"
	ciscoEoX       = "/supporttools/eox/rest/5/EOXBySerialNumber/"
	ciscoBatch     = 75
	ciscoEoXBatch  = 20
	providerDell   = "Dell"
	providerLenovo = "Lenovo"
	providerCisco  = "Cisco"
	firstPage      = 1
	coveredYes     = "YES"
)

// clientCredentials performs an OAuth 2.0 client-credentials grant against tokenURL and returns the bearer token.
func clientCredentials(ctx context.Context, tokenURL string, cred *contract.Credential, tls tlsOptions) (string, error) {
	if cred == nil || cred.Fields[credClient] == "" || cred.Fields[credSecret] == "" {
		return "", collector.Errorf(contract.ErrAuthFailed, false, "an oauth_client credential with clientId and clientSecret is required")
	}
	if tokenURL == "" {
		return "", collector.Errorf(contract.ErrUnsupportedDevice, false, "option %q is required for this vendor", optionToken)
	}
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {cred.Fields[credClient]}, "client_secret": {cred.Fields[credSecret]}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	transport, err := restjson.TransportFor(tls.verify, tls.caPem)
	if err != nil {
		return "", err
	}
	res, err := (&http.Client{Timeout: tokenTimeout, Transport: transport}).Do(req)
	if err != nil {
		return "", collector.Errorf(contract.ErrUnreachable, true, "token endpoint: %v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		return "", collector.Errorf(contract.ErrAuthFailed, false, "token endpoint answered %d", res.StatusCode)
	}
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.AccessToken == "" {
		return "", collector.Errorf(contract.ErrParse, false, "token endpoint returned no access_token")
	}
	return out.AccessToken, nil
}

// --- Dell TechDirect ------------------------------------------------------------------------------------------------

type dellAsset struct {
	ServiceTag             string `json:"serviceTag"`
	ShipDate               string `json:"shipDate"`
	ProductLineDescription string `json:"productLineDescription"`
	ProductID              string `json:"productId"`
	Invalid                bool   `json:"invalid"`
	Entitlements           []struct {
		StartDate               string `json:"startDate"`
		EndDate                 string `json:"endDate"`
		EntitlementType         string `json:"entitlementType"`
		ServiceLevelCode        string `json:"serviceLevelCode"`
		ServiceLevelDescription string `json:"serviceLevelDescription"`
	} `json:"entitlements"`
}

type dell struct{ c *restjson.Client }

func newDell(ctx context.Context, base, tokenURL string, cred *contract.Credential, tls tlsOptions) (Adapter, error) {
	token, err := clientCredentials(ctx, tokenURL, cred, tls)
	if err != nil {
		return nil, err
	}
	c, err := tls.client(base, restjson.Auth{Bearer: token}, nil)
	if err != nil {
		return nil, err
	}
	return dell{c}, nil
}

// DellLookup reduces one asset's entitlements to a warranty: the earliest start, the latest end, and the service
// level of the entitlement that ends last.
func DellLookup(a dellAsset) *Lookup {
	l := &Lookup{SerialNumber: a.ServiceTag, Provider: providerDell, ShipDate: Day(a.ShipDate), ProductID: a.ProductID, Description: a.ProductLineDescription}
	for _, e := range a.Entitlements {
		start, end := Day(e.StartDate), Day(e.EndDate)
		if start != "" && (l.Start == "" || start < l.Start) {
			l.Start = start
		}
		if end != "" && end >= l.End {
			l.End = end
			l.Level = e.ServiceLevelDescription
		}
	}
	return l
}

func (d dell) Lookup(ctx context.Context, assets []Asset) (map[string]*Lookup, [][]byte, error) {
	found := map[string]*Lookup{}
	for _, batch := range Batches(assets, dellBatch) {
		tags := make([]string, 0, len(batch))
		for _, a := range batch {
			tags = append(tags, a.SerialNumber)
		}
		var page []dellAsset
		if err := d.c.Get(ctx, dellPath+"?"+url.Values{"servicetags": {strings.Join(tags, ",")}}.Encode(), &page); err != nil {
			return nil, nil, err
		}
		for _, a := range page {
			if a.Invalid || a.ServiceTag == "" {
				continue
			}
			found[strings.ToUpper(a.ServiceTag)] = DellLookup(a)
		}
	}
	return found, d.c.Raw(), nil
}

// --- Lenovo ---------------------------------------------------------------------------------------------------------

type lenovoWarranty struct {
	Serial     string `json:"Serial"`
	Product    string `json:"Product"`
	InWarranty *bool  `json:"InWarranty"`
	Shipped    string `json:"Shipped"`
	Warranty   []struct {
		Name        string `json:"Name"`
		Description string `json:"Description"`
		Type        string `json:"Type"`
		Start       string `json:"Start"`
		End         string `json:"End"`
	} `json:"Warranty"`
}

type lenovo struct{ c *restjson.Client }

func newLenovo(base string, cred *contract.Credential, tls tlsOptions) (Adapter, error) {
	if cred == nil || cred.Fields[credToken] == "" {
		return nil, collector.Errorf(contract.ErrAuthFailed, false, "lenovo requires an api_token credential (the ClientID)")
	}
	c, err := tls.client(base, restjson.Auth{}, map[string]string{lenovoHeader: cred.Fields[credToken]})
	if err != nil {
		return nil, err
	}
	return lenovo{c}, nil
}

// LenovoLookup reduces a warranty answer to its cover: earliest start, latest end and the name of the last-ending
// entitlement.
func LenovoLookup(w lenovoWarranty) *Lookup {
	l := &Lookup{SerialNumber: w.Serial, Provider: providerLenovo, InWarranty: w.InWarranty, ShipDate: Day(w.Shipped), ProductID: w.Product}
	for _, e := range w.Warranty {
		start, end := Day(e.Start), Day(e.End)
		if start != "" && (l.Start == "" || start < l.Start) {
			l.Start = start
		}
		if end != "" && end >= l.End {
			l.End = end
			l.Level = e.Name
		}
	}
	return l
}

func (lv lenovo) Lookup(ctx context.Context, assets []Asset) (map[string]*Lookup, [][]byte, error) {
	found := map[string]*Lookup{}
	for _, a := range assets {
		var w lenovoWarranty
		err := lv.c.Get(ctx, lenovoPath+"?"+url.Values{"Serial": {a.SerialNumber}}.Encode(), &w)
		if restjson.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		if w.Serial == "" || len(w.Warranty) == 0 {
			continue
		}
		found[strings.ToUpper(w.Serial)] = LenovoLookup(w)
	}
	return found, lv.c.Raw(), nil
}

// --- Cisco ----------------------------------------------------------------------------------------------------------

type ciscoCoveragePage struct {
	Pagination struct {
		LastIndex int `json:"last_index"`
		PageIndex int `json:"page_index"`
	} `json:"pagination_response_record"`
	SerialNumbers []struct {
		SrNo            string `json:"sr_no"`
		IsCovered       string `json:"is_covered"`
		CoverageEndDate string `json:"coverage_end_date"`
		ServiceContract string `json:"service_contract_number"`
		ServiceLine     string `json:"service_line_descr"`
		WarrantyEndDate string `json:"warranty_end_date"`
		WarrantyType    string `json:"warranty_type"`
		OrderablePIDs   []struct {
			PID         string `json:"orderable_pid"`
			Description string `json:"item_description"`
		} `json:"orderable_pid_list"`
	} `json:"serial_numbers"`
}

type ciscoDate struct {
	Value string `json:"value"`
}

type ciscoEoXPage struct {
	Pagination struct {
		PageIndex int `json:"PageIndex"`
		LastIndex int `json:"LastIndex"`
	} `json:"PaginationResponseRecord"`
	Records []struct {
		EOLProductID               string    `json:"EOLProductID"`
		ProductBulletinNumber      string    `json:"ProductBulletinNumber"`
		EndOfSaleDate              ciscoDate `json:"EndOfSaleDate"`
		EndOfSWMaintenanceReleases ciscoDate `json:"EndOfSWMaintenanceReleases"`
		LastDateOfSupport          ciscoDate `json:"LastDateOfSupport"`
		EOXInputValue              string    `json:"EOXInputValue"`
		EOXError                   *struct {
			ErrorID string `json:"ErrorID"`
		} `json:"EOXError"`
	} `json:"EOXRecord"`
}

type cisco struct {
	c   *restjson.Client
	eox bool
}

func newCisco(ctx context.Context, base, tokenURL string, cred *contract.Credential, tls tlsOptions, eox bool) (Adapter, error) {
	token, err := clientCredentials(ctx, tokenURL, cred, tls)
	if err != nil {
		return nil, err
	}
	c, err := tls.client(base, restjson.Auth{Bearer: token}, nil)
	if err != nil {
		return nil, err
	}
	return cisco{c: c, eox: eox}, nil
}

func serialsOf(batch []Asset) string {
	out := make([]string, 0, len(batch))
	for _, a := range batch {
		out = append(out, url.PathEscape(a.SerialNumber))
	}
	return strings.Join(out, ",")
}

func (cs cisco) Lookup(ctx context.Context, assets []Asset) (map[string]*Lookup, [][]byte, error) {
	found := map[string]*Lookup{}
	for _, batch := range Batches(assets, ciscoBatch) {
		for page := firstPage; ; page++ {
			var p ciscoCoveragePage
			path := ciscoCoverage + serialsOf(batch) + "?" + url.Values{"page_index": {strconv.Itoa(page)}}.Encode()
			if err := cs.c.Get(ctx, path, &p); err != nil {
				return nil, nil, err
			}
			for _, s := range p.SerialNumbers {
				if s.SrNo == "" {
					continue
				}
				l := &Lookup{SerialNumber: s.SrNo, Provider: providerCisco, Level: s.WarrantyType, End: Day(s.WarrantyEndDate)}
				if strings.EqualFold(s.IsCovered, coveredYes) {
					l.SupportContract, l.SupportLevel, l.SupportEnd = s.ServiceContract, s.ServiceLine, Day(s.CoverageEndDate)
				}
				if len(s.OrderablePIDs) > 0 {
					l.ProductID, l.Description = s.OrderablePIDs[0].PID, s.OrderablePIDs[0].Description
				}
				found[strings.ToUpper(s.SrNo)] = l
			}
			if p.Pagination.LastIndex <= page {
				break
			}
		}
	}
	if cs.eox {
		if err := cs.lookupEoX(ctx, assets, found); err != nil {
			return nil, nil, err
		}
	}
	return found, cs.c.Raw(), nil
}

// lookupEoX adds the EoX milestones of each serial's product; serials Cisco has no bulletin for keep only their cover.
func (cs cisco) lookupEoX(ctx context.Context, assets []Asset, found map[string]*Lookup) error {
	for _, batch := range Batches(assets, ciscoEoXBatch) {
		for page := firstPage; ; page++ {
			var p ciscoEoXPage
			if err := cs.c.Get(ctx, ciscoEoX+strconv.Itoa(page)+"/"+serialsOf(batch), &p); err != nil {
				return err
			}
			for _, r := range p.Records {
				if r.EOXError != nil || r.EOXInputValue == "" {
					continue
				}
				key := strings.ToUpper(r.EOXInputValue)
				l, ok := found[key]
				if !ok {
					l = &Lookup{SerialNumber: r.EOXInputValue, Provider: providerCisco}
					found[key] = l
				}
				l.EndOfSale = Day(r.EndOfSaleDate.Value)
				l.EndOfSoftwareMaintenance = Day(r.EndOfSWMaintenanceReleases.Value)
				l.EndOfSupport = Day(r.LastDateOfSupport.Value)
				l.EoXBulletin = r.ProductBulletinNumber
				if l.ProductID == "" {
					l.ProductID = r.EOLProductID
				}
			}
			if p.Pagination.LastIndex <= page {
				break
			}
		}
	}
	return nil
}
