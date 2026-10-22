// T-042 REQ-DISC-020 — test helpers.
package portscan

import "github.com/openmap/openmap/apps/collectors/internal/contract"

func contractTarget(value string) contract.Target {
	return contract.Target{Kind: "host", Value: value}
}
