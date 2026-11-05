// REQ-DISC-010 — Azure collector over Azure Resource Manager: client-credential token from the
// tenant's authority (public, Government and China clouds differ, so both endpoints come from the
// job), subscription facts, every resource with tags and SKU, virtual machines with NICs, private
// and public addresses, and virtual networks with subnets. One target = one subscription.
package azure

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const (
	collectorID     = "cloud_azure"
	version         = "0.1.0"
	provider        = "azure"
	evidenceKind    = "api_response"
	defaultPort     = 443
	tokenTimeout    = 30 * time.Second
	optionAuthority = "authorityUrl"       // e.g. the tenant's login endpoint base
	optionArm       = "resourceManagerUrl" // the ARM endpoint base
	credClientID    = "clientId"
	credSecret      = "clientSecret"
	credTenant      = "tenantId"
	apiSubscription = "2022-12-01"
	apiResources    = "2021-04-01"
	apiCompute      = "2024-07-01"
	apiNetwork      = "2024-01-01"
	// Billing properties of the subscription (the billing account it sits under) and the credit balance of a
	// credit-based account (sponsorship, Azure credits), both read-only (REQ-CMDB-042).
	apiBillingProperties = "2020-05-01"
	apiCredits           = "2023-05-01"
	vrfInternet          = "internet"

	typeAccount  = "cloud_account"
	typeResource = "cloud_resource"
	typeVM       = "vm"
	typeSubnet   = "subnet"
	typeIP       = "ip_address"
	typeOS       = "operating_system"
	relMemberOf  = "member_of"
	relHostedOn  = "hosted_on"
	relUsesIP    = "uses_ip"
	relInSubnet  = "in_subnet"
	relInstalled = "installed_on"
	relLocatedIn = "located_in"

	typeVirtualMachine = "microsoft.compute/virtualmachines"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "cloud_azure", Version: version, Language: "go",
		Protocols: []string{"https"}, CredentialTypes: []string{"oauth_client"},
		TargetKinds: []string{"account"}, Emits: []string{typeAccount, typeResource, typeVM, typeSubnet, typeIP, typeOS},
		ContractVersion: contract.Version,
	}
}

// Token obtains a client-credentials access token for the ARM scope.
func Token(ctx context.Context, authority, tenantID, clientID, secret, scope string) (string, error) {
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {clientID}, "client_secret": {secret}, "scope": {strings.TrimSuffix(scope, "/") + "/.default"}}
	endpoint := strings.TrimSuffix(authority, "/") + "/" + tenantID + "/oauth2/v2.0/token"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := (&http.Client{Timeout: tokenTimeout}).Do(req)
	if err != nil {
		return "", restjson.Classify(authority, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode >= http.StatusBadRequest {
		return "", collector.Errorf(contract.ErrAuthFailed, false, "token endpoint returned %d: %s", res.StatusCode, truncate(string(body)))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &tok); err != nil || tok.AccessToken == "" {
		return "", collector.Errorf(contract.ErrParse, false, "token endpoint returned no access_token")
	}
	return tok.AccessToken, nil
}

func truncate(s string) string {
	const max = 200
	if len(s) > max {
		return s[:max]
	}
	return s
}

type Subscription struct {
	ID             string `json:"id"`
	SubscriptionID string `json:"subscriptionId"`
	DisplayName    string `json:"displayName"`
	State          string `json:"state"`
	TenantID       string `json:"tenantId"`
}

type Resource struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Type      string            `json:"type"`
	Location  string            `json:"location"`
	Kind      string            `json:"kind"`
	ManagedBy string            `json:"managedBy"`
	Tags      map[string]string `json:"tags"`
	Sku       *struct {
		Name string `json:"name"`
		Tier string `json:"tier"`
	} `json:"sku"`
}

type VirtualMachine struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Location   string            `json:"location"`
	Zones      []string          `json:"zones"`
	Tags       map[string]string `json:"tags"`
	Properties struct {
		VMID              string `json:"vmId"`
		ProvisioningState string `json:"provisioningState"`
		HardwareProfile   struct {
			VMSize string `json:"vmSize"`
		} `json:"hardwareProfile"`
		StorageProfile struct {
			ImageReference struct {
				Publisher string `json:"publisher"`
				Offer     string `json:"offer"`
				Sku       string `json:"sku"`
				Version   string `json:"version"`
			} `json:"imageReference"`
			OsDisk struct {
				OsType     string `json:"osType"`
				DiskSizeGB int    `json:"diskSizeGB"`
			} `json:"osDisk"`
			DataDisks []struct {
				DiskSizeGB int `json:"diskSizeGB"`
			} `json:"dataDisks"`
		} `json:"storageProfile"`
		OsProfile struct {
			ComputerName string `json:"computerName"`
		} `json:"osProfile"`
		NetworkProfile struct {
			NetworkInterfaces []struct {
				ID string `json:"id"`
			} `json:"networkInterfaces"`
		} `json:"networkProfile"`
	} `json:"properties"`
}

type NetworkInterface struct {
	ID         string `json:"id"`
	Properties struct {
		MacAddress       string `json:"macAddress"`
		IPConfigurations []struct {
			Properties struct {
				PrivateIPAddress string `json:"privateIPAddress"`
				PublicIPAddress  *struct {
					ID string `json:"id"`
				} `json:"publicIPAddress"`
				Subnet *struct {
					ID string `json:"id"`
				} `json:"subnet"`
			} `json:"properties"`
		} `json:"ipConfigurations"`
		VirtualMachine *struct {
			ID string `json:"id"`
		} `json:"virtualMachine"`
	} `json:"properties"`
}

type VirtualNetwork struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Location   string `json:"location"`
	Properties struct {
		AddressSpace struct {
			AddressPrefixes []string `json:"addressPrefixes"`
		} `json:"addressSpace"`
		Subnets []struct {
			ID         string `json:"id"`
			Name       string `json:"name"`
			Properties struct {
				AddressPrefix   string   `json:"addressPrefix"`
				AddressPrefixes []string `json:"addressPrefixes"`
			} `json:"properties"`
		} `json:"subnets"`
	} `json:"properties"`
}

type PublicIP struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Properties struct {
		IPAddress   string `json:"ipAddress"`
		DNSSettings *struct {
			Fqdn string `json:"fqdn"`
		} `json:"dnsSettings"`
	} `json:"properties"`
}

type listPage[T any] struct {
	Value    []T    `json:"value"`
	NextLink string `json:"nextLink"`
}

// Inventory is one subscription's content.
// CreditBalance is what Microsoft.Consumption/credits/balance reports for a credit-based billing account.
type CreditBalance struct {
	Currency       string
	EstimatedValue float64
	AsOf           string
}

type Inventory struct {
	Subscription Subscription
	// Credits is set only when the subscription sits under a billing account that reports a credit balance.
	Credits   *CreditBalance
	Resources []Resource
	VMs       []VirtualMachine
	Nics      []NetworkInterface
	Vnets     []VirtualNetwork
	PublicIPs []PublicIP
	Raw       [][]byte
}

func listAll[T any](ctx context.Context, c *restjson.Client, path string, out *[]T) error {
	next := path
	for next != "" {
		var p listPage[T]
		if err := c.Get(ctx, next, &p); err != nil {
			return err
		}
		*out = append(*out, p.Value...)
		next = ""
		if p.NextLink != "" {
			u, err := url.Parse(p.NextLink)
			if err != nil {
				return collector.Errorf(contract.ErrParse, false, "bad nextLink %q", p.NextLink)
			}
			next = u.RequestURI()
		}
	}
	return nil
}

// Walk reads the subscription through ARM.
func Walk(ctx context.Context, c *restjson.Client, subscriptionID string) (*Inventory, error) {
	inv := &Inventory{}
	base := "/subscriptions/" + subscriptionID
	if err := c.Get(ctx, base+"?api-version="+apiSubscription, &inv.Subscription); err != nil {
		return nil, err
	}
	if err := listAll(ctx, c, base+"/resources?api-version="+apiResources, &inv.Resources); err != nil {
		return nil, err
	}
	inv.Credits = creditBalance(ctx, c, base)
	if err := listAll(ctx, c, base+"/providers/Microsoft.Compute/virtualMachines?api-version="+apiCompute, &inv.VMs); err != nil {
		return nil, err
	}
	if err := listAll(ctx, c, base+"/providers/Microsoft.Network/networkInterfaces?api-version="+apiNetwork, &inv.Nics); err != nil {
		return nil, err
	}
	if err := listAll(ctx, c, base+"/providers/Microsoft.Network/virtualNetworks?api-version="+apiNetwork, &inv.Vnets); err != nil {
		return nil, err
	}
	if err := listAll(ctx, c, base+"/providers/Microsoft.Network/publicIPAddresses?api-version="+apiNetwork, &inv.PublicIPs); err != nil {
		return nil, err
	}
	inv.Raw = c.Raw()
	return inv, nil
}

func lower(s string) string { return strings.ToLower(s) }

// creditBalance walks subscription -> billing account -> credit balance. Any missing step (a pay-as-you-go
// subscription, a credential without billing reader rights) yields nil: the balance is optional cover, never an error.
func creditBalance(ctx context.Context, c *restjson.Client, base string) *CreditBalance {
	var props struct {
		Properties struct {
			BillingAccountID string `json:"billingAccountId"`
		} `json:"properties"`
	}
	if err := c.Get(ctx, base+"/providers/Microsoft.Billing/billingProperties/default?api-version="+apiBillingProperties, &props); err != nil || props.Properties.BillingAccountID == "" {
		return nil
	}
	var balance struct {
		Properties struct {
			BalanceSummary struct {
				EstimatedBalance struct {
					Currency string  `json:"currency"`
					Value    float64 `json:"value"`
				} `json:"estimatedBalance"`
			} `json:"balanceSummary"`
			CreditCurrency string `json:"creditCurrency"`
		} `json:"properties"`
	}
	if err := c.Get(ctx, "/providers/Microsoft.Billing/billingAccounts/"+props.Properties.BillingAccountID+"/providers/Microsoft.Consumption/credits/balance?api-version="+apiCredits, &balance); err != nil {
		return nil
	}
	currency := firstNonEmpty(balance.Properties.BalanceSummary.EstimatedBalance.Currency, balance.Properties.CreditCurrency)
	if currency == "" {
		return nil
	}
	return &CreditBalance{Currency: currency, EstimatedValue: balance.Properties.BalanceSummary.EstimatedBalance.Value, AsOf: time.Now().UTC().Format(time.RFC3339)}
}

// accountAttributes is the cloud_account CI's attribute map; a credit balance becomes the credits* keys the asset
// register reads as subscription cover (packages/contracts subscriptionFromAttributes).
func accountAttributes(inv *Inventory, subID string, typeCounts map[string]int, regionList []string) map[string]any {
	sub := inv.Subscription
	attrs := map[string]any{"provider": provider, "subscriptionId": subID, "tenantId": sub.TenantID, "state": sub.State, "resourceCount": len(inv.Resources), "resourceTypes": typeCounts, "regions": regionList}
	if inv.Credits != nil {
		attrs["creditsRemaining"] = inv.Credits.EstimatedValue
		attrs["creditsUnit"] = inv.Credits.Currency
		attrs["creditsCurrency"] = inv.Credits.Currency
		attrs["creditsAsOf"] = inv.Credits.AsOf
	}
	return attrs
}

// Emit converts the inventory into contract observations.
func Emit(inv *Inventory, at time.Time) collector.Observation {
	obs := collector.Observation{}
	for _, r := range inv.Raw {
		obs.Evidence = append(obs.Evidence, collector.RawEvidence{Kind: evidenceKind, Data: r})
	}
	sub := inv.Subscription
	subID := firstNonEmpty(sub.SubscriptionID, strings.TrimPrefix(sub.ID, "/subscriptions/"))
	accountIdentity := map[string]string{"provider": provider, "accountId": subID}
	account := contract.CiRef{Type: typeAccount, Identity: accountIdentity}
	typeCounts := map[string]int{}
	locations := map[string]bool{}
	for _, r := range inv.Resources {
		typeCounts[lower(r.Type)]++
		locations[r.Location] = true
	}
	regionList := make([]string, 0, len(locations))
	for l := range locations {
		regionList = append(regionList, l)
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeAccount, Identity: accountIdentity, Name: firstNonEmpty(sub.DisplayName, subID),
		Attributes: accountAttributes(inv, subID, typeCounts, regionList),
		Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: sub.ID}}, ObservedAt: at})

	resourceRef := map[string]contract.CiRef{}
	for _, r := range inv.Resources {
		identity := map[string]string{"provider": provider, "resourceId": lower(r.ID)}
		ref := contract.CiRef{Type: typeResource, Identity: identity}
		resourceRef[lower(r.ID)] = ref
		attrs := map[string]any{"provider": provider, "resourceType": r.Type, "location": r.Location, "kind": r.Kind, "managedBy": r.ManagedBy, "tags": r.Tags, "resourceGroup": resourceGroupOf(r.ID), "subscriptionId": subID}
		if r.Sku != nil {
			attrs["skuName"], attrs["skuTier"] = r.Sku.Name, r.Sku.Tier
		}
		tags := []string{}
		for k, v := range r.Tags {
			tags = append(tags, k+"="+v)
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeResource, Identity: identity, Name: r.Name, Attributes: attrs, Tags: tags, ExternalIDs: []contract.ExternalID{{Source: provider, ID: r.ID}}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: account, Attributes: map[string]any{}, ObservedAt: at})
	}

	subnetRef := map[string]contract.CiRef{}
	for _, vnet := range inv.Vnets {
		for _, s := range vnet.Properties.Subnets {
			prefix := firstNonEmpty(s.Properties.AddressPrefix, first(s.Properties.AddressPrefixes))
			if prefix == "" {
				continue
			}
			identity := map[string]string{"cidr": prefix, "vrfRef": lower(vnet.ID)}
			ref := contract.CiRef{Type: typeSubnet, Identity: identity}
			subnetRef[lower(s.ID)] = ref
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeSubnet, Identity: identity, Name: vnet.Name + "/" + s.Name,
				Attributes: map[string]any{"cidr": prefix, "virtualNetwork": vnet.Name, "vnetAddressSpace": vnet.Properties.AddressSpace.AddressPrefixes, "location": vnet.Location, "provider": provider, "resourceId": s.ID},
				Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: s.ID}}, ObservedAt: at})
			if vnetRes, ok := resourceRef[lower(vnet.ID)]; ok {
				obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relMemberOf, From: ref, To: vnetRes, Attributes: map[string]any{}, ObservedAt: at})
			}
		}
	}
	publicIP := map[string]PublicIP{}
	for _, p := range inv.PublicIPs {
		publicIP[lower(p.ID)] = p
	}
	nicByID := map[string]NetworkInterface{}
	for _, n := range inv.Nics {
		nicByID[lower(n.ID)] = n
	}
	for _, vm := range inv.VMs {
		p := vm.Properties
		identity := map[string]string{"instanceUuid": lower(firstNonEmpty(p.VMID, vm.ID)), "hypervisorRef": provider}
		if p.OsProfile.ComputerName != "" {
			identity["fqdn"] = lower(p.OsProfile.ComputerName)
		}
		vmRef := contract.CiRef{Type: typeVM, Identity: identity}
		var diskGB int
		diskGB += p.StorageProfile.OsDisk.DiskSizeGB
		for _, d := range p.StorageProfile.DataDisks {
			diskGB += d.DiskSizeGB
		}
		macs := []string{}
		privateIPs := []string{}
		publicIPs := []string{}
		for _, ref := range p.NetworkProfile.NetworkInterfaces {
			nic, ok := nicByID[lower(ref.ID)]
			if !ok {
				continue
			}
			if nic.Properties.MacAddress != "" {
				macs = append(macs, strings.ToLower(strings.ReplaceAll(nic.Properties.MacAddress, "-", ":")))
			}
			for _, cfg := range nic.Properties.IPConfigurations {
				if addr := cfg.Properties.PrivateIPAddress; addr != "" {
					privateIPs = append(privateIPs, addr)
					vrf := provider
					if cfg.Properties.Subnet != nil {
						vrf = lower(vnetOfSubnet(cfg.Properties.Subnet.ID))
					}
					ipIdentity := map[string]string{"address": addr, "vrfRef": vrf}
					obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: addr, Attributes: map[string]any{"assignedTo": vm.Name, "scope": "private", "provider": provider, "nic": nic.ID}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
					ipRef := contract.CiRef{Type: typeIP, Identity: ipIdentity}
					obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: ipRef, Attributes: map[string]any{}, ObservedAt: at})
					if cfg.Properties.Subnet != nil {
						if sn, ok := subnetRef[lower(cfg.Properties.Subnet.ID)]; ok {
							obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInSubnet, From: ipRef, To: sn, Attributes: map[string]any{}, ObservedAt: at})
						}
					}
				}
				if cfg.Properties.PublicIPAddress != nil {
					if pip, ok := publicIP[lower(cfg.Properties.PublicIPAddress.ID)]; ok && pip.Properties.IPAddress != "" {
						publicIPs = append(publicIPs, pip.Properties.IPAddress)
						ipIdentity := map[string]string{"address": pip.Properties.IPAddress, "vrfRef": vrfInternet}
						fqdn := ""
						if pip.Properties.DNSSettings != nil {
							fqdn = pip.Properties.DNSSettings.Fqdn
						}
						obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: pip.Properties.IPAddress, Attributes: map[string]any{"assignedTo": vm.Name, "scope": "public", "provider": provider, "fqdn": fqdn, "internetExposed": true}, Tags: []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: pip.ID}}, ObservedAt: at})
						obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: vmRef, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{"scope": "public"}, ObservedAt: at})
					}
				}
			}
		}
		img := p.StorageProfile.ImageReference
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeVM, Identity: identity, Name: vm.Name,
			Attributes: map[string]any{"platform": provider, "vmSize": p.HardwareProfile.VMSize, "location": vm.Location, "zones": vm.Zones, "osType": p.StorageProfile.OsDisk.OsType, "image": strings.Trim(img.Publisher+":"+img.Offer+":"+img.Sku+":"+img.Version, ":"), "diskGb": diskGB, "diskCount": 1 + len(p.StorageProfile.DataDisks), "provisioningState": p.ProvisioningState, "macAddresses": macs, "privateIps": privateIPs, "publicIps": publicIPs, "internetExposed": len(publicIPs) > 0, "tags": vm.Tags, "resourceGroup": resourceGroupOf(vm.ID), "resourceId": vm.ID},
			Tags:       []string{}, ExternalIDs: []contract.ExternalID{{Source: provider, ID: vm.ID}}, ObservedAt: at})
		if res, ok := resourceRef[lower(vm.ID)]; ok {
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relHostedOn, From: vmRef, To: res, Attributes: map[string]any{}, ObservedAt: at})
		}
		if img.Offer != "" {
			osIdentity := map[string]string{"hostRef": identity["instanceUuid"], "family": lower(firstNonEmpty(p.StorageProfile.OsDisk.OsType, "unknown")), "version": firstNonEmpty(img.Offer+" "+img.Sku, p.StorageProfile.OsDisk.OsType)}
			obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: osIdentity["version"], Attributes: map[string]any{"family": osIdentity["family"], "publisher": img.Publisher, "offer": img.Offer, "sku": img.Sku, "imageVersion": img.Version, "source": "azure-image-reference"}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
			obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalled, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: vmRef, Attributes: map[string]any{}, ObservedAt: at})
		}
	}
	return obs
}

// resourceGroupOf extracts the resource group from an ARM id.
func resourceGroupOf(id string) string {
	parts := strings.Split(id, "/")
	for i := 0; i+1 < len(parts); i++ {
		if strings.EqualFold(parts[i], "resourceGroups") {
			return parts[i+1]
		}
	}
	return ""
}

// vnetOfSubnet turns ".../virtualNetworks/<vnet>/subnets/<name>" into the vnet id.
func vnetOfSubnet(subnetID string) string {
	if i := strings.Index(strings.ToLower(subnetID), "/subnets/"); i >= 0 {
		return subnetID[:i]
	}
	return subnetID
}

func first(list []string) string {
	if len(list) == 0 {
		return ""
	}
	return list[0]
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
	if cred == nil || cred.Type != "oauth_client" || cred.Fields[credClientID] == "" || cred.Fields[credSecret] == "" || cred.Fields[credTenant] == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrAuthFailed, false, "azure requires an oauth_client credential with clientId, clientSecret and tenantId")
	}
	authority := restjson.StringOption(options, optionAuthority)
	arm := restjson.StringOption(options, optionArm)
	if authority == "" || arm == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrInternal, false, "azure job must name authorityUrl and resourceManagerUrl (cloud-specific endpoints)")
	}
	token, err := Token(ctx, authority, cred.Fields[credTenant], cred.Fields[credClientID], cred.Fields[credSecret], arm)
	if err != nil {
		return collector.Observation{}, err
	}
	c, err := restjson.New(arm, defaultPort, restjson.Auth{Bearer: token}, restjson.Options{VerifyTLS: true})
	if err != nil {
		return collector.Observation{}, err
	}
	inv, err := Walk(ctx, c, target.Value)
	if err != nil {
		return collector.Observation{}, restjson.Classify(arm, err)
	}
	return Emit(inv, time.Now().UTC()), nil
}
