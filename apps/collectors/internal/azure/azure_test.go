// T-044 REQ-DISC-010 — serves a token endpoint and ARM-shaped subscription, resource, VM, NIC,
// virtual network and public IP lists (with nextLink paging) from httptest and checks the emitted
// account, resources, VM, subnet and address CIs.
package azure

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/restjson"
)

const sub = "11111111-2222-3333-4444-555555555555"

func arm(t *testing.T) *httptest.Server {
	t.Helper()
	rg := "/subscriptions/" + sub + "/resourceGroups/rg-prod"
	vmID := rg + "/providers/Microsoft.Compute/virtualMachines/app-01"
	nicID := rg + "/providers/Microsoft.Network/networkInterfaces/app-01-nic"
	vnetID := rg + "/providers/Microsoft.Network/virtualNetworks/vnet-prod"
	subnetID := vnetID + "/subnets/app"
	pipID := rg + "/providers/Microsoft.Network/publicIPAddresses/app-01-pip"
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/tenant-1/oauth2/v2.0/token" {
			_ = r.ParseForm()
			if r.Form.Get("client_secret") != "s3cret" || !strings.HasSuffix(r.Form.Get("scope"), "/.default") {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "tok", "expires_in": 3600})
			return
		}
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		p := r.URL.Path
		switch {
		case p == "/subscriptions/"+sub:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "/subscriptions/" + sub, "subscriptionId": sub, "displayName": "Production", "state": "Enabled", "tenantId": "tenant-1"})
		case strings.HasSuffix(p, "/resources") && r.URL.Query().Get("$skiptoken") == "":
			_ = json.NewEncoder(w).Encode(map[string]any{"value": []any{
				map[string]any{"id": vmID, "name": "app-01", "type": "Microsoft.Compute/virtualMachines", "location": "uaenorth", "tags": map[string]string{"env": "prod"}},
				map[string]any{"id": vnetID, "name": "vnet-prod", "type": "Microsoft.Network/virtualNetworks", "location": "uaenorth"},
			}, "nextLink": srv.URL + p + "?api-version=x&$skiptoken=page2"})
		case strings.HasSuffix(p, "/resources"):
			_ = json.NewEncoder(w).Encode(map[string]any{"value": []any{map[string]any{"id": rg + "/providers/Microsoft.Sql/servers/sql-prod", "name": "sql-prod", "type": "Microsoft.Sql/servers", "location": "uaenorth", "sku": map[string]string{"name": "GP_Gen5", "tier": "GeneralPurpose"}}}})
		case strings.HasSuffix(p, "/virtualMachines"):
			_ = json.NewEncoder(w).Encode(map[string]any{"value": []any{map[string]any{"id": vmID, "name": "app-01", "location": "uaenorth", "zones": []string{"1"}, "properties": map[string]any{
				"vmId": "9F0E1D2C-0000-4000-8000-000000000001", "provisioningState": "Succeeded", "hardwareProfile": map[string]string{"vmSize": "Standard_D4s_v5"},
				"storageProfile": map[string]any{"imageReference": map[string]string{"publisher": "Canonical", "offer": "ubuntu-24_04-lts", "sku": "server", "version": "latest"}, "osDisk": map[string]any{"osType": "Linux", "diskSizeGB": 64}, "dataDisks": []any{map[string]any{"diskSizeGB": 256}}},
				"osProfile":      map[string]string{"computerName": "app-01"}, "networkProfile": map[string]any{"networkInterfaces": []any{map[string]string{"id": nicID}}}}}}})
		case strings.HasSuffix(p, "/networkInterfaces"):
			_ = json.NewEncoder(w).Encode(map[string]any{"value": []any{map[string]any{"id": nicID, "properties": map[string]any{"macAddress": "60-45-BD-AA-BB-01", "virtualMachine": map[string]string{"id": vmID},
				"ipConfigurations": []any{map[string]any{"properties": map[string]any{"privateIPAddress": "10.60.1.4", "subnet": map[string]string{"id": subnetID}, "publicIPAddress": map[string]string{"id": pipID}}}}}}}})
		case strings.HasSuffix(p, "/virtualNetworks"):
			_ = json.NewEncoder(w).Encode(map[string]any{"value": []any{map[string]any{"id": vnetID, "name": "vnet-prod", "location": "uaenorth", "properties": map[string]any{"addressSpace": map[string]any{"addressPrefixes": []string{"10.60.0.0/16"}}, "subnets": []any{map[string]any{"id": subnetID, "name": "app", "properties": map[string]string{"addressPrefix": "10.60.1.0/24"}}}}}}})
		case strings.HasSuffix(p, "/publicIPAddresses"):
			_ = json.NewEncoder(w).Encode(map[string]any{"value": []any{map[string]any{"id": pipID, "name": "app-01-pip", "properties": map[string]any{"ipAddress": "20.233.10.5", "dnsSettings": map[string]string{"fqdn": "app-01.uaenorth.cloudapp.azure.com"}}}}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	return srv
}

func count(cis []contract.ObservedCi, typ string) int {
	n := 0
	for _, c := range cis {
		if c.Type == typ {
			n++
		}
	}
	return n
}

func TestTokenWalkEmit(t *testing.T) {
	srv := arm(t)
	defer srv.Close()
	http.DefaultTransport = srv.Client().Transport // Token uses a plain client; trust the test certificate
	token, err := Token(context.Background(), srv.URL, "tenant-1", "client", "s3cret", srv.URL)
	if err != nil || token != "tok" {
		t.Fatalf("token failed: %v %q", err, token)
	}
	c, _ := restjson.New(srv.URL, defaultPort, restjson.Auth{Bearer: token}, restjson.Options{})
	inv, err := Walk(context.Background(), c, sub)
	if err != nil {
		t.Fatal(err)
	}
	if len(inv.Resources) != 3 || len(inv.VMs) != 1 || len(inv.Nics) != 1 || len(inv.Vnets) != 1 || len(inv.PublicIPs) != 1 {
		t.Fatalf("walk counts wrong: %+v", inv)
	}
	obs := Emit(inv, time.Now())
	if count(obs.Cis, typeAccount) != 1 || count(obs.Cis, typeResource) != 3 || count(obs.Cis, typeVM) != 1 || count(obs.Cis, typeSubnet) != 1 || count(obs.Cis, typeIP) != 2 || count(obs.Cis, typeOS) != 1 {
		t.Fatalf("unexpected CI mix: acct=%d res=%d vm=%d subnet=%d ip=%d os=%d", count(obs.Cis, typeAccount), count(obs.Cis, typeResource), count(obs.Cis, typeVM), count(obs.Cis, typeSubnet), count(obs.Cis, typeIP), count(obs.Cis, typeOS))
	}
	for _, ci := range obs.Cis {
		switch ci.Type {
		case typeVM:
			if ci.Identity["instanceUuid"] != "9f0e1d2c-0000-4000-8000-000000000001" || ci.Identity["fqdn"] != "app-01" || ci.Attributes["diskGb"] != 320 || ci.Attributes["internetExposed"] != true {
				t.Fatalf("vm wrong: %+v", ci)
			}
		case typeAccount:
			if ci.Identity["accountId"] != sub || ci.Attributes["resourceCount"] != 3 {
				t.Fatalf("account wrong: %+v", ci)
			}
		case typeResource:
			if ci.Name == "sql-prod" && ci.Attributes["skuTier"] != "GeneralPurpose" {
				t.Fatalf("sku missing: %+v", ci.Attributes)
			}
		}
	}
	rels := map[string]int{}
	for _, r := range obs.Relationships {
		rels[r.Type]++
	}
	if rels[relMemberOf] != 4 || rels[relHostedOn] != 1 || rels[relUsesIP] != 2 || rels[relInSubnet] != 1 || rels[relInstalled] != 1 {
		t.Fatalf("relationship mix wrong: %+v", rels)
	}
}

func TestResourceGroupParsing(t *testing.T) {
	if resourceGroupOf("/subscriptions/x/resourceGroups/RG-A/providers/Microsoft.Compute/virtualMachines/v") != "RG-A" {
		t.Fatal("resource group parse failed")
	}
	if vnetOfSubnet("/a/virtualNetworks/v/subnets/s") != "/a/virtualNetworks/v" {
		t.Fatal("vnet parse failed")
	}
}
