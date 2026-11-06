// REQ-DISC-012 — out-of-band hardware collector over DMTF Redfish (HPE iLO 5/6, Dell iDRAC 9,
// Lenovo XClarity, Cisco CIMC, Supermicro, generic BMCs). One target = one BMC address. Emits the
// physical host with serial, model, BIOS, CPUs, memory and power, the bmc CI, and manages/contains
// relationships. Falls back to IPMI-style minimal data when the service root is incomplete.
package redfish

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	collectorID  = "ipmi_redfish"
	version      = "0.1.0"
	serviceRoot  = "/redfish/v1/"
	httpTimeout  = 20 * time.Second
	optionPort   = "port"
	optionVerify = "verifyTls" // BMCs ship self-signed certificates; pinning is the job's choice.
	credUser     = "username"
	credPassword = "password"
	evidenceKind = "api_response"

	typeHost    = "host"
	typeBmc     = "bmc"
	relManages  = "manages"
	relContains = "contains"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "ipmi_redfish", Version: version, Language: "go",
		Protocols: []string{"redfish"}, CredentialTypes: []string{"password"},
		TargetKinds: []string{"host"}, Emits: []string{typeHost, typeBmc},
		ContractVersion: contract.Version,
	}
}

// Client is a minimal Redfish HTTP client: basic auth, JSON GET, relative links.
type Client struct {
	base *url.URL
	http *http.Client
	user string
	pass string
}

func NewClient(host string, port int, user, pass string, verifyTLS bool) *Client {
	base := &url.URL{Scheme: "https", Host: net.JoinHostPort(host, strconv.Itoa(port))}
	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: !verifyTLS, MinVersion: tls.VersionTLS12}} //nolint:gosec // BMC certificates are self-signed by design; verifyTls=true enforces the chain.
	return &Client{base: base, http: &http.Client{Timeout: httpTimeout, Transport: tr}, user: user, pass: pass}
}

// Get fetches a Redfish resource; `path` may be absolute (@odata.id) or relative to the service root.
func (c *Client) Get(ctx context.Context, path string, out any) ([]byte, error) {
	u := c.base.ResolveReference(&url.URL{Path: path})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(c.user, c.pass)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("OData-Version", "4.0")
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return nil, collector.Errorf(contract.ErrAuthFailed, false, "%s rejected the credential (%d)", c.base.Host, res.StatusCode)
	}
	if res.StatusCode >= http.StatusBadRequest {
		return nil, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s returned %d for %s", c.base.Host, res.StatusCode, path)
	}
	if out != nil {
		if err := json.Unmarshal(body, out); err != nil {
			return nil, collector.Errorf(contract.ErrParse, false, "%s: invalid JSON at %s: %v", c.base.Host, path, err)
		}
	}
	return body, nil
}

type odataRef struct {
	ID string `json:"@odata.id"`
}

type serviceRootDoc struct {
	RedfishVersion string   `json:"RedfishVersion"`
	Vendor         string   `json:"Vendor"`
	Product        string   `json:"Product"`
	Systems        odataRef `json:"Systems"`
	Chassis        odataRef `json:"Chassis"`
	Managers       odataRef `json:"Managers"`
}

type collectionDoc struct {
	Members []odataRef `json:"Members"`
}

type status struct {
	State  string `json:"State"`
	Health string `json:"Health"`
}

type systemDoc struct {
	ID               string `json:"Id"`
	Name             string `json:"Name"`
	Manufacturer     string `json:"Manufacturer"`
	Model            string `json:"Model"`
	SKU              string `json:"SKU"`
	SerialNumber     string `json:"SerialNumber"`
	PartNumber       string `json:"PartNumber"`
	UUID             string `json:"UUID"`
	HostName         string `json:"HostName"`
	PowerState       string `json:"PowerState"`
	BiosVersion      string `json:"BiosVersion"`
	Status           status `json:"Status"`
	ProcessorSummary struct {
		Count int    `json:"Count"`
		Model string `json:"Model"`
	} `json:"ProcessorSummary"`
	MemorySummary struct {
		TotalSystemMemoryGiB float64 `json:"TotalSystemMemoryGiB"`
	} `json:"MemorySummary"`
	Links struct {
		Chassis   []odataRef `json:"Chassis"`
		ManagedBy []odataRef `json:"ManagedBy"`
	} `json:"Links"`
	EthernetInterfaces odataRef `json:"EthernetInterfaces"`
	Processors         odataRef `json:"Processors"`
	Memory             odataRef `json:"Memory"`
	Storage            odataRef `json:"Storage"`
}

type chassisDoc struct {
	ODataID      string `json:"@odata.id"`
	ID           string `json:"Id"`
	ChassisType  string `json:"ChassisType"`
	Manufacturer string `json:"Manufacturer"`
	Model        string `json:"Model"`
	SerialNumber string `json:"SerialNumber"`
	PartNumber   string `json:"PartNumber"`
	Location     struct {
		PartLocation struct {
			LocationOrdinalValue int    `json:"LocationOrdinalValue"`
			LocationType         string `json:"LocationType"`
		} `json:"PartLocation"`
		Placement struct {
			Rack       string `json:"Rack"`
			RackOffset int    `json:"RackOffset"`
			Row        string `json:"Row"`
		} `json:"Placement"`
	} `json:"Location"`
	Power           odataRef `json:"Power"`
	Thermal         odataRef `json:"Thermal"`
	NetworkAdapters odataRef `json:"NetworkAdapters"`
	Status          status   `json:"Status"`
}

type managerDoc struct {
	ID              string `json:"Id"`
	ManagerType     string `json:"ManagerType"`
	Model           string `json:"Model"`
	FirmwareVersion string `json:"FirmwareVersion"`
	UUID            string `json:"UUID"`
	Status          status `json:"Status"`
}

type powerDoc struct {
	PowerControl []struct {
		PowerConsumedWatts float64 `json:"PowerConsumedWatts"`
		PowerCapacityWatts float64 `json:"PowerCapacityWatts"`
	} `json:"PowerControl"`
	PowerSupplies []struct {
		Name               string  `json:"Name"`
		SerialNumber       string  `json:"SerialNumber"`
		PowerCapacityWatts float64 `json:"PowerCapacityWatts"`
		LineInputVoltage   float64 `json:"LineInputVoltage"`
		Status             status  `json:"Status"`
	} `json:"PowerSupplies"`
}

type thermalDoc struct {
	Temperatures []struct {
		Name            string  `json:"Name"`
		ReadingCelsius  float64 `json:"ReadingCelsius"`
		PhysicalContext string  `json:"PhysicalContext"`
	} `json:"Temperatures"`
}

type ethernetDoc struct {
	ID            string `json:"Id"`
	MACAddress    string `json:"MACAddress"`
	Name          string `json:"Name"`
	LinkStatus    string `json:"LinkStatus"`
	SpeedMbps     int    `json:"SpeedMbps"`
	IPv4Addresses []struct {
		Address string `json:"Address"`
	} `json:"IPv4Addresses"`
}

// Inventory is everything gathered from one BMC, ready for Emit.
type Inventory struct {
	Root     serviceRootDoc
	Systems  []systemDoc
	Chassis  []chassisDoc
	Managers []managerDoc
	Power    map[string]powerDoc   // keyed by chassis id
	Thermal  map[string]thermalDoc // keyed by chassis id
	Macs     map[string][]ethernetDoc
	Parts    map[string]parts        // keyed by system id (REQ-CMDB-014)
	Adapters map[string][]adapterDoc // keyed by chassis id
	Raw      [][]byte
}

func (c *Client) members(ctx context.Context, path string) ([]odataRef, []byte, error) {
	var col collectionDoc
	raw, err := c.Get(ctx, path, &col)
	if err != nil {
		return nil, nil, err
	}
	return col.Members, raw, nil
}

// Walk fetches the service root, systems, chassis (with power and thermal) and managers.
func (c *Client) Walk(ctx context.Context) (*Inventory, error) {
	inv := &Inventory{Power: map[string]powerDoc{}, Thermal: map[string]thermalDoc{}, Macs: map[string][]ethernetDoc{}, Parts: map[string]parts{}, Adapters: map[string][]adapterDoc{}}
	raw, err := c.Get(ctx, serviceRoot, &inv.Root)
	if err != nil {
		return nil, err
	}
	inv.Raw = append(inv.Raw, raw)
	if inv.Root.Systems.ID != "" {
		refs, raw, err := c.members(ctx, inv.Root.Systems.ID)
		if err != nil {
			return nil, err
		}
		inv.Raw = append(inv.Raw, raw)
		for _, r := range refs {
			var s systemDoc
			raw, err := c.Get(ctx, r.ID, &s)
			if err != nil {
				return nil, err
			}
			inv.Raw = append(inv.Raw, raw)
			inv.Systems = append(inv.Systems, s)
			inv.Parts[s.ID] = c.walkParts(ctx, s, inv)
			if s.EthernetInterfaces.ID != "" {
				if eth, raw, err := c.members(ctx, s.EthernetInterfaces.ID); err == nil {
					inv.Raw = append(inv.Raw, raw)
					for _, e := range eth {
						var doc ethernetDoc
						if raw, err := c.Get(ctx, e.ID, &doc); err == nil {
							inv.Raw = append(inv.Raw, raw)
							inv.Macs[s.ID] = append(inv.Macs[s.ID], doc)
						}
					}
				}
			}
		}
	}
	if inv.Root.Chassis.ID != "" {
		refs, raw, err := c.members(ctx, inv.Root.Chassis.ID)
		if err == nil {
			inv.Raw = append(inv.Raw, raw)
			for _, r := range refs {
				var ch chassisDoc
				raw, err := c.Get(ctx, r.ID, &ch)
				if err != nil {
					continue
				}
				inv.Raw = append(inv.Raw, raw)
				inv.Chassis = append(inv.Chassis, ch)
				if adapters := c.walkAdapters(ctx, ch, inv); len(adapters) > 0 {
					inv.Adapters[ch.ID] = adapters
				}
				if ch.Power.ID != "" {
					var p powerDoc
					if raw, err := c.Get(ctx, ch.Power.ID, &p); err == nil {
						inv.Raw = append(inv.Raw, raw)
						inv.Power[ch.ID] = p
					}
				}
				if ch.Thermal.ID != "" {
					var t thermalDoc
					if raw, err := c.Get(ctx, ch.Thermal.ID, &t); err == nil {
						inv.Raw = append(inv.Raw, raw)
						inv.Thermal[ch.ID] = t
					}
				}
			}
		}
	}
	if inv.Root.Managers.ID != "" {
		refs, raw, err := c.members(ctx, inv.Root.Managers.ID)
		if err == nil {
			inv.Raw = append(inv.Raw, raw)
			for _, r := range refs {
				var m managerDoc
				if raw, err := c.Get(ctx, r.ID, &m); err == nil {
					inv.Raw = append(inv.Raw, raw)
					inv.Managers = append(inv.Managers, m)
				}
			}
		}
	}
	if len(inv.Systems) == 0 {
		return nil, collector.Errorf(contract.ErrUnsupportedDevice, false, "%s exposes no Redfish systems", c.base.Host)
	}
	return inv, nil
}

func healthOf(s status) string {
	switch strings.ToUpper(s.Health) {
	case "OK":
		return "healthy"
	case "WARNING":
		return "degraded"
	case "CRITICAL":
		return "down"
	default:
		return "unknown"
	}
}

// Emit converts an inventory into contract observations.
func Emit(inv *Inventory, target contract.Target, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, raw := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: raw})
	}
	var bmcModel, bmcFirmware, bmcUUID string
	if len(inv.Managers) > 0 {
		m := inv.Managers[0]
		bmcModel, bmcFirmware, bmcUUID = m.Model, m.FirmwareVersion, m.UUID
	}
	bmcIdentity := map[string]string{"managementIp": target.Value}
	bmcRef := contract.CiRef{Type: typeBmc, Identity: bmcIdentity}
	obs.Cis = append(obs.Cis, contract.ObservedCi{
		Type: typeBmc, Identity: bmcIdentity, Name: firstNonEmpty(inv.Root.Product, bmcModel, "BMC") + " @ " + target.Value,
		Attributes: map[string]any{"vendor": inv.Root.Vendor, "product": inv.Root.Product, "model": bmcModel, "firmware": bmcFirmware, "uuid": bmcUUID, "redfishVersion": inv.Root.RedfishVersion, "managementIp": target.Value},
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at,
	})
	for _, s := range inv.Systems {
		identity := map[string]string{}
		if s.SerialNumber != "" {
			identity["serialNumber"] = s.SerialNumber
		}
		if s.UUID != "" {
			identity["systemUuid"] = strings.ToLower(s.UUID)
		}
		if s.HostName != "" {
			identity["fqdn"] = s.HostName
		}
		var macs []string
		var ipv4 []string
		for _, e := range inv.Macs[s.ID] {
			if e.MACAddress != "" {
				macs = append(macs, strings.ToLower(e.MACAddress))
			}
			for _, a := range e.IPv4Addresses {
				if a.Address != "" {
					ipv4 = append(ipv4, a.Address)
				}
			}
		}
		if len(macs) > 0 {
			identity["primaryMac"] = macs[0]
		}
		if len(identity) == 0 {
			identity["serialNumber"] = "bmc:" + target.Value + ":" + s.ID
		}
		attrs := map[string]any{
			"manufacturer": s.Manufacturer, "model": s.Model, "sku": s.SKU, "partNumber": s.PartNumber, "biosVersion": s.BiosVersion,
			"powerState": s.PowerState, "health": healthOf(s.Status), "cpuCount": s.ProcessorSummary.Count, "cpuModel": s.ProcessorSummary.Model,
			"memoryGb": s.MemorySummary.TotalSystemMemoryGiB, "bmcAddress": target.Value, "macAddresses": macs, "ipv4Addresses": ipv4, "redfishSystemId": s.ID,
		}
		for _, ch := range inv.Chassis {
			if p, ok := inv.Power[ch.ID]; ok && len(p.PowerControl) > 0 {
				attrs["powerWatts"] = p.PowerControl[0].PowerConsumedWatts
				attrs["powerCapacityWatts"] = p.PowerControl[0].PowerCapacityWatts
				attrs["powerSupplies"] = len(p.PowerSupplies)
				healthyPsu := 0
				for _, psu := range p.PowerSupplies {
					if strings.EqualFold(psu.Status.Health, "OK") {
						healthyPsu++
					}
				}
				attrs["powerSuppliesHealthy"] = healthyPsu
			}
			if t, ok := inv.Thermal[ch.ID]; ok {
				for _, temp := range t.Temperatures {
					if strings.Contains(strings.ToLower(temp.PhysicalContext), "intake") || strings.Contains(strings.ToLower(temp.Name), "inlet") {
						attrs["inletTempC"] = temp.ReadingCelsius
					}
					if strings.Contains(strings.ToLower(temp.PhysicalContext), "exhaust") {
						attrs["exhaustTempC"] = temp.ReadingCelsius
					}
				}
			}
			if ch.Location.Placement.Rack != "" {
				attrs["rack"] = ch.Location.Placement.Rack
				attrs["rackUnit"] = ch.Location.Placement.RackOffset
			}
			if ch.Manufacturer != "" && attrs["manufacturer"] == "" {
				attrs["manufacturer"] = ch.Manufacturer
			}
		}
		name := firstNonEmpty(s.HostName, s.Name, s.SerialNumber, target.Value)
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHost, Identity: identity, Name: name, Attributes: attrs, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at, Components: Components(inv, s)})
		hostRef := contract.CiRef{Type: typeHost, Identity: identity}
		// REQ-CMDB-034: power drawn, as the chassis PowerControl reports it.
		if w, ok := attrs["powerWatts"].(float64); ok && w > 0 {
			obs.Samples = append(obs.Samples, contract.MetricSample{Ci: hostRef, Metric: contract.MetricHostPower, Ts: at, Value: w, Unit: contract.UnitWatts, Labels: map[string]string{}})
		}
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relManages, From: bmcRef, To: hostRef, Attributes: map[string]any{"protocol": "redfish"}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relContains, From: hostRef, To: bmcRef, Attributes: map[string]any{}, ObservedAt: at})
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
	if cred == nil || cred.Type != "password" || cred.Fields[credUser] == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "redfish requires a password credential with a username")
	}
	port := 443
	if p, ok := options[optionPort]; ok {
		if n, err := strconv.Atoi(fmt.Sprint(p)); err == nil && n > 0 {
			port = n
		}
	}
	verify := false
	if v, ok := options[optionVerify].(bool); ok {
		verify = v
	}
	c := NewClient(target.Value, port, cred.Fields[credUser], cred.Fields[credPassword], verify)
	inv, err := c.Walk(ctx)
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
	return Emit(inv, target, time.Now().UTC()), nil
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
