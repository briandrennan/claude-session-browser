package sessions

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bdrennan/claude-session-browser/internal/config"
	"github.com/bdrennan/claude-session-browser/internal/pricing"
)

type entry struct {
	path    string
	source  string
	extra   []string // legacy top-level agent-*.jsonl files
	sig     string
	summary Summary
	points  []UsagePoint // deduplicated across sessions (resumed/forked sessions repeat history)
	raw     []UsagePoint
	prompts []Event // archived sessions only (path == "")
}

// Index keeps summaries and usage points for every session in memory and
// re-parses files whose size or mtime changed.
type Index struct {
	cfg    *config.Config
	parser *Parser

	mu      sync.RWMutex
	entries map[string]*entry // by session id
	lastRun time.Time
	refresh sync.Mutex

	pricesMod  time.Time
	archiveSig map[string]string // by source name
	archived   map[string]*entry // by "<source>/<id>"
}

func NewIndex(cfg *config.Config) (*Index, error) {
	ix := &Index{cfg: cfg, parser: &Parser{}, entries: map[string]*entry{}}
	return ix, ix.reloadPrices()
}

// Prices returns the price table currently in use.
func (ix *Index) Prices() *pricing.Table {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.parser.Prices
}

// reloadPrices (re)loads the price table when its file changed; every session is
// then re-priced on the next refresh.
func (ix *Index) reloadPrices() error {
	fi, err := os.Stat(ix.cfg.PricingFile)
	if err == nil && ix.parser.Prices != nil && fi.ModTime().Equal(ix.pricesMod) {
		return nil
	}
	t, err := pricing.Load(ix.cfg.PricingFile)
	if err != nil {
		return err
	}
	if fi, err := os.Stat(ix.cfg.PricingFile); err == nil {
		ix.pricesMod = fi.ModTime()
	}
	ix.mu.Lock()
	ix.parser = &Parser{Prices: t}
	ix.entries = map[string]*entry{}
	ix.mu.Unlock()
	log.Printf("loaded price table %s (%d rows)", t.Path, len(t.Models))
	return nil
}

// Refresh rescans sources if the last scan is older than maxAge.
func (ix *Index) Refresh(maxAge time.Duration) error {
	ix.refresh.Lock()
	defer ix.refresh.Unlock()
	if time.Since(ix.lastRun) < maxAge {
		return nil
	}
	start := time.Now()
	if err := ix.reloadPrices(); err != nil {
		return err
	}

	type job struct {
		id, path, source, sig string
		extra                 []string
	}
	var jobs []job
	found := map[string]bool{}
	sources := ix.cfg.AllSources()
	for _, src := range sources {
		mains, _ := filepath.Glob(filepath.Join(src.Path, "projects", "*", "*.jsonl"))
		legacy := map[string][]string{}
		var sessionsFiles []string
		for _, f := range mains {
			if strings.HasPrefix(filepath.Base(f), "agent-") {
				if sid := firstSessionID(f); sid != "" {
					legacy[sid] = append(legacy[sid], f)
				}
				continue
			}
			sessionsFiles = append(sessionsFiles, f)
		}
		for _, f := range sessionsFiles {
			id := strings.TrimSuffix(filepath.Base(f), ".jsonl")
			key := src.Name + "/" + id
			if found[key] {
				continue
			}
			found[key] = true
			extra := legacy[id]
			sig := signature(f, extra)
			ix.mu.RLock()
			e, ok := ix.entries[key]
			ix.mu.RUnlock()
			if ok && e.sig == sig {
				continue
			}
			jobs = append(jobs, job{id: key, path: f, source: src.Name, sig: sig, extra: extra})
		}
	}

	ix.mu.RLock()
	parser := ix.parser
	ix.mu.RUnlock()
	results := make(chan *entry, len(jobs))
	sem := make(chan struct{}, runtime.NumCPU())
	var wg sync.WaitGroup
	var skipMu sync.Mutex
	skipped := map[string]bool{} // transcripts that produced no entry this run
	for _, j := range jobs {
		wg.Add(1)
		sem <- struct{}{}
		go func(j job) {
			defer wg.Done()
			defer func() { <-sem }()
			d, pts, err := parser.Parse(j.path, j.source, j.extra)
			if err != nil {
				log.Printf("parse %s: %v", j.path, err)
				skipMu.Lock()
				skipped[j.id] = true
				skipMu.Unlock()
				return
			}
			if d.Summary.Start.IsZero() {
				skipMu.Lock()
				skipped[j.id] = true
				skipMu.Unlock()
				return // empty transcript
			}
			results <- &entry{path: j.path, source: j.source, extra: j.extra, sig: j.sig, summary: d.Summary, raw: pts}
		}(j)
	}
	wg.Wait()
	close(results)

	// Transcripts with no entry (empty, or unreadable mid-write) don't count as
	// live, so their sessions stay listed from the prompt history.
	live := map[string]bool{}
	ix.mu.RLock()
	for k := range found {
		if e, ok := ix.entries[k]; !skipped[k] || ok && e.path != "" {
			live[k] = true
		}
	}
	ix.mu.RUnlock()
	archived := ix.loadArchives(sources, live)

	ix.mu.Lock()
	for e := range results {
		ix.entries[e.source+"/"+e.summary.ID] = e
	}
	for k, e := range archived { // never collides with a transcript: loadArchives skips found ids
		found[k] = true
		ix.entries[k] = e
	}
	for k := range ix.entries {
		if !found[k] {
			delete(ix.entries, k)
		}
	}
	ix.dedupe()
	ix.mu.Unlock()
	ix.lastRun = time.Now()
	if len(jobs) > 0 {
		log.Printf("indexed %d changed sessions (%d total) in %s", len(jobs), len(ix.entries), time.Since(start).Round(time.Millisecond))
	}
	return nil
}

// loadArchives returns archived sessions for every source, rebuilding a
// source's set only when its history or sessions-index files changed.
func (ix *Index) loadArchives(sources []config.Source, found map[string]bool) map[string]*entry {
	if ix.archiveSig == nil {
		ix.archiveSig, ix.archived = map[string]string{}, map[string]*entry{}
	}
	for _, src := range sources {
		files := archiveFiles(src.Path)
		var sb strings.Builder
		for _, f := range files {
			if fi, err := os.Stat(f); err == nil {
				fmt.Fprintf(&sb, "%s:%d:%d;", f, fi.Size(), fi.ModTime().UnixNano())
			}
		}
		// Transcripts appearing or disappearing also change the archived set.
		live := map[string]bool{}
		var ids []string
		for k := range found {
			if id, ok := strings.CutPrefix(k, src.Name+"/"); ok {
				live[id] = true
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		sb.WriteString(strings.Join(ids, ","))
		sig := sb.String()
		if ix.archiveSig[src.Name] == sig {
			continue
		}
		ix.archiveSig[src.Name] = sig
		for k := range ix.archived {
			if strings.HasPrefix(k, src.Name+"/") {
				delete(ix.archived, k)
			}
		}
		for k, e := range loadArchived(src.Name, src.Path, live) {
			ix.archived[k] = e
		}
	}
	out := make(map[string]*entry, len(ix.archived))
	for k, e := range ix.archived {
		out[k] = e
	}
	return out
}

// dedupe drops usage points whose message id already appeared in an earlier
// session from the same source, so resumed/forked sessions are not double-counted.
func (ix *Index) dedupe() {
	all := make([]*entry, 0, len(ix.entries))
	for _, e := range ix.entries {
		all = append(all, e)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].summary.Start.Before(all[j].summary.Start) })
	seen := map[string]bool{}
	for _, e := range all {
		e.points = e.points[:0]
		for _, p := range e.raw {
			k := e.source + "/" + p.MsgID
			if p.MsgID != "" && seen[k] {
				continue
			}
			seen[k] = true
			e.points = append(e.points, p)
		}
	}
}

func signature(path string, extra []string) string {
	var sb strings.Builder
	add := func(p string) {
		if fi, err := os.Stat(p); err == nil {
			fmt.Fprintf(&sb, "%s:%d:%d;", filepath.Base(p), fi.Size(), fi.ModTime().UnixNano())
		}
	}
	add(path)
	subs, _ := filepath.Glob(filepath.Join(strings.TrimSuffix(path, ".jsonl"), "subagents", "*"))
	for _, s := range append(subs, extra...) {
		add(s)
	}
	return sb.String()
}

func firstSessionID(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for i := 0; i < 5 && sc.Scan(); i++ {
		var l struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(sc.Bytes(), &l) == nil && l.SessionID != "" {
			return l.SessionID
		}
	}
	return ""
}

// Summaries returns sessions overlapping [from, to]; zero times are open bounds.
func (ix *Index) Summaries(from, to time.Time) []Summary {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	out := []Summary{}
	for _, e := range ix.entries {
		s := e.summary
		if !to.IsZero() && s.Start.After(to) {
			continue
		}
		if !from.IsZero() && s.End.Before(from) {
			continue
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start.After(out[j].Start) })
	return out
}

// Detail parses the full transcript for a session id (with or without source prefix).
func (ix *Index) Detail(id string) (*Detail, error) {
	ix.mu.RLock()
	var e *entry
	for k, v := range ix.entries {
		if k == id || v.summary.ID == id {
			e = v
			break
		}
	}
	parser := ix.parser
	ix.mu.RUnlock()
	if e == nil {
		return nil, os.ErrNotExist
	}
	if e.path == "" {
		return archivedDetail(e), nil
	}
	d, _, err := parser.Parse(e.path, e.source, e.extra)
	return d, err
}

// ToolCall returns the unclipped input and result of one tool call, searching the
// session's main transcript and its subagent transcripts.
func (ix *Index) ToolCall(sessionID, toolID string) (*ToolCallFull, error) {
	e := ix.lookup(sessionID)
	if e == nil || e.path == "" || toolID == "" {
		return nil, os.ErrNotExist
	}
	out := &ToolCallFull{ToolID: toolID}
	var found bool
	for _, f := range append([]string{e.path}, agentFiles(e.path, e.extra)...) {
		done, err := scanToolCall(f, toolID, out, &found)
		if err != nil && f == e.path {
			return nil, err
		}
		if done {
			break
		}
	}
	if !found {
		return nil, os.ErrNotExist
	}
	return out, nil
}

// scanToolCall fills out from the tool_use and tool_result blocks for toolID in one file;
// it reports true once both have been seen.
func scanToolCall(path, toolID string, out *ToolCallFull, found *bool) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	needle := []byte(toolID)
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if bytes.Contains(line, needle) {
			var rl rawLine
			var blocks []block
			if json.Unmarshal(line, &rl) == nil && rl.Message != nil && json.Unmarshal(rl.Message.Content, &blocks) == nil {
				for _, b := range blocks {
					switch {
					case (b.Type == "tool_use" || b.Type == "server_tool_use") && b.ID == toolID && !*found:
						out.Name, out.Input, *found = b.Name, b.Input, true
					case b.Type == "tool_result" && b.ToolUseID == toolID && out.Result == nil:
						text := blockContentText(b.Content)
						out.Result = &ToolResult{Text: clip(text, maxFullText), Chars: len(text), IsError: b.IsError, Truncated: len(text) > maxFullText}
					}
				}
			}
			if *found && out.Result != nil {
				return true, nil
			}
		}
		if err != nil {
			if err == io.EOF {
				err = nil
			}
			return false, err
		}
	}
}

type UsageQuery struct {
	From, To time.Time
	Bucket   string // "hour" or "day"
	Group    string // project, model, project_model, source, tag
	Loc      *time.Location
	TagsOf   func(sessionID string) []string
}

type UsageRow struct {
	Bucket   string  `json:"bucket"`
	Group    string  `json:"group"`
	Cost     float64 `json:"cost"`
	Usage    Usage   `json:"usage"`
	Sessions int     `json:"sessions"`
}

type UsageResult struct {
	Buckets []string   `json:"buckets"`
	Rows    []UsageRow `json:"rows"`
}

func (ix *Index) Usage(q UsageQuery) UsageResult {
	if q.Loc == nil {
		q.Loc = time.Local
	}
	layout := "2006-01-02"
	step := 24 * time.Hour
	if q.Bucket == "hour" {
		layout, step = "2006-01-02T15:00", time.Hour
	}
	trunc := func(t time.Time) time.Time {
		t = t.In(q.Loc)
		if q.Bucket == "hour" {
			return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), 0, 0, 0, q.Loc)
		}
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, q.Loc)
	}
	// Open-ended ranges ("All") start at the first recorded activity, not 1970.
	ix.mu.RLock()
	var first time.Time
	for _, e := range ix.entries {
		for _, p := range e.points {
			if first.IsZero() || p.Time.Before(first) {
				first = p.Time
			}
		}
	}
	ix.mu.RUnlock()
	if q.To.Sub(q.From) > 366*24*time.Hour && first.After(q.From) {
		q.From = first
	}
	var res UsageResult
	for t := trunc(q.From); !t.After(q.To); {
		res.Buckets = append(res.Buckets, t.Format(layout))
		if q.Bucket == "hour" {
			t = t.Add(step)
		} else {
			t = t.AddDate(0, 0, 1) // DST-safe
		}
	}

	type key struct{ bucket, group string }
	rows := map[key]*UsageRow{}
	sessions := map[key]map[string]bool{}
	ix.mu.RLock()
	for _, e := range ix.entries {
		groups := func(model string) []string {
			switch q.Group {
			case "model":
				return []string{model}
			case "project_model":
				return []string{e.summary.Project + " · " + model}
			case "source":
				return []string{e.source}
			case "tag":
				var tags []string
				if q.TagsOf != nil {
					tags = q.TagsOf(e.summary.ID)
				}
				if len(tags) == 0 {
					return []string{"(untagged)"}
				}
				return tags
			default:
				return []string{e.summary.Project}
			}
		}
		for _, p := range e.points {
			if p.Time.Before(q.From) || p.Time.After(q.To) {
				continue
			}
			b := trunc(p.Time).Format(layout)
			for _, g := range groups(p.Model) {
				k := key{b, g}
				r := rows[k]
				if r == nil {
					r = &UsageRow{Bucket: b, Group: g}
					rows[k] = r
					sessions[k] = map[string]bool{}
				}
				r.Cost += p.CostUSD
				r.Usage.Add(p.Usage)
				sessions[k][e.summary.ID] = true
			}
		}
	}
	ix.mu.RUnlock()
	for k, r := range rows {
		r.Sessions = len(sessions[k])
		res.Rows = append(res.Rows, *r)
	}
	sort.Slice(res.Rows, func(i, j int) bool {
		if res.Rows[i].Bucket != res.Rows[j].Bucket {
			return res.Rows[i].Bucket < res.Rows[j].Bucket
		}
		return res.Rows[i].Group < res.Rows[j].Group
	})
	if res.Rows == nil {
		res.Rows = []UsageRow{}
	}
	return res
}
