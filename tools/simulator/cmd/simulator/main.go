// REQ-QA-005 — simulated mode CLI.
//
//	simulator list                                   vendors and the tracker rows each exercises
//	simulator verify [--estate DIR] [--only a,b] [--out FILE] [--bin DIR]
//	                                                 run every real collector against its simulator, compare with the estate
//	simulator serve  [--estate DIR] [--only a,b] --plan FILE
//	                                                 keep the simulators up and write the job plan (targets, options,
//	                                                 simulated credentials) for a Discovery Node run
//
// The estate defaults to packages/testing/fixtures/synth-small (generate it with tools/synth-estate).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"

	"github.com/openmap/openmap/tools/simulator/internal/estate"
	"github.com/openmap/openmap/tools/simulator/internal/sim"
	"github.com/openmap/openmap/tools/simulator/internal/vendors"
	"github.com/openmap/openmap/tools/simulator/internal/verify"
)

const (
	exitUsage = 2
	fileMode  = 0o600
	dirMode   = 0o700
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	var err error
	switch os.Args[1] {
	case "list":
		for _, v := range vendors.All() {
			fmt.Printf("%-26s %-20s %s\n", v.ID(), v.Collector(), strings.Join(v.Requirements(), ","))
		}
	case "verify":
		err = cmdVerify(ctx, os.Args[2:])
	case "serve":
		err = cmdServe(ctx, os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "simulator:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: simulator list | verify [--estate DIR] [--only a,b] [--out FILE] [--bin DIR] | serve [--estate DIR] [--only a,b] --plan FILE")
	os.Exit(exitUsage)
}

type common struct {
	repo   string
	estate *estate.Estate
	only   map[string]bool
}

func parseCommon(fs *flag.FlagSet, args []string) (*common, error) {
	repo, err := verify.RepoRoot()
	if err != nil {
		return nil, err
	}
	dir := fs.String("estate", filepath.Join(repo, "packages", "testing", "fixtures", "synth-small"), "synthetic estate directory")
	only := fs.String("only", "", "comma-separated simulator ids")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	e, err := estate.Load(*dir)
	if err != nil {
		return nil, err
	}
	c := &common{repo: repo, estate: e, only: map[string]bool{}}
	for _, id := range strings.Split(*only, ",") {
		if id = strings.TrimSpace(id); id != "" {
			c.only[id] = true
		}
	}
	return c, nil
}

func (c *common) selected() []sim.Vendor {
	var out []sim.Vendor
	for _, v := range vendors.All() {
		if len(c.only) == 0 || c.only[v.ID()] {
			out = append(out, v)
		}
	}
	return out
}

func cmdVerify(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	out := fs.String("out", "", "write the JSON report here")
	bin := fs.String("bin", "", "directory for built collector binaries (default: a temporary directory)")
	c, err := parseCommon(fs, args)
	if err != nil {
		return err
	}
	binDir := *bin
	if binDir == "" {
		tmp, err := os.MkdirTemp("", "openmap-sim-bin-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(tmp)
		binDir = tmp
	} else if err := os.MkdirAll(binDir, dirMode); err != nil {
		return err
	}
	env, err := sim.NewEnv()
	if err != nil {
		return err
	}
	bins := verify.NewBinaries(c.repo, binDir)
	var reports []verify.Report
	failed := 0
	for _, v := range c.selected() {
		reps, err := verify.RunVendor(ctx, c.estate, env, bins, v)
		if err != nil {
			reps = []verify.Report{{Simulator: v.ID(), Collector: v.Collector(), Requirements: v.Requirements(), Provenance: sim.Provenance, Status: "error", Errors: []string{err.Error()}}}
		}
		for _, r := range reps {
			if !r.Pass {
				failed++
			}
		}
		reports = append(reports, reps...)
	}
	fmt.Print(verify.Summary(reports))
	if *out != "" {
		body, err := json.MarshalIndent(map[string]any{"provenance": sim.Provenance, "estate": c.estate.Dir, "reports": reports}, "", "  ")
		if err != nil {
			return err
		}
		if err := os.WriteFile(*out, body, fileMode); err != nil {
			return err
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d simulated runs failed", failed, len(reports))
	}
	return nil
}

// planEntry is one job a Discovery Node can run against a live simulator.
type planEntry struct {
	Simulator      string          `json:"simulator"`
	Run            string          `json:"run"`
	Collector      string          `json:"collector"`
	Requirements   []string        `json:"requirements"`
	Targets        []sim.Target    `json:"targets"`
	Options        map[string]any  `json:"options"`
	CredentialType string          `json:"credentialType"`
	Credential     *sim.Credential `json:"credential"`
	Provenance     string          `json:"provenance"`
}

func cmdServe(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	planPath := fs.String("plan", "", "write the job plan here (required)")
	c, err := parseCommon(fs, args)
	if err != nil {
		return err
	}
	if *planPath == "" {
		return fmt.Errorf("--plan is required")
	}
	env, err := sim.NewEnv()
	if err != nil {
		return err
	}
	var plan []planEntry
	for _, v := range c.selected() {
		ep, err := v.Start(ctx, c.estate, env)
		if err != nil {
			return fmt.Errorf("start %s: %w", v.ID(), err)
		}
		defer func() { _ = ep.Close() }()
		for _, r := range v.Runs(c.estate, ep, env) {
			plan = append(plan, planEntry{Simulator: v.ID(), Run: r.Name, Collector: v.Collector(), Requirements: v.Requirements(),
				Targets: r.Targets, Options: r.Options, CredentialType: r.CredentialType, Credential: r.Credential, Provenance: sim.Provenance})
		}
		if d, ok := v.(sim.Concurrent); ok {
			for _, r := range v.Runs(c.estate, ep, env) {
				go func() { _ = d.Drive(ctx, c.estate, ep, r, env) }()
			}
		}
	}
	body, err := json.MarshalIndent(plan, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(*planPath, body, fileMode); err != nil {
		return err
	}
	fmt.Printf("simulator: %d jobs planned in %s; serving until interrupted\n", len(plan), *planPath)
	<-ctx.Done()
	return nil
}
