// REQ-QA-005 REQ-DISC-010 — simulated Azure: a Microsoft Entra ID token endpoint (OAuth 2.0 client credentials,
// v2.0, per tenant) and Azure Resource Manager on separate HTTPS listeners, both under the simulated-mode CA. ARM
// checks the bearer token, requires api-version, and pages every list with nextLink/$skiptoken: subscription,
// resources, virtual machines, network interfaces, virtual networks, public IP addresses, plus the billing
// properties and credit balance the collector reads for subscription cover.
//
// Rendered from the estate: each Azure cloud_account (subscription id, directory tenant, display name) and its
// member cloud_resources (ids, names, types, locations, SKUs, tags). Generated deterministically, because the estate
// carries no such facts: VM details (vmId, size from the estate SKU, a Canonical Ubuntu image, OS disk), one NIC per
// VM (also listed as a resource, as ARM does), virtual-network address spaces with one subnet, NIC addresses and
// MACs, and the billing account id. Pay-as-you-go accounts report no credit balance (404), as Azure does.
package azure

import (
	"context"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors/cloudsim"
)

const (
	provider       = "azure"
	keyLogin       = "login"
	keyARM         = "arm"
	grantType      = "client_credentials"
	scopeSuffix    = "/.default"
	tokenLifetime  = 3599
	firstHost      = 4 // Azure reserves the first four addresses of every subnet
	subnetName     = "default"
	diskGb         = 30
	typeVM         = "Microsoft.Compute/virtualMachines"
	typeVNet       = "Microsoft.Network/virtualNetworks"
	typeNIC        = "Microsoft.Network/networkInterfaces"
	imagePublisher = "Canonical"
	imageOffer     = "0001-com-ubuntu-server-jammy"
	imageSku       = "22_04-lts-gen2"
	macBytes       = 3
	billingSuffix  = "_2019-05-31"
)

type Vendor struct{}

func (Vendor) ID() string             { return "azure" }
func (Vendor) Collector() string      { return "cloud_azure" }
func (Vendor) Requirements() []string { return []string{"REQ-DISC-010"} }

// clientID is the simulated app registration (client) id, derived from the process secret.
func clientID(env *sim.Env) string { return cloudsim.UUID("azure-client" + env.Secret) }

type resource struct {
	ci                                *estate.CI // nil for generated resources
	id, name, typ, location, sku      string
	tags                              map[string]string
	vmID, nicID, ip, mac, subnetID    string
	vnetPrefix, vnetSpace, subnetCIDR string
	hosts                             int
}

type subscription struct {
	ci               *estate.CI
	id, tenant, name string
	billingAccount   string
	resources        []*resource
	vms, nics, vnets []*resource
	byID             map[string]*resource
}

func accounts(e *estate.Estate) []*estate.CI {
	return e.OfType("cloud_account", func(c *estate.CI) bool { return c.ID("provider") == provider })
}

func resourceGroup(id string) string {
	parts := strings.Split(id, "/")
	for i := 0; i+1 < len(parts); i++ {
		if strings.EqualFold(parts[i], "resourceGroups") {
			return parts[i+1]
		}
	}
	return ""
}

func load(e *estate.Estate, a *estate.CI) *subscription {
	s := &subscription{ci: a, id: a.ID("accountId"), tenant: a.Str("directoryTenantId"), name: a.Str("displayName"), byID: map[string]*resource{}}
	if s.name == "" {
		s.name = a.Name
	}
	s.billingAccount = cloudsim.UUID("azure-ba"+s.id) + ":" + cloudsim.UUID("azure-ba2"+s.id) + billingSuffix
	var members []*estate.CI
	for _, m := range e.To(a, "member_of") {
		if m.Type == "cloud_resource" && m.ID("provider") == provider {
			members = append(members, m)
		}
	}
	sort.SliceStable(members, func(i, j int) bool { return members[i].Name < members[j].Name })
	add := func(r *resource) *resource {
		s.resources = append(s.resources, r)
		s.byID[strings.ToLower(r.id)] = r
		return r
	}
	newVNet := func(r *resource) {
		b := cloudsim.Byte("azure-vnet"+strings.ToLower(r.id), 1, 254)
		r.vnetPrefix = "10." + strconv.Itoa(b) + ".1."
		r.vnetSpace = "10." + strconv.Itoa(b) + ".0.0/16"
		r.subnetCIDR = r.vnetPrefix + "0/24"
		r.subnetID = r.id + "/subnets/" + subnetName
		s.vnets = append(s.vnets, r)
	}
	for _, m := range members {
		r := add(&resource{ci: m, id: m.ID("resourceId"), name: m.Name, typ: m.Str("resourceType"), location: m.Str("region"), sku: m.Str("sku"), tags: cloudsim.EstateTags(m.Str)})
		if r.typ == typeVNet {
			newVNet(r)
		}
	}
	for _, r := range append([]*resource(nil), s.resources...) {
		if r.typ != typeVM {
			continue
		}
		if len(s.vnets) == 0 {
			id := "/subscriptions/" + s.id + "/resourceGroups/" + resourceGroup(r.id) + "/providers/" + typeVNet + "/vnet-" + r.location
			newVNet(add(&resource{id: id, name: "vnet-" + r.location, typ: typeVNet, location: r.location, tags: map[string]string{}}))
		}
		vnet := s.vnets[0]
		vnet.hosts++
		mac := "00-0D-3A"
		for i := 0; i < macBytes; i++ {
			mac += "-" + strings.ToUpper(cloudsim.Hex("azure-mac"+r.id+strconv.Itoa(i), 2))
		}
		nic := add(&resource{id: "/subscriptions/" + s.id + "/resourceGroups/" + resourceGroup(r.id) + "/providers/" + typeNIC + "/" + r.name + "-nic01",
			name: r.name + "-nic01", typ: typeNIC, location: r.location, tags: map[string]string{},
			ip: vnet.vnetPrefix + strconv.Itoa(firstHost-1+vnet.hosts), mac: mac, subnetID: vnet.subnetID, vmID: r.id})
		r.vmID, r.nicID, r.ip, r.subnetID = cloudsim.UUID("azure-vmid"+strings.ToLower(r.id)), nic.id, nic.ip, vnet.subnetID
		s.vms = append(s.vms, r)
		s.nics = append(s.nics, nic)
	}
	return s
}

func idRef(id string) map[string]string { return map[string]string{"id": id} }

func (s *subscription) docs(kind string) []any {
	var out []any
	switch kind {
	case "resources":
		for _, r := range s.resources {
			doc := map[string]any{"id": r.id, "name": r.name, "type": r.typ, "location": r.location, "tags": r.tags}
			if r.sku != "" {
				doc["sku"] = map[string]string{"name": r.sku}
			}
			out = append(out, doc)
		}
	case "Microsoft.Compute/virtualMachines":
		for _, r := range s.vms {
			out = append(out, map[string]any{"id": r.id, "name": r.name, "type": typeVM, "location": r.location, "tags": r.tags, "zones": []string{},
				"properties": map[string]any{
					"vmId": r.vmID, "provisioningState": "Succeeded",
					"hardwareProfile": map[string]string{"vmSize": r.sku},
					"storageProfile": map[string]any{
						"imageReference": map[string]string{"publisher": imagePublisher, "offer": imageOffer, "sku": imageSku, "version": "latest"},
						"osDisk":         map[string]any{"osType": "Linux", "name": r.name + "-osdisk", "createOption": "FromImage", "diskSizeGB": diskGb},
						"dataDisks":      []any{},
					},
					"osProfile":      map[string]string{"computerName": r.name, "adminUsername": "azureadmin"},
					"networkProfile": map[string]any{"networkInterfaces": []any{map[string]any{"id": r.nicID, "properties": map[string]bool{"primary": true}}}},
				}})
		}
	case "Microsoft.Network/networkInterfaces":
		for _, n := range s.nics {
			out = append(out, map[string]any{"id": n.id, "name": n.name, "type": typeNIC, "location": n.location,
				"properties": map[string]any{"provisioningState": "Succeeded", "macAddress": n.mac, "primary": true, "virtualMachine": idRef(n.vmID),
					"ipConfigurations": []any{map[string]any{"id": n.id + "/ipConfigurations/ipconfig1", "name": "ipconfig1", "properties": map[string]any{
						"privateIPAddress": n.ip, "privateIPAllocationMethod": "Dynamic", "primary": true, "subnet": idRef(n.subnetID)}}}}})
		}
	case "Microsoft.Network/virtualNetworks":
		for _, v := range s.vnets {
			out = append(out, map[string]any{"id": v.id, "name": v.name, "type": typeVNet, "location": v.location,
				"properties": map[string]any{"provisioningState": "Succeeded", "addressSpace": map[string]any{"addressPrefixes": []string{v.vnetSpace}},
					"subnets": []any{map[string]any{"id": v.subnetID, "name": subnetName, "properties": map[string]any{"addressPrefix": v.subnetCIDR, "provisioningState": "Succeeded"}}}}})
		}
	case "Microsoft.Network/publicIPAddresses":
	default:
		return nil
	}
	if out == nil {
		out = []any{}
	}
	return out
}

func armError(w http.ResponseWriter, status int, code, message string) {
	sim.WriteJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func tokenError(w http.ResponseWriter, status int, code, description string) {
	sim.WriteJSON(w, status, map[string]any{"error": code, "error_description": description, "error_codes": []int{}})
}

type cloud struct {
	subs    map[string]*subscription
	tenants map[string]bool
	armURL  func() string
}

func (c *cloud) login(env *sim.Env) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /{tenant}/oauth2/v2.0/token", func(w http.ResponseWriter, r *http.Request) {
		tenant := r.PathValue("tenant")
		if !c.tenants[tenant] {
			tokenError(w, http.StatusBadRequest, "invalid_request", "AADSTS90002: Tenant '"+tenant+"' not found.")
			return
		}
		if err := r.ParseForm(); err != nil || r.PostForm.Get("grant_type") != grantType {
			tokenError(w, http.StatusBadRequest, "unsupported_grant_type", "AADSTS70003: The app requested an unsupported grant type.")
			return
		}
		if r.PostForm.Get("client_id") != clientID(env) {
			tokenError(w, http.StatusBadRequest, "unauthorized_client", "AADSTS700016: Application not found in the directory.")
			return
		}
		if r.PostForm.Get("client_secret") != env.Secret {
			tokenError(w, http.StatusUnauthorized, "invalid_client", "AADSTS7000215: Invalid client secret provided.")
			return
		}
		if r.PostForm.Get("scope") != strings.TrimSuffix(c.armURL(), "/")+scopeSuffix {
			tokenError(w, http.StatusBadRequest, "invalid_scope", "AADSTS70011: The provided value for scope is not valid.")
			return
		}
		sim.WriteJSON(w, http.StatusOK, map[string]any{"token_type": "Bearer", "expires_in": tokenLifetime, "ext_expires_in": tokenLifetime, "access_token": env.Token("azure-" + tenant)})
	})
	return mux
}

func (c *cloud) arm(env *sim.Env) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			armError(w, http.StatusMethodNotAllowed, "MethodNotAllowed", "the simulator serves reads")
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		var sub *subscription
		switch {
		case len(parts) >= 2 && parts[0] == "subscriptions":
			sub = c.subs[strings.ToLower(parts[1])]
		case len(parts) >= 4 && parts[0] == "providers" && parts[2] == "billingAccounts":
			for _, s := range c.subs {
				if s.billingAccount == parts[3] {
					sub = s
				}
			}
		}
		if sub == nil {
			armError(w, http.StatusNotFound, "SubscriptionNotFound", "The subscription could not be found.")
			return
		}
		if !sim.BearerOK(r, env.Token("azure-"+sub.tenant)) {
			armError(w, http.StatusUnauthorized, "InvalidAuthenticationToken", "The access token is invalid.")
			return
		}
		q := r.URL.Query()
		if q.Get("api-version") == "" {
			armError(w, http.StatusBadRequest, "MissingApiVersionParameter", "The api-version query parameter (?api-version=) is required for all requests.")
			return
		}
		rest := strings.Join(parts[min(len(parts), 2):], "/")
		switch {
		case parts[0] == "providers":
			armError(w, http.StatusNotFound, "ResourceNotFound", "No credit balance: the billing account is not credit based.")
		case rest == "":
			sim.WriteJSON(w, http.StatusOK, map[string]any{"id": "/subscriptions/" + sub.id, "subscriptionId": sub.id, "tenantId": sub.tenant, "displayName": sub.name, "state": "Enabled",
				"subscriptionPolicies": map[string]string{"quotaId": "PayAsYouGo_2014-09-01", "spendingLimit": "Off"}})
		case rest == "providers/Microsoft.Billing/billingProperties/default":
			sim.WriteJSON(w, http.StatusOK, map[string]any{"id": "/subscriptions/" + sub.id + "/providers/Microsoft.Billing/billingProperties/default", "name": "default",
				"properties": map[string]string{"billingAccountId": sub.billingAccount, "billingAccountDisplayName": sub.ci.Name, "billingProfileStatus": "Active"}})
		default:
			kind := strings.TrimPrefix(rest, "providers/")
			all := sub.docs(kind)
			if all == nil {
				armError(w, http.StatusNotFound, "ResourceTypeNotFound", "The resource type could not be found in the namespace.")
				return
			}
			offset, ok := cloudsim.Offset(q.Get("$skiptoken"))
			if !ok {
				armError(w, http.StatusBadRequest, "InvalidSkipToken", "The skip token is not valid.")
				return
			}
			start, end, next := cloudsim.Window(len(all), offset, cloudsim.PageCap)
			page := map[string]any{"value": all[start:end]}
			if next != "" {
				nq := url.Values{"api-version": {q.Get("api-version")}, "$skiptoken": {next}}
				page["nextLink"] = strings.TrimSuffix(c.armURL(), "/") + r.URL.Path + "?" + nq.Encode()
			}
			sim.WriteJSON(w, http.StatusOK, page)
		}
	})
}

func (Vendor) Start(_ context.Context, e *estate.Estate, env *sim.Env) (*sim.Endpoint, error) {
	c := &cloud{subs: map[string]*subscription{}, tenants: map[string]bool{}}
	for _, a := range accounts(e) {
		s := load(e, a)
		c.subs[strings.ToLower(s.id)] = s
		c.tenants[s.tenant] = true
	}
	var ep *sim.Endpoint
	c.armURL = func() string { return ep.Devices[keyARM] }
	var err error
	ep, err = sim.ServeEach(env, []string{keyLogin, keyARM}, true, func(k string) http.Handler {
		if k == keyLogin {
			return c.login(env)
		}
		return c.arm(env)
	})
	return ep, err
}

func (Vendor) Runs(e *estate.Estate, ep *sim.Endpoint, env *sim.Env) []sim.Run {
	var runs []sim.Run
	for _, a := range accounts(e) {
		s := load(e, a)
		run := sim.Run{
			Name:           s.id,
			Targets:        []sim.Target{{Kind: "account", Value: s.id, Label: a.Name}},
			Options:        map[string]any{"authorityUrl": ep.Devices[keyLogin], "resourceManagerUrl": ep.Devices[keyARM], "caCertPem": env.CA.PEM},
			CredentialType: "oauth_client",
			Credential:     &sim.Credential{Type: "oauth_client", Fields: map[string]string{"clientId": clientID(env), "clientSecret": env.Secret, "tenantId": s.tenant}},
		}
		run.Expect.CIs = append(run.Expect.CIs, sim.ExpectCI{Type: "cloud_account", Name: s.name, Identity: a.Identity})
		for _, r := range s.resources {
			if r.ci != nil {
				run.Expect.EstateCI(r.ci)
			} else {
				run.Expect.CI("cloud_resource", r.name)
			}
			run.Expect.Rel("member_of", "cloud_resource", r.name, "cloud_account", s.name)
		}
		for _, v := range s.vnets {
			run.Expect.CI("subnet", v.name+"/"+subnetName)
			run.Expect.Rel("member_of", "subnet", v.name+"/"+subnetName, "cloud_resource", v.name)
		}
		for _, vm := range s.vms {
			osName := imageOffer + " " + imageSku
			subnet := ""
			for _, v := range s.vnets {
				if v.subnetID == vm.subnetID {
					subnet = v.name + "/" + subnetName
				}
			}
			run.Expect.CI("vm", vm.name)
			run.Expect.CI("ip_address", vm.ip)
			run.Expect.CI("operating_system", osName)
			run.Expect.Rel("hosted_on", "vm", vm.name, "cloud_resource", vm.name)
			run.Expect.Rel("uses_ip", "vm", vm.name, "ip_address", vm.ip)
			run.Expect.Rel("in_subnet", "ip_address", vm.ip, "subnet", subnet)
			run.Expect.Rel("installed_on", "operating_system", osName, "vm", vm.name)
		}
		runs = append(runs, run)
	}
	return runs
}
