// REQ-BSM-007 (ADR-025) — link_probe: measures one inter-site link from its A end. The target value is the far end's
// probe endpoint (host or host:port) and its label is the site_link CI id. The probe opens a few TCP connections:
// reachability is "any attempt connected", latency the median connect round trip of those that did, loss the share
// that failed. The figures are samples on the link CI; no CI is emitted, so a probe never re-asserts the link.
package linkprobe

import (
	"context"
	"net"
	"sort"
	"strconv"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/collector"
	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

const (
	collectorID = "link_probe"
	version     = "0.1.0"

	optionAttempts  = "attempts"
	optionTimeoutMs = "timeoutMs"
	optionPort      = "port"
	optionGapMs     = "gapMs"

	// Defaults mirror LINK_PROBE in @openmap/constants; the scheduler sends its own values as options.
	defaultAttempts  = 5
	defaultTimeoutMs = 2000
	defaultPort      = 443
	defaultGapMs     = 100

	MetricReachable = "net.link.reachable"
	MetricLatency   = "net.link.latency_ms"
	MetricLoss      = "net.link.loss_percent"

	unitBool    = "bool"
	unitMs      = "ms"
	unitPercent = "%"
	percent     = 100
	msPerSecond = 1000
)

type Collector struct {
	// Dial is replaceable for tests; the zero value uses a net.Dialer.
	Dial func(ctx context.Context, address string) (net.Conn, error)
}

func (Collector) Manifest() contract.Manifest {
	return contract.Manifest{
		ID: collectorID, Family: "link_probe", Version: version, Language: "go",
		Protocols: []string{"tcp"}, CredentialTypes: []string{"none"},
		TargetKinds: []string{"host"}, Emits: []string{"site_link"},
		ContractVersion: contract.Version,
	}
}

// Measurement is one probe of a link.
type Measurement struct {
	Attempts  int
	Connected int
	// LatencyMs is the median connect round trip of the attempts that connected; zero when none did.
	LatencyMs float64
}

func (m Measurement) Reachable() bool { return m.Connected > 0 }

func (m Measurement) LossPercent() float64 {
	if m.Attempts == 0 {
		return percent
	}
	return float64(m.Attempts-m.Connected) * percent / float64(m.Attempts)
}

// Address is the dial address: the target as given when it names a port, else the target on the default port.
func Address(target string, port int) string {
	if _, _, err := net.SplitHostPort(target); err == nil {
		return target
	}
	return net.JoinHostPort(target, strconv.Itoa(port))
}

// Probe connects `attempts` times, `gap` apart, each bounded by `timeout`, and measures the round trips.
func (c Collector) Probe(ctx context.Context, address string, attempts int, timeout, gap time.Duration) Measurement {
	dial := c.Dial
	if dial == nil {
		dial = func(ctx context.Context, address string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", address)
		}
	}
	m := Measurement{Attempts: attempts}
	var rtts []float64
	for i := 0; i < attempts; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return m
			case <-time.After(gap):
			}
		}
		attemptCtx, cancel := context.WithTimeout(ctx, timeout)
		start := time.Now()
		conn, err := dial(attemptCtx, address)
		elapsed := time.Since(start)
		cancel()
		if err != nil {
			continue
		}
		_ = conn.Close()
		m.Connected++
		rtts = append(rtts, float64(elapsed.Microseconds())/msPerSecond)
	}
	m.LatencyMs = median(rtts)
	return m
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	sort.Float64s(xs)
	mid := len(xs) / 2
	if len(xs)%2 == 1 {
		return xs[mid]
	}
	return (xs[mid-1] + xs[mid]) / 2
}

// Samples turns a measurement into the link CI's samples: latency only when the far end answered.
func Samples(linkCiID string, m Measurement, at time.Time) []contract.MetricSample {
	ref := contract.CiRef{ID: linkCiID, Type: "site_link"}
	reachable := 0.0
	if m.Reachable() {
		reachable = 1
	}
	out := []contract.MetricSample{
		{Ci: ref, Metric: MetricReachable, Ts: at, Value: reachable, Unit: unitBool, Labels: map[string]string{}},
		{Ci: ref, Metric: MetricLoss, Ts: at, Value: m.LossPercent(), Unit: unitPercent, Labels: map[string]string{}},
	}
	if m.Reachable() {
		out = append(out, contract.MetricSample{Ci: ref, Metric: MetricLatency, Ts: at, Value: m.LatencyMs, Unit: unitMs, Labels: map[string]string{}})
	}
	return out
}

func (c Collector) Collect(ctx context.Context, target contract.Target, _ *contract.Credential, options map[string]any) (collector.Observation, error) {
	if target.Label == "" {
		return collector.Observation{}, collector.Errorf(contract.ErrParse, false, "link probe target %s names no link CI (label)", target.Value)
	}
	address := Address(target.Value, intOption(options, optionPort, defaultPort))
	m := c.Probe(ctx, address,
		intOption(options, optionAttempts, defaultAttempts),
		time.Duration(intOption(options, optionTimeoutMs, defaultTimeoutMs))*time.Millisecond,
		time.Duration(intOption(options, optionGapMs, defaultGapMs))*time.Millisecond)
	// An unreachable far end is a measurement, not an error: the samples say so and the link goes down.
	return collector.Observation{Samples: Samples(target.Label, m, time.Now().UTC())}, nil
}

func intOption(options map[string]any, key string, fallback int) int {
	switch n := options[key].(type) {
	case float64:
		if n > 0 {
			return int(n)
		}
	case int:
		if n > 0 {
			return n
		}
	}
	return fallback
}
