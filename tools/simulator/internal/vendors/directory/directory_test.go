// T-413 REQ-QA-005 REQ-DISC-023 — the real ldap collector binds to a simulated Active Directory domain controller
// over LDAPS (base DN from the root DSE) and over StartTLS (LDAP signing enforced), verifying the certificate
// against the simulated-mode CA, pages through 1200 users and 1000+ computers with the paged results control and
// emits every user, service account (by SPN and by OU) and Windows computer.
package directory

import (
	"testing"

	"github.com/openmap/openmap/tools/simulator/internal/simtest"
)

func TestSimulatedActiveDirectory(t *testing.T) {
	simtest.Run(t, Vendor{})
}
