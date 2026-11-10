// REQ-DISC-003 — agentless SSH collector for Linux and Unix hosts: one session, one script, host
// key policy from the job (pinned fingerprint, trust-on-first-use recorded in the result, or strict).
package sshlinux

import (
	"context"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
	"github.com/openmap/openmap/apps/collectors/internal/sshexec"
)

const (
	collectorID = "ssh_agentless"
	version     = "0.1.0"
	attrHostKey = "sshHostKeySha256"
)

type Collector struct{}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "ssh_agentless", Version: version, Language: "go",
		Protocols: []string{"ssh"}, CredentialTypes: []string{"password", "ssh_key"},
		TargetKinds: []string{"host"}, Emits: []string{typeHost, typeVM, typeOS, typeInterface, typeIP, typeListener, typeSoftware, typeInstall, typeFwRule, typeFwObject},
		ContractVersion: contract.Version,
	}
}

func (Collector) Collect(ctx context.Context, target contract.Target, cred *contract.Credential, options map[string]any) (collector.Observation, error) {
	out, err := sshexec.Run(ctx, target, cred, options, Script())
	if err != nil {
		return collector.Observation{}, err
	}
	at := time.Now().UTC()
	facts := Assemble(Split(string(out.Stdout)))
	obs := Emit(facts, target, out.Stdout, at)
	if len(obs.Cis) > 0 && out.HostKey != "" {
		obs.Cis[0].Attributes[attrHostKey] = out.HostKey
	}
	return obs, nil
}
