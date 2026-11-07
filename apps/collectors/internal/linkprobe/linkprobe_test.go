// T-477 REQ-BSM-007 (ADR-025) — link_probe against real local listeners: a listening far end is reachable with a
// latency and no loss; a closed port is unreachable with 100% loss and no latency sample; a far end that refuses
// every other connection shows half the attempts lost; the target names its port or takes the default.
package linkprobe

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/openmap/openmap/apps/collectors/internal/contract"
)

func listener(t *testing.T) (string, func()) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	return l.Addr().String(), func() { _ = l.Close() }
}

func samples(t *testing.T, obs []contract.MetricSample) map[string]float64 {
	t.Helper()
	out := map[string]float64{}
	for _, s := range obs {
		if s.Ci.ID != "link-1" || s.Ci.Type != "site_link" {
			t.Fatalf("sample on %+v", s.Ci)
		}
		out[s.Metric] = s.Value
	}
	return out
}

func TestReachableFarEnd(t *testing.T) {
	addr, stop := listener(t)
	defer stop()
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: addr, Label: "link-1"}, nil, map[string]any{"attempts": float64(3), "gapMs": float64(1)})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs.Cis) != 0 {
		t.Fatalf("a probe emits no CI, got %d", len(obs.Cis))
	}
	got := samples(t, obs.Samples)
	if got[MetricReachable] != 1 || got[MetricLoss] != 0 {
		t.Fatalf("reachable link: %+v", got)
	}
	if _, ok := got[MetricLatency]; !ok {
		t.Fatalf("no latency sample: %+v", got)
	}
}

func TestUnreachableFarEnd(t *testing.T) {
	addr, stop := listener(t)
	stop() // nothing listens any more
	obs, err := Collector{}.Collect(context.Background(), contract.Target{Kind: "host", Value: addr, Label: "link-1"}, nil, map[string]any{"attempts": float64(2), "gapMs": float64(1), "timeoutMs": float64(200)})
	if err != nil {
		t.Fatal(err)
	}
	got := samples(t, obs.Samples)
	if got[MetricReachable] != 0 || got[MetricLoss] != 100 {
		t.Fatalf("unreachable link: %+v", got)
	}
	if _, ok := got[MetricLatency]; ok {
		t.Fatal("latency sampled for an unreachable link")
	}
}

func TestPartialLossAndMedian(t *testing.T) {
	n := 0
	c := Collector{Dial: func(ctx context.Context, address string) (net.Conn, error) {
		n++
		if n%2 == 0 {
			return nil, errors.New("refused")
		}
		a, b := net.Pipe()
		_ = b.Close()
		return a, nil
	}}
	m := c.Probe(context.Background(), "far:443", 4, time.Second, time.Millisecond)
	if m.Connected != 2 || m.LossPercent() != 50 || !m.Reachable() {
		t.Fatalf("measurement %+v loss %v", m, m.LossPercent())
	}
	if median([]float64{5, 1, 3}) != 3 || median([]float64{4, 2}) != 3 || median(nil) != 0 {
		t.Fatal("median")
	}
}

func TestAddressAndLabel(t *testing.T) {
	if Address("10.0.0.1", 443) != "10.0.0.1:443" || Address("10.0.0.1:8443", 443) != "10.0.0.1:8443" || Address("gw.jed", 22) != "gw.jed:22" {
		t.Fatal("address")
	}
	if _, err := (Collector{}).Collect(context.Background(), contract.Target{Kind: "host", Value: "10.0.0.1"}, nil, nil); err == nil {
		t.Fatal("a target without the link CI id must be refused")
	}
}
