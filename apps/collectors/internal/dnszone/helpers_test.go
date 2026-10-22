// T-043 REQ-DISC-021 — test helpers.
package dnszone

import (
	"io"
	"strings"
)

func stringsReader(s string) io.Reader {
	return strings.NewReader(s)
}
