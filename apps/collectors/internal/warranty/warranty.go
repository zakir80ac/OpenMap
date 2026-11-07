// REQ-CMDB-024 — warranty and end-of-life lookups by serial number (ADR-043). One job = one vendor account: the job
// lists the hardware to look up (serial, CI type, name, product id) and the collector asks the vendor's support API,
// in the batches the vendor allows, for the warranty term, service level and, for Cisco, the EoX milestones. Each
// answered serial becomes an observed CI of its own type, identified by serial number, carrying only the lookup's
// attributes, so the reconciler updates the CI the discovery collectors created and the asset register refreshes its
// vendor-sourced warranty and end of life. Adapters: Dell TechDirect (asset entitlements v5), Lenovo (warranty v2.5),
// Cisco (SN2INFO coverage v2 and EoX v5). Endpoint bases and token URLs are job options; credentials are vault
// references (oauth_client for Dell and Cisco, api_token for Lenovo).
package warranty

import (
	"context"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID  = "warranty"
	version      = "0.1.0"
	evidenceKind = "api_response"
	defaultPort  = 443
	tokenTimeout = 30 * time.Second
	dateLayout   = "2006-01-02"

	optionVendor = "vendor"
	optionAPI    = "apiUrl"
	optionToken  = "tokenUrl"
	optionAssets = "assets"
	optionEoX    = "eox"
	optionVerify = "verifyTls"
	optionCA     = "caCertPem"

	credClient = "clientId"
	credSecret = "clientSecret"
	credToken  = "token"

	VendorDell   = "dell"
	VendorLenovo = "lenovo"
	VendorCisco  = "cisco"

	// eolSource marks end-of-life dates as vendor-reported so the asset register refreshes them (ADR-043).
	eolSource = "vendor_api"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "warranty", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"oauth_client", "api_token"},
		TargetKinds: []string{"account"}, Emits: []string{"host", "network_device", "storage_array"},
		ContractVersion: contract.Version,
	}
}

// Asset is one piece of hardware the job asks about.
type Asset struct {
	SerialNumber string
	CiType       string
	Name         string
	ProductID    string
}

// Lookup is what a vendor reported for one serial.
type Lookup struct {
	SerialNumber string
	Provider     string
	Level        string
	Start        string
	End          string
	InWarranty   *bool
	ShipDate     string
	ProductID    string
	Description  string
	// Support contract cover (Cisco SN2INFO): the service line and its end, beyond the base hardware warranty.
	SupportContract string
	SupportLevel    string
	SupportEnd      string
	// EoX milestones (Cisco EoX).
	EndOfSale                string
	EndOfSoftwareMaintenance string
	EndOfSupport             string
	EoXBulletin              string
}

// Adapter queries one vendor.
type Adapter interface {
	Lookup(ctx context.Context, assets []Asset) (map[string]*Lookup, [][]byte, error)
}

// ParseAssets reads the job's asset list: objects with serialNumber, ciType, name and an optional productId.
func ParseAssets(options map[string]any) []Asset {
	raw, _ := options[optionAssets].([]any)
	out := make([]Asset, 0, len(raw))
	seen := map[string]bool{}
	for _, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		serial := strings.TrimSpace(str(m["serialNumber"]))
		if serial == "" || seen[strings.ToUpper(serial)] {
			continue
		}
		seen[strings.ToUpper(serial)] = true
		a := Asset{SerialNumber: serial, CiType: str(m["ciType"]), Name: str(m["name"]), ProductID: str(m["productId"])}
		if a.CiType == "" {
			a.CiType = "host"
		}
		if a.Name == "" {
			a.Name = serial
		}
		out = append(out, a)
	}
	return out
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// Batches splits assets into slices of at most size.
func Batches(assets []Asset, size int) [][]Asset {
	var out [][]Asset
	for len(assets) > 0 {
		n := size
		if len(assets) < n {
			n = len(assets)
		}
		out = append(out, assets[:n])
		assets = assets[n:]
	}
	return out
}

// Day returns the calendar date of an RFC 3339 instant or a date ("" when unparseable).
func Day(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if t, err := time.Parse(dateLayout, value); err == nil {
		return t.Format(dateLayout)
	}
	if t, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return t.UTC().Format(dateLayout)
	}
	if len(value) >= len(dateLayout) {
		if t, err := time.Parse(dateLayout, value[:len(dateLayout)]); err == nil {
			return t.Format(dateLayout)
		}
	}
	return ""
}

// Emit turns lookups into observations: one CI per answered asset, identified by its serial.
func Emit(assets []Asset, found map[string]*Lookup, raw [][]byte, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	verified := at.UTC().Format(time.RFC3339)
	for _, a := range assets {
		l, ok := found[strings.ToUpper(a.SerialNumber)]
		if !ok {
			continue
		}
		attrs := map[string]any{"serialNumber": a.SerialNumber, "warrantyProvider": l.Provider, "warrantyVerifiedAt": verified}
		set := func(k, v string) {
			if v != "" {
				attrs[k] = v
			}
		}
		set("warrantyLevel", l.Level)
		set("warrantyStart", l.Start)
		set("warrantyEnd", l.End)
		set("shipDate", l.ShipDate)
		set("vendorProductId", l.ProductID)
		set("vendorProductDescription", l.Description)
		set("supportContractNumber", l.SupportContract)
		set("supportLevel", l.SupportLevel)
		set("supportEnd", l.SupportEnd)
		if l.InWarranty != nil {
			attrs["inWarranty"] = *l.InWarranty
		} else if l.End != "" {
			attrs["inWarranty"] = l.End >= at.UTC().Format(dateLayout)
		}
		if l.EndOfSale != "" || l.EndOfSoftwareMaintenance != "" || l.EndOfSupport != "" {
			set("endOfSale", l.EndOfSale)
			set("endOfSoftwareMaintenance", l.EndOfSoftwareMaintenance)
			set("endOfSupport", l.EndOfSupport)
			set("eoxBulletin", l.EoXBulletin)
			attrs["eolSource"] = eolSource
			attrs["eolVerifiedAt"] = verified
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{
			Type: a.CiType, Identity: map[string]string{"serialNumber": a.SerialNumber}, Name: a.Name, Attributes: attrs,
			Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: l.Provider, ID: a.SerialNumber}}, ObservedAt: at,
		})
	}
	return obs
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	assets := ParseAssets(options)
	if len(assets) == 0 {
		return collector.Observation{}, collector.Errorf(contract.ErrUnsupportedDevice, false, "warranty job lists no assets (option %q)", optionAssets)
	}
	base := strings.TrimSpace(restjson.StringOption(options, optionAPI))
	if base == "" {
		base = target.Value
	}
	tls := tlsOptions{verify: restjson.BoolOption(options, optionVerify), caPem: restjson.StringOption(options, optionCA)}
	var adapter Adapter
	var err error
	switch vendor := restjson.StringOption(options, optionVendor); vendor {
	case VendorDell:
		adapter, err = newDell(ctx, base, restjson.StringOption(options, optionToken), cred, tls)
	case VendorLenovo:
		adapter, err = newLenovo(base, cred, tls)
	case VendorCisco:
		adapter, err = newCisco(ctx, base, restjson.StringOption(options, optionToken), cred, tls, restjson.BoolOption(options, optionEoX))
	default:
		return collector.Observation{}, collector.Errorf(contract.ErrUnsupportedDevice, false, "unknown warranty vendor %q (dell, lenovo, cisco)", vendor)
	}
	if err != nil {
		return collector.Observation{}, err
	}
	found, raw, err := adapter.Lookup(ctx, assets)
	if err != nil {
		return collector.Observation{}, restjson.Classify(target.Value, err)
	}
	return Emit(assets, found, raw, time.Now().UTC()), nil
}

type tlsOptions struct {
	verify bool
	caPem  string
}

func (t tlsOptions) client(base string, auth restjson.Auth, headers map[string]string) (*restjson.Client, error) {
	return restjson.New(base, defaultPort, auth, restjson.Options{VerifyTLS: t.verify, CAPem: t.caPem, Headers: headers})
}
