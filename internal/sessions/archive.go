package sessions

import (
	"bufio"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Claude Code deletes transcripts after cleanupPeriodDays (30 by default), but
// keeps the prompt history (<source>/history.jsonl) and, for older versions,
// per-project sessions-index.json files. Sessions known only from those are
// listed as archived: prompts and timing, but no responses, usage or cost.

const historyGap = time.Hour // splits history lines without a sessionId into sessions

// ArchivedModel is the model name on an archived session's activity points:
// the real model was only recorded in the deleted transcript.
const ArchivedModel = "(archived)"

type historyLine struct {
	Display   string `json:"display"`
	Timestamp int64  `json:"timestamp"`
	Project   string `json:"project"`
	SessionID string `json:"sessionId"`
}

type sessionsIndex struct {
	Entries []struct {
		SessionID   string    `json:"sessionId"`
		FirstPrompt string    `json:"firstPrompt"`
		Summary     string    `json:"summary"`
		Created     time.Time `json:"created"`
		Modified    time.Time `json:"modified"`
		GitBranch   string    `json:"gitBranch"`
		ProjectPath string    `json:"projectPath"`
		IsSidechain bool      `json:"isSidechain"`
	} `json:"entries"`
}

// archiveFiles lists the files archived sessions of a source are built from.
func archiveFiles(root string) []string {
	files, _ := filepath.Glob(filepath.Join(root, "projects", "*", "sessions-index.json"))
	return append([]string{filepath.Join(root, "history.jsonl")}, files...)
}

// loadArchived returns archived entries for sessions of one source, keyed by
// "<source>/<id>", skipping ids that still have a transcript (live).
func loadArchived(source, root string, live map[string]bool) map[string]*entry {
	type acc struct {
		s       Summary
		prompts []Event
	}
	byID := map[string]*acc{}
	get := func(id string) *acc {
		a := byID[id]
		if a == nil {
			a = &acc{s: Summary{ID: id, Source: source, Archived: true}}
			byID[id] = a
		}
		return a
	}

	// Prompt history, oldest first.
	var lines []historyLine
	if f, err := os.Open(filepath.Join(root, "history.jsonl")); err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 1<<20), 64<<20)
		for sc.Scan() {
			var l historyLine
			if json.Unmarshal(sc.Bytes(), &l) == nil && l.Timestamp > 0 {
				lines = append(lines, l)
			}
		}
		f.Close()
	}
	sort.SliceStable(lines, func(i, j int) bool { return lines[i].Timestamp < lines[j].Timestamp })
	lastAnon := map[string]struct {
		id string
		t  time.Time
	}{}
	for i, l := range lines {
		t := time.UnixMilli(l.Timestamp).UTC()
		id := l.SessionID
		if id == "" {
			// No session id (older Claude Code): group by project and idle gap.
			prev, ok := lastAnon[l.Project]
			if !ok || t.Sub(prev.t) > historyGap {
				h := sha1.Sum([]byte(source + "\x00" + l.Project + "\x00" + t.String()))
				prev.id = "history-" + hex.EncodeToString(h[:8])
			}
			prev.t = t
			lastAnon[l.Project] = prev
			id = prev.id
		}
		if live[id] {
			continue
		}
		a := get(id)
		if a.s.Cwd == "" {
			a.s.Cwd = l.Project
		}
		text := strings.TrimSpace(l.Display)
		a.prompts = append(a.prompts, Event{UUID: id + "-" + strconv.Itoa(i), Time: t, Actor: "user", Kind: "prompt", Text: clip(text, maxText), Truncated: len(text) > maxText})
		if a.s.Start.IsZero() || t.Before(a.s.Start) {
			a.s.Start = t
		}
		if t.After(a.s.End) {
			a.s.End = t
		}
		a.s.UserPrompts++
		// Prefer the first real prompt over leading slash commands like /model.
		if text != "" && (a.s.FirstPrompt == "" || strings.HasPrefix(a.s.FirstPrompt, "/") && !strings.HasPrefix(text, "/")) {
			a.s.FirstPrompt = clip(text, 300)
		}
	}

	// sessions-index.json: titles, branches and real start/end times.
	files, _ := filepath.Glob(filepath.Join(root, "projects", "*", "sessions-index.json"))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var ix sessionsIndex
		if json.Unmarshal(b, &ix) != nil {
			continue
		}
		for _, e := range ix.Entries {
			if e.SessionID == "" || e.IsSidechain || live[e.SessionID] {
				continue
			}
			a := get(e.SessionID)
			if e.ProjectPath != "" {
				a.s.Cwd = e.ProjectPath
			}
			if !e.Created.IsZero() && (a.s.Start.IsZero() || e.Created.Before(a.s.Start)) {
				a.s.Start = e.Created
			}
			if e.Modified.After(a.s.End) {
				a.s.End = e.Modified
			}
			a.s.GitBranch = e.GitBranch
			if e.Summary != "" && !strings.HasPrefix(e.Summary, "API Error") {
				a.s.Title = e.Summary
			}
			if a.s.FirstPrompt == "" && e.FirstPrompt != "No prompt" {
				a.s.FirstPrompt = e.FirstPrompt
			}
		}
	}

	out := map[string]*entry{}
	for id, a := range byID {
		s := &a.s
		if s.Start.IsZero() || (s.Title == "" && onlyCommands(a.prompts)) {
			continue // e.g. a session that only ran /resume or /permissions
		}
		if s.End.IsZero() {
			s.End = s.Start
		}
		if s.Title == "" {
			s.Title = clip(strings.SplitN(s.FirstPrompt, "\n", 2)[0], 80)
		}
		if s.Title == "" {
			s.Title = "(untitled)"
		}
		s.Project = projectName(s.Cwd)
		s.ActiveSeconds = activeFromPrompts(a.prompts)
		s.Models, s.Skills, s.Tags = []string{}, []string{}, []string{}
		// One zero-usage point per prompt puts the session on the usage timeline
		// (session counts) without inventing tokens or cost.
		pts := make([]UsagePoint, len(a.prompts))
		for i, ev := range a.prompts {
			pts[i] = UsagePoint{Time: ev.Time, Model: ArchivedModel, Actor: "main"}
		}
		out[source+"/"+id] = &entry{source: source, summary: *s, prompts: a.prompts, raw: pts}
	}
	return out
}

func onlyCommands(ev []Event) bool {
	for _, e := range ev {
		if !strings.HasPrefix(e.Text, "/") {
			return false
		}
	}
	return true
}

// activeFromPrompts estimates active time from prompt timestamps, using the
// same per-gap cap as live transcripts.
func activeFromPrompts(ev []Event) int64 {
	var d time.Duration
	for i := 1; i < len(ev); i++ {
		if g := ev[i].Time.Sub(ev[i-1].Time); g > 0 && g < idleGap {
			d += min(g, activeGapCap)
		}
	}
	return int64(d.Seconds())
}

// archivedDetail is the session page payload for an archived session.
func archivedDetail(e *entry) *Detail {
	s := e.summary
	return &Detail{
		Summary:  s,
		Main:     AgentInfo{ID: "main", Type: "main thread", Description: s.Title, Start: s.Start, End: s.End, Models: []string{}},
		Events:   nonNil(append([]Event(nil), e.prompts...)),
		Agents:   []AgentInfo{},
		Tools:    []ToolStat{},
		Skills:   []SkillUse{},
		Memories: []MemoryUse{},
		Insights: []Insight{},
		Models:   []ModelUsage{},
	}
}
