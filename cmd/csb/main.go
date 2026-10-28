// Command csb serves the Claude Code session browser and its helper commands.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/bdrennan/claude-session-browser/internal/classify"
	"github.com/bdrennan/claude-session-browser/internal/config"
	"github.com/bdrennan/claude-session-browser/internal/enrich"
	"github.com/bdrennan/claude-session-browser/internal/export"
	"github.com/bdrennan/claude-session-browser/internal/server"
	"github.com/bdrennan/claude-session-browser/internal/sessions"
	"github.com/bdrennan/claude-session-browser/web"
)

const usage = `usage: csb [-config config.yml] <command> [flags]

commands:
  serve            run the web UI (default)
  list             print indexed sessions
  dump <id>        print one session's parsed detail as JSON
  export           copy your transcripts into a shared team folder
  classify         suggest purpose tags for unclassified sessions
  pricing check    compare pricing.yml with the live pricing page
`

func main() {
	cfgPath := flag.String("config", "config.yml", "path to config file")
	flag.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	flag.Parse()
	args := flag.Args()
	cmd := "serve"
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatal(err)
	}
	// export does not need the index.
	if cmd == "export" {
		runExport(args)
		return
	}

	ix, err := sessions.NewIndex(cfg)
	if err != nil {
		log.Fatal(err)
	}
	if err := ix.Refresh(0); err != nil {
		log.Fatal(err)
	}
	openStore := func() *enrich.Store {
		es, err := enrich.Open(filepath.Join(cfg.DataDir, "enrichment.yml"), cfg.DefaultTags)
		if err != nil {
			log.Fatal(err)
		}
		return es
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	switch cmd {
	case "serve":
		es := openStore()
		runner := classify.NewRunner(classify.New(cfg.Classifier.Model, ix.Prices), ix, es, cfg.Classifier.Auto, cfg.Classifier.MinIdle)
		go runner.Run(ctx)
		srv := server.New(cfg, ix, es, runner, web.Dist())
		go srv.CheckPricingDaily(ctx)
		hs := &http.Server{Addr: cfg.Listen, Handler: srv.Handler()}
		go func() {
			<-ctx.Done()
			_ = hs.Shutdown(context.Background())
		}()
		log.Printf("session browser on http://%s (%d sources)", cfg.Listen, len(cfg.AllSources()))
		if err := hs.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatal(err)
		}
	case "list":
		tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "START\tSOURCE\tPROJECT\tCOST\tMODELS\tTOOLS\tAGENTS\tTITLE\tID")
		for _, s := range ix.Summaries(time.Time{}, time.Time{}) {
			fmt.Fprintf(tw, "%s\t%s\t%s\t$%.2f\t%v\t%d\t%d\t%s\t%s\n", s.Start.Local().Format("2006-01-02 15:04"), s.Source, s.Project, s.CostUSD, s.Models, s.ToolCalls, s.Subagents, s.Title, s.ID)
		}
		tw.Flush()
	case "dump":
		if len(args) != 1 {
			log.Fatal("usage: csb dump <session-id>")
		}
		d, err := ix.Detail(args[0])
		if err != nil {
			log.Fatal(err)
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(d)
	case "classify":
		runClassify(ctx, cfg, ix, openStore(), args)
	case "pricing":
		runPricing(ctx, ix, args)
	default:
		flag.Usage()
		os.Exit(2)
	}
}

func runExport(args []string) {
	fs := flag.NewFlagSet("export", flag.ExitOnError)
	dest := fs.String("dest", "", "team folder to export into (required)")
	name := fs.String("name", os.Getenv("USER"), "your folder name inside -dest")
	claudeDir := fs.String("claude", "~/.claude", "Claude Code config directory")
	redact := fs.Bool("redact", false, "export metrics only: strip prompts, responses and tool input/output")
	var exclude multiFlag
	fs.Var(&exclude, "exclude", "glob of project folder names to skip (repeatable), e.g. '*-secret-*'")
	_ = fs.Parse(args)
	if *dest == "" {
		fs.Usage()
		os.Exit(2)
	}
	dir, err := config.ExpandHome(*claudeDir)
	if err != nil {
		log.Fatal(err)
	}
	destDir, err := config.ExpandHome(*dest)
	if err != nil {
		log.Fatal(err)
	}
	rep, err := export.Run(export.Options{ClaudeDir: dir, Dest: destDir, Name: *name, Redact: *redact, Exclude: exclude})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("exported to %s: %d files copied (%.1f MB), %d unchanged, %d projects excluded\n",
		filepath.Join(destDir, *name), rep.Copied, float64(rep.Bytes)/1e6, rep.Unchanged, rep.Excluded)
}

func runClassify(ctx context.Context, cfg *config.Config, ix *sessions.Index, es *enrich.Store, args []string) {
	fs := flag.NewFlagSet("classify", flag.ExitOnError)
	since := fs.Duration("since", 30*24*time.Hour, "only sessions active within this window")
	redo := fs.Bool("redo", false, "also re-suggest sessions that already have a suggestion")
	dry := fs.Bool("dry-run", false, "print the digest sent to the model for the first session and exit")
	var only multiFlag
	fs.Var(&only, "id", "classify this session even if already tagged (repeatable)")
	_ = fs.Parse(args)

	ids := []string(only)
	for _, s := range ix.Summaries(time.Now().Add(-*since), time.Time{}) {
		if len(only) > 0 {
			break
		}
		info := es.Session(s.ID)
		if s.UserPrompts > 0 && len(info.Tags) == 0 && (info.Suggestion == nil || *redo || info.Suggestion.Status == "error") {
			ids = append(ids, s.ID)
		}
	}
	if *dry {
		if len(ids) == 0 {
			fmt.Println("no sessions to classify")
			return
		}
		d, err := ix.Detail(ids[0])
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(classify.Digest(d))
		return
	}
	fmt.Printf("classifying %d sessions with %s…\n", len(ids), cfg.Classifier.Model)
	runner := classify.NewRunner(classify.New(cfg.Classifier.Model, ix.Prices), ix, es, false, 0)
	runner.Enqueue(ids...)
	done := make(chan struct{})
	rctx, cancel := context.WithCancel(ctx)
	go func() { runner.Run(rctx); close(done) }()
	for {
		st := runner.Status()
		if st.Disabled != "" || (st.Queued == 0 && st.Running == 0) || ctx.Err() != nil {
			cancel()
			<-done
			fmt.Printf("done: %d suggested, %d failed, cost $%.4f\n", st.Done, st.Failed, st.CostUSD)
			if st.Disabled != "" {
				log.Fatal(st.Disabled + "\nSet ANTHROPIC_API_KEY or run `ant auth login`.")
			}
			if st.LastError != "" {
				fmt.Println("last error:", st.LastError)
			}
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func runPricing(ctx context.Context, ix *sessions.Index, args []string) {
	if len(args) == 0 || args[0] != "check" {
		log.Fatal("usage: csb pricing check [-write] [-from YYYY-MM-DD]")
	}
	fs := flag.NewFlagSet("pricing check", flag.ExitOnError)
	write := fs.Bool("write", false, "append dated rows for every difference to the pricing file")
	from := fs.String("from", time.Now().UTC().Format("2006-01-02"), "effective date for appended rows")
	_ = fs.Parse(args[1:])
	t := ix.Prices()
	res := t.Check(ctx)
	if res.Error != "" {
		log.Fatal(res.Error)
	}
	if len(res.Changes) == 0 {
		fmt.Printf("%s matches the pricing page.\n", t.Path)
		return
	}
	for _, c := range res.Changes {
		if c.Old == nil {
			fmt.Printf("NEW      %-20s in %g  out %g  cache w5m %g w1h %g read %g\n", c.Match, c.New.Input, c.New.Output, c.New.CacheWrite5m, c.New.CacheWrite1h, c.New.CacheRead)
			continue
		}
		fmt.Printf("CHANGED  %-20s in %g→%g  out %g→%g  read %g→%g\n", c.Match, c.Old.Input, c.New.Input, c.Old.Output, c.New.Output, c.Old.CacheRead, c.New.CacheRead)
	}
	if !*write {
		fmt.Println("\nre-run with -write to append these as rows effective", *from)
		return
	}
	at, err := time.Parse("2006-01-02", *from)
	if err != nil {
		log.Fatal(err)
	}
	n, err := t.AppendChanges(res.Changes, at)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("appended %d rows to %s\n", n, t.Path)
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }
