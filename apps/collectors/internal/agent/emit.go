// REQ-DISC-004 — turns the host inventory into collector-contract observations: the host with its DMI identity,
// the operating system installed on it, its addresses, every listening service as a dependency-map endpoint, and
// installed software as software plus software_instance pairs, all tied together with the standard relationships.
package agent

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const evidenceKind = "agent_inventory"

// Emit converts the inventory into an observation; the raw inventory is attached as evidence.
func Emit(inv *Inventory) collector.Observation {
	at := inv.CollectedAt
	if at.IsZero() {
		at = time.Now().UTC()
	}
	raw, _ := json.Marshal(inv)
	obs := collector.Observation{Evidence: []collector.RawEvidence{{Kind: evidenceKind, Data: raw}}}
	hostRef := strings.ToLower(firstNonEmpty(inv.FQDN, inv.Hostname))
	identity := map[string]string{"fqdn": hostRef}
	if inv.Serial != "" {
		identity["serialNumber"] = inv.Serial
	}
	if inv.SystemUUID != "" {
		identity["systemUuid"] = inv.SystemUUID
	}
	if inv.PrimaryMAC != "" {
		identity["primaryMac"] = inv.PrimaryMAC
	}
	host := contract.CiRef{Type: typeHost, Identity: identity}
	addresses := make([]string, 0, len(inv.Addresses))
	for _, a := range inv.Addresses {
		addresses = append(addresses, a.Address)
	}
	obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeHost, Identity: identity, Name: inv.Hostname, Attributes: map[string]any{
		"hostname": inv.Hostname, "fqdn": hostRef, "manufacturer": inv.Manufacturer, "model": inv.Model, "serialNumber": inv.Serial, "systemUuid": inv.SystemUUID,
		"architecture": inv.Architecture, "cpus": inv.CPUs, "memoryMiB": inv.MemoryMiB, "uptimeSeconds": inv.UptimeSec, "addresses": addresses, "listenerCount": len(inv.Listeners), "packageCount": len(inv.Packages),
		"agentVersion": Version, "source": source, "health": "healthy",
	}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})

	if inv.OSName != "" {
		osIdentity := map[string]string{"hostRef": hostRef, "family": inv.OSFamily, "version": strings.TrimSpace(inv.OSName + " " + inv.OSVersion)}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeOS, Identity: osIdentity, Name: osIdentity["version"], Attributes: map[string]any{"family": inv.OSFamily, "name": inv.OSName, "version": inv.OSVersion, "kernel": inv.Kernel, "architecture": inv.Architecture, "source": source}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalled, From: contract.CiRef{Type: typeOS, Identity: osIdentity}, To: host, Attributes: map[string]any{}, ObservedAt: at})
	}
	for _, a := range inv.Addresses {
		ipIdentity := map[string]string{"address": a.Address, "vrfRef": defaultVrf}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeIP, Identity: ipIdentity, Name: a.Address, Attributes: map[string]any{"interface": a.Interface, "mac": a.MAC, "prefixLength": a.Prefix, "assignedTo": hostRef, "source": source}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relUsesIP, From: host, To: contract.CiRef{Type: typeIP, Identity: ipIdentity}, Attributes: map[string]any{"interface": a.Interface}, ObservedAt: at})
	}
	seenPort := map[int]bool{}
	for _, l := range inv.Listeners {
		if l.Port == 0 || seenPort[l.Port] {
			continue
		}
		seenPort[l.Port] = true
		lIdentity := map[string]string{"hostRef": hostRef, "protocol": protocolTCP, "port": strconv.Itoa(l.Port)}
		scope := "all"
		if l.Address != "" && l.Address != "0.0.0.0" && l.Address != "::" {
			scope = l.Address
		}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeListener, Identity: lIdentity, Name: firstNonEmpty(l.Process, "tcp") + " tcp/" + strconv.Itoa(l.Port), Attributes: map[string]any{"protocol": protocolTCP, "port": l.Port, "bindAddress": scope, "process": l.Process, "pid": l.PID, "source": source}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relRunsOn, From: contract.CiRef{Type: typeListener, Identity: lIdentity}, To: host, Attributes: map[string]any{"process": l.Process}, ObservedAt: at})
	}
	seenPkg := map[string]bool{}
	for _, p := range inv.Packages {
		if p.Name == "" {
			continue
		}
		vendor := firstNonEmpty(p.Vendor, "unknown")
		key := vendor + "|" + p.Name + "|" + p.Version
		if seenPkg[key] {
			continue
		}
		seenPkg[key] = true
		swIdentity := map[string]string{"vendor": vendor, "name": p.Name, "version": p.Version}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeSoftware, Identity: swIdentity, Name: p.Name + " " + p.Version, Attributes: map[string]any{"vendor": vendor, "name": p.Name, "version": p.Version, "source": source}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		instIdentity := map[string]string{"hostRef": hostRef, "softwareRef": vendor + ":" + p.Name + ":" + p.Version, "installPath": firstNonEmpty(p.InstallPath, "system")}
		obs.Cis = append(obs.Cis, contract.ObservedCi{Type: typeInstance, Identity: instIdentity, Name: p.Name + " on " + inv.Hostname, Attributes: map[string]any{"software": p.Name, "version": p.Version, "vendor": vendor, "installPath": p.InstallPath, "source": source}, Tags: []string{}, ExternalIDs: []contract.ExternalID{}, ObservedAt: at})
		obs.Relationships = append(obs.Relationships, contract.ObservedRelationship{Type: relInstalled, From: contract.CiRef{Type: typeInstance, Identity: instIdentity}, To: host, Attributes: map[string]any{}, ObservedAt: at})
	}
	return obs
}
