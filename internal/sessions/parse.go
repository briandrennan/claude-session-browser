package sessions

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/bdrennan/claude-session-browser/internal/pricing"
)

const (
	maxText   = 16 << 10
	maxResult = 8 << 10
	maxInput  = 16 << 10

	maxAccesses = 200     // memory accesses kept per path
	maxFullText = 2 << 20 // cap on a tool result served in full

	activeGapCap = 5 * time.Minute
	idleGap      = 15 * time.Minute
	bigResult    = 25_000 // chars, roughly 6k tokens
)

type rawLine struct {
	Type              string          `json:"type"`
	UUID              string          `json:"uuid"`
	Timestamp         time.Time       `json:"timestamp"`
	SessionID         string          `json:"sessionId"`
	AgentID           string          `json:"agentId"`
	IsSidechain       bool            `json:"isSidechain"`
	IsMeta            bool            `json:"isMeta"`
	IsCompactSummary  bool            `json:"isCompactSummary"`
	IsAPIErrorMessage bool            `json:"isApiErrorMessage"`
	Cwd               string          `json:"cwd"`
	GitBranch         string          `json:"gitBranch"`
	Version           string          `json:"version"`
	Entrypoint        string          `json:"entrypoint"`
	Subtype           string          `json:"subtype"`
	Content           json.RawMessage `json:"content"`
	Message           *rawMessage     `json:"message"`
	ToolUseResult     json.RawMessage `json:"toolUseResult"`
	Attachment        json.RawMessage `json:"attachment"`
	AITitle           string          `json:"aiTitle"`
	CustomTitle       string          `json:"customTitle"`
	Summary           string          `json:"summary"`
}

type rawMessage struct {
	ID      string          `json:"id"`
	Role    string          `json:"role"`
	Model   string          `json:"model"`
	Content json.RawMessage `json:"content"`
	Usage   *rawUsage       `json:"usage"`
}

type rawUsage struct {
	InputTokens   int64 `json:"input_tokens"`
	OutputTokens  int64 `json:"output_tokens"`
	CacheCreation int64 `json:"cache_creation_input_tokens"`
	CacheRead     int64 `json:"cache_read_input_tokens"`
	CacheSplit    *struct {
		M5 int64 `json:"ephemeral_5m_input_tokens"`
		H1 int64 `json:"ephemeral_1h_input_tokens"`
	} `json:"cache_creation"`
	ServerToolUse *struct {
		WebSearch int64 `json:"web_search_requests"`
	} `json:"server_tool_use"`
	OutputDetails *struct {
		Thinking int64 `json:"thinking_tokens"`
	} `json:"output_tokens_details"`
	Speed        string `json:"speed"`
	InferenceGeo string `json:"inference_geo"`
}

func (r *rawUsage) toUsage() Usage {
	u := Usage{Input: r.InputTokens, Output: r.OutputTokens, CacheRead: r.CacheRead, Messages: 1}
	if r.CacheSplit != nil && r.CacheSplit.M5+r.CacheSplit.H1 > 0 {
		u.CacheWrite5m, u.CacheWrite1h = r.CacheSplit.M5, r.CacheSplit.H1
	} else {
		u.CacheWrite5m = r.CacheCreation
	}
	if r.ServerToolUse != nil {
		u.WebSearches = r.ServerToolUse.WebSearch
	}
	if r.OutputDetails != nil {
		u.Thinking = r.OutputDetails.Thinking
	}
	return u
}

type block struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
	ToolName  string          `json:"tool_name"`
}

type agentMeta struct {
	AgentType    string `json:"agentType"`
	Description  string `json:"description"`
	ToolUseID    string `json:"toolUseId"`
	Model        string `json:"model"`
	RequestShape string `json:"requestShape"`
}

// Parser turns transcript files into Details.
type Parser struct{ Prices *pricing.Table }

// Parse reads a main session transcript and its subagent transcripts.
// extraAgents are legacy top-level agent-*.jsonl files that belong to this session.
func (p *Parser) Parse(path, source string, extraAgents []string) (*Detail, []UsagePoint, error) {
	id := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	st := newState(p, id, source)
	if err := st.readFile(path, ""); err != nil {
		return nil, nil, err
	}
	for _, af := range agentFiles(path, extraAgents) {
		aid := strings.TrimPrefix(strings.TrimSuffix(filepath.Base(af), ".jsonl"), "agent-")
		ag := st.agent(aid)
		var meta agentMeta
		if b, err := os.ReadFile(strings.TrimSuffix(af, ".jsonl") + ".meta.json"); err == nil {
			_ = json.Unmarshal(b, &meta)
			ag.Type, ag.Description, ag.ToolUseID = meta.AgentType, meta.Description, meta.ToolUseID
			ag.Background = meta.RequestShape == "background"
		}
		if err := st.readFile(af, aid); err != nil {
			return nil, nil, fmt.Errorf("%s: %w", af, err)
		}
	}
	st.finish()
	return st.d, st.points, nil
}

// agentFiles lists a session's subagent transcripts: the subagents directory plus legacy top-level files.
func agentFiles(path string, extra []string) []string {
	files, _ := filepath.Glob(filepath.Join(strings.TrimSuffix(path, ".jsonl"), "subagents", "agent-*.jsonl"))
	return append(files, extra...)
}

type state struct {
	p          *Parser
	d          *Detail
	points     []UsagePoint
	pointByMsg map[string]int
	firstEvent map[string]bool // message ids that already carry usage on an event
	toolEvents map[string]int  // tool_use id -> index into d.Events
	tools      map[string]*ToolStat
	skills     map[string]*SkillUse
	memories   map[string]*MemoryUse
	agents     map[string]*AgentInfo
	agentOrder []string
	callSigs   map[string][]string
	aiTitle    string
	custom     string
	summary    string
	unpriced   bool
	rates      map[string]map[string]bool // model -> applied rate descriptions
}

func newState(p *Parser, id, source string) *state {
	return &state{
		p:          p,
		d:          &Detail{Summary: Summary{ID: id, Source: source}},
		pointByMsg: map[string]int{},
		firstEvent: map[string]bool{},
		toolEvents: map[string]int{},
		tools:      map[string]*ToolStat{},
		skills:     map[string]*SkillUse{},
		memories:   map[string]*MemoryUse{},
		agents:     map[string]*AgentInfo{},
		callSigs:   map[string][]string{},
		rates:      map[string]map[string]bool{},
	}
}

func (st *state) agent(id string) *AgentInfo {
	a, ok := st.agents[id]
	if !ok {
		a = &AgentInfo{ID: id, Type: "subagent"}
		st.agents[id] = a
		st.agentOrder = append(st.agentOrder, id)
	}
	return a
}

func (st *state) readFile(path, agentID string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var rl rawLine
			if json.Unmarshal(line, &rl) == nil {
				st.line(&rl, agentID)
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func (st *state) line(rl *rawLine, agentID string) {
	s := &st.d.Summary
	actor := "main"
	if agentID != "" {
		actor = agentID
	} else if rl.IsSidechain {
		actor = "sidechain"
	}
	if agentID == "" && !rl.Timestamp.IsZero() {
		if s.Start.IsZero() || rl.Timestamp.Before(s.Start) {
			s.Start = rl.Timestamp
		}
		if rl.Timestamp.After(s.End) {
			s.End = rl.Timestamp
		}
	}
	if agentID != "" && !rl.Timestamp.IsZero() {
		a := st.agent(agentID)
		if a.Start.IsZero() || rl.Timestamp.Before(a.Start) {
			a.Start = rl.Timestamp
		}
		if rl.Timestamp.After(a.End) {
			a.End = rl.Timestamp
		}
	}
	if agentID == "" {
		if s.Cwd == "" && rl.Cwd != "" {
			s.Cwd = rl.Cwd
		}
		if rl.Version != "" {
			s.Version = rl.Version
		}
		if s.GitBranch == "" && rl.GitBranch != "" {
			s.GitBranch = rl.GitBranch
		}
		if s.Entrypoint == "" && rl.Entrypoint != "" {
			s.Entrypoint = rl.Entrypoint
		}
	}

	switch rl.Type {
	case "ai-title":
		st.aiTitle = rl.AITitle
	case "custom-title":
		st.custom = rl.CustomTitle
	case "summary":
		st.summary = rl.Summary
	case "user":
		st.user(rl, actor, agentID != "")
	case "assistant":
		st.assistant(rl, actor)
	case "attachment":
		st.attachment(rl, actor)
	case "system":
		var text string
		_ = json.Unmarshal(rl.Content, &text)
		if rl.Subtype == "compact_boundary" {
			s.Compactions++
		}
		st.emit(Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: "system", Kind: "system", Tool: rl.Subtype, Text: clip(text, maxText)})
	}
}

func (st *state) emit(e Event) int {
	if len(e.Text) > maxText {
		e.Text, e.Truncated = e.Text[:maxText], true
	}
	st.d.Events = append(st.d.Events, e)
	return len(st.d.Events) - 1
}

var (
	reCommandName = regexp.MustCompile(`(?s)<command-name>(.*?)</command-name>`)
	reCommandArgs = regexp.MustCompile(`(?s)<command-args>(.*?)</command-args>`)
	reTag         = regexp.MustCompile(`(?s)<(local-command-stdout|bash-stdout|bash-stderr|bash-input)>(.*?)</(local-command-stdout|bash-stdout|bash-stderr|bash-input)>`)
	reReminder    = regexp.MustCompile(`(?s)<system-reminder>.*?</system-reminder>`)
	reAgentMsg    = regexp.MustCompile(`(?s)<agent-message\b.*?</agent-message>`)
	reMemoryPath  = regexp.MustCompile(`(/[^\s"'<>()]*?(?:/memory/[^\s"'<>()]+\.md|CLAUDE(?:\.local)?\.md|/\.claude/rules/[^\s"'<>()]+\.md))`)
)

func (st *state) user(rl *rawLine, actor string, inAgent bool) {
	s := &st.d.Summary
	promptActor := "user"
	if inAgent {
		promptActor = actor
	}
	if rl.IsCompactSummary {
		s.Compactions++
		st.emit(Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: "system", Kind: "compact", Text: contentText(rl.Message)})
		return
	}
	if rl.Message == nil {
		return
	}
	var str string
	if json.Unmarshal(rl.Message.Content, &str) == nil {
		st.userText(rl, str, promptActor, inAgent)
		return
	}
	var blocks []block
	if json.Unmarshal(rl.Message.Content, &blocks) != nil {
		return
	}
	for _, b := range blocks {
		switch b.Type {
		case "tool_result":
			st.toolResult(rl, b)
		case "text":
			st.userText(rl, b.Text, promptActor, inAgent)
		case "image":
			st.emit(Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: promptActor, Kind: "prompt", Text: "[image]"})
		}
	}
}

func (st *state) userText(rl *rawLine, text, actor string, inAgent bool) {
	s := &st.d.Summary
	// Only injected context loads memory: meta lines and <system-reminder> blocks, not paths
	// a person or a parent agent wrote in a prompt, nor subagent reports relayed inside reminders.
	injected := text
	if !rl.IsMeta {
		injected = strings.Join(reReminder.FindAllString(text, -1), "\n")
	}
	st.scanMemoryText(reAgentMsg.ReplaceAllString(injected, ""), "loaded", rl)
	trimmed := strings.TrimSpace(text)
	switch {
	case rl.IsMeta:
		if strings.HasPrefix(trimmed, "<local-command-caveat>") {
			return
		}
		st.emit(Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: "system", Kind: "meta", Text: text})
	case strings.Contains(trimmed, "<command-name>"):
		name := strings.TrimSpace(firstGroup(reCommandName, trimmed))
		args := strings.TrimSpace(firstGroup(reCommandArgs, trimmed))
		st.recordSkill(strings.TrimPrefix(name, "/"), "command", args, actor, rl)
		if !inAgent && s.FirstPrompt == "" {
			s.FirstPrompt = strings.TrimSpace(name + " " + args)
		}
		st.emit(Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: actor, Kind: "command", Text: strings.TrimSpace(name + " " + args)})
	case reTag.MatchString(trimmed) && strings.HasPrefix(trimmed, "<"):
		m := reTag.FindStringSubmatch(trimmed)
		kind := "command_output"
		out := m[2]
		if m[1] == "bash-input" {
			kind, out = "command", "! "+m[2]
		}
		st.emit(Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: actor, Kind: kind, Text: out})
	case strings.HasPrefix(trimmed, "[Request interrupted by user"):
		s.Interrupts++
		st.emit(Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: "user", Kind: "interrupt", Text: trimmed})
	case strings.HasPrefix(trimmed, "<task-notification>") || strings.HasPrefix(trimmed, "<agent-message"):
		st.emit(Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: "system", Kind: "notification", Text: text})
	case strings.HasPrefix(trimmed, "Base directory for this skill:"):
		st.emit(Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: "system", Kind: "meta", Text: text})
	default:
		clean := strings.TrimSpace(reReminder.ReplaceAllString(text, ""))
		if clean == "" {
			st.emit(Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: "system", Kind: "meta", Text: text})
			return
		}
		if !inAgent {
			s.UserPrompts++
			if s.FirstPrompt == "" {
				s.FirstPrompt = clip(clean, 300)
			}
		}
		st.emit(Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: actor, Kind: "prompt", Text: clean})
	}
}

func (st *state) toolResult(rl *rawLine, b block) {
	text := blockContentText(b.Content)
	res := &ToolResult{Text: clip(text, maxResult), Chars: len(text), IsError: b.IsError, Truncated: len(text) > maxResult}
	if strings.HasPrefix(text, "The user doesn't want to proceed") || strings.Contains(text, "user rejected") || strings.Contains(text, "Permission to use") && strings.Contains(text, "denied") {
		res.Kind = "rejected"
		st.d.Summary.Rejections++
	}
	idx, ok := st.toolEvents[b.ToolUseID]
	if !ok {
		return
	}
	ev := &st.d.Events[idx]
	ev.Result = res
	if ts := st.tools[ev.Tool]; ts != nil {
		ts.ResultTokens += int64(len(text) / 4)
		if res.IsError && res.Kind != "rejected" {
			ts.Errors++
		}
		if res.Kind == "rejected" {
			ts.Rejected++
		}
	}
	if res.IsError && res.Kind != "rejected" {
		if a, ok := st.agents[ev.Actor]; ok {
			a.ToolErrors++
		} else {
			st.d.Summary.ToolErrors++
		}
	}
	// Agent tool results name the subagent they launched.
	var tur struct {
		AgentID string `json:"agentId"`
	}
	if len(rl.ToolUseResult) > 0 && rl.ToolUseResult[0] == '{' && json.Unmarshal(rl.ToolUseResult, &tur) == nil && tur.AgentID != "" {
		ev.AgentLink = tur.AgentID
	}
}

func (st *state) assistant(rl *rawLine, actor string) {
	m := rl.Message
	if m == nil {
		return
	}
	var usage *Usage
	if m.Usage != nil && m.Model != "" && m.Model != "<synthetic>" {
		u := m.Usage.toUsage()
		cost, row, ok := st.p.Prices.Cost(m.Model, rl.Timestamp, pricing.Tokens{
			Input: u.Input, Output: u.Output, CacheRead: u.CacheRead,
			CacheWrite5m: u.CacheWrite5m, CacheWrite1h: u.CacheWrite1h, WebSearches: u.WebSearches,
		}, m.Usage.Speed, m.Usage.InferenceGeo)
		if !ok {
			st.unpriced = true
		} else {
			if st.rates[m.Model] == nil {
				st.rates[m.Model] = map[string]bool{}
			}
			st.rates[m.Model][rateDesc(row, m.Usage.Speed, m.Usage.InferenceGeo)] = true
		}
		pt := UsagePoint{Time: rl.Timestamp, Model: m.Model, Actor: actor, Usage: u, CostUSD: cost, MsgID: m.ID}
		// Each content block of one response is logged as its own line with the same
		// usage; keep one point per message id (the last write has final counts).
		if i, ok := st.pointByMsg[m.ID]; ok && m.ID != "" {
			st.points[i] = pt
		} else {
			st.pointByMsg[m.ID] = len(st.points)
			st.points = append(st.points, pt)
		}
		usage = &u
	}
	if rl.IsAPIErrorMessage {
		st.emit(Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: "system", Kind: "system", Tool: "api_error", Text: contentText(m)})
		return
	}
	var blocks []block
	if json.Unmarshal(m.Content, &blocks) != nil {
		return
	}
	for _, b := range blocks {
		e := Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: actor, Model: m.Model}
		if usage != nil && !st.firstEvent[m.ID] {
			e.Usage = usage
			st.firstEvent[m.ID] = true
		}
		switch b.Type {
		case "text":
			if strings.TrimSpace(b.Text) == "" {
				continue
			}
			e.Kind, e.Text = "text", b.Text
		case "thinking", "redacted_thinking":
			e.Kind, e.Text = "thinking", b.Thinking
		case "tool_use", "server_tool_use":
			e.Kind, e.Tool, e.ToolID = "tool_use", b.Name, b.ID
			e.Summary = toolSummary(b.Name, b.Input)
			if len(b.Input) <= maxInput {
				e.Input = b.Input
			} else {
				e.InputTruncated = true
				e.Input, _ = json.Marshal(map[string]string{"_truncated": clip(string(b.Input), maxInput)})
			}
			e.Paths = inputPaths(b.Input)
			if b.Name == "Bash" {
				e.CmdPaths = bashPaths(b.Input)
			}
			st.toolUse(rl, actor, b)
			st.toolEvents[b.ID] = st.emit(e)
			continue
		default:
			continue
		}
		st.emit(e)
	}
}

func (st *state) toolUse(rl *rawLine, actor string, b block) {
	ts := st.tools[b.Name]
	if ts == nil {
		group := "builtin"
		if strings.HasPrefix(b.Name, "mcp__") {
			parts := strings.SplitN(strings.TrimPrefix(b.Name, "mcp__"), "__", 2)
			group = "mcp:" + parts[0]
		}
		ts = &ToolStat{Name: b.Name, Group: group, ByActor: map[string]int{}}
		st.tools[b.Name] = ts
	}
	ts.Calls++
	ts.ByActor[actor]++
	ts.InputTokens += int64(len(b.Input) / 4)
	if a, ok := st.agents[actor]; ok {
		a.ToolCalls++
	} else {
		st.d.Summary.ToolCalls++
	}
	sig := actor + "\x00" + b.Name + "\x00" + string(b.Input)
	st.callSigs[sig] = append(st.callSigs[sig], rl.UUID)

	var in map[string]any
	_ = json.Unmarshal(b.Input, &in)
	str := func(k string) string { v, _ := in[k].(string); return v }
	switch b.Name {
	case "Skill":
		st.recordSkill(str("skill"), "skill", str("args"), actor, rl)
	case "Read", "Write", "Edit", "MultiEdit", "NotebookEdit":
		if fp := str("file_path"); isMemoryPath(fp) {
			op := map[string]string{"Read": "read", "Write": "write"}[b.Name]
			if op == "" {
				op = "edit"
			}
			mu := st.access(fp, MemoryAccess{Time: rl.Timestamp, Op: op, Actor: actor, UUID: rl.UUID, ToolID: b.ID})
			if c := str("content"); c != "" {
				mu.TokensEst = int64(len(c) / 4)
			}
		}
	}
}

func (st *state) recordSkill(name, kind, args, actor string, rl *rawLine) {
	if name == "" {
		return
	}
	key := kind + ":" + name
	su := st.skills[key]
	if su == nil {
		su = &SkillUse{Name: name, Kind: kind}
		st.skills[key] = su
	}
	su.Count++
	su.Uses = append(su.Uses, SkillCall{Time: rl.Timestamp, Actor: actor, Args: clip(args, 500), UUID: rl.UUID})
}

func (st *state) memory(path string, t time.Time) *MemoryUse {
	mu := st.memories[path]
	if mu == nil {
		mu = &MemoryUse{Path: path, Kind: memoryKind(path), Ops: map[string]int{}, First: t}
		st.memories[path] = mu
	}
	return mu
}

// access counts an op on a memory path and records it. Every access is kept here, uncapped and
// with its full loaded content; foldAccesses orders them by time, folds repeated loads into
// reloads and applies the caps once every transcript has been parsed.
func (st *state) access(path string, a MemoryAccess) *MemoryUse {
	mu := st.memory(path, a.Time)
	mu.Ops[a.Op]++
	mu.Accesses = append(mu.Accesses, a)
	return mu
}

// foldAccesses time-orders a path's accesses (the main transcript is parsed before its subagents'),
// folds a load identical to the path's previous load into that load's row as a Reload (reads, writes
// and edits in between are ignored; loads without captured content never fold), then clips content
// and applies the maxAccesses caps. Ops are untouched and count every access.
func foldAccesses(mu *MemoryUse) {
	raw := mu.Accesses
	sort.SliceStable(raw, func(i, j int) bool { return raw[i].Time.Before(raw[j].Time) })
	if len(raw) > 0 && !raw[0].Time.IsZero() && (mu.First.IsZero() || raw[0].Time.Before(mu.First)) {
		mu.First = raw[0].Time
	}
	var out []MemoryAccess
	var prev string
	havePrev := false
	prevIdx := -1 // row of the previous load in out, or -1 if the cap dropped it
	for _, a := range raw {
		isLoad := a.Op == "loaded" && a.Content != ""
		if isLoad {
			if havePrev && prev == a.Content {
				if prevIdx >= 0 && len(out[prevIdx].Reloads) < maxAccesses {
					out[prevIdx].Reloads = append(out[prevIdx].Reloads, MemoryReload{Time: a.Time, Actor: a.Actor, UUID: a.UUID})
				}
				continue
			}
			prev, havePrev = a.Content, true
			if len(a.Content) > maxText {
				a.Content, a.Truncated = clip(a.Content, maxText), true
			}
		}
		idx := -1
		if len(out) < maxAccesses {
			idx = len(out)
			out = append(out, a)
		}
		if isLoad {
			prevIdx = idx
		}
	}
	mu.Accesses = out
}

func (st *state) scanMemoryText(text string, op string, rl *rawLine) {
	if !strings.Contains(text, ".md") {
		return
	}
	seen := map[string]bool{}
	for _, m := range reMemoryPath.FindAllString(text, -1) {
		if seen[m] {
			continue
		}
		seen[m] = true
		// A bare mention is not a load; the "Contents of <path>" header is.
		idx := contentsIndex(text, m)
		if idx < 0 {
			continue
		}
		rest := text[idx:]
		if end := strings.Index(rest[len(m):], "\nContents of "); end > 0 {
			rest = rest[:len(m)+end]
		}
		tokens := int64(len(rest) / 4)
		mu := st.access(m, MemoryAccess{Time: rl.Timestamp, Op: op, Actor: "system", UUID: rl.UUID, Content: memoryContent(text[idx+len("Contents of ")+len(m):])})
		if mu.TokensEst == 0 {
			mu.TokensEst = tokens
		}
	}
}

// contentsIndex finds the "Contents of <path>" header for exactly path m, skipping longer paths that
// merely start with m: the path must be followed by a space, ':', '(', newline or the end of text.
func contentsIndex(text, m string) int {
	needle := "Contents of " + m
	for off := 0; ; {
		i := strings.Index(text[off:], needle)
		if i < 0 {
			return -1
		}
		i += off
		end := i + len(needle)
		if end == len(text) || strings.IndexByte(" :(\n\r", text[end]) >= 0 {
			return i
		}
		off = i + 1
	}
}

// memoryContent takes the text after a "Contents of <path>" header and returns the file body:
// everything after the header line up to the next "Contents of" block or the end of the reminder.
func memoryContent(rest string) string {
	if i := strings.IndexByte(rest, '\n'); i >= 0 {
		rest = rest[i+1:]
	} else {
		return ""
	}
	if i := strings.Index(rest, "\nContents of "); i >= 0 {
		rest = rest[:i]
	}
	if i := strings.Index(rest, "</system-reminder>"); i >= 0 {
		rest = rest[:i]
	}
	return strings.TrimSpace(rest)
}

func (st *state) attachment(rl *rawLine, actor string) {
	var a map[string]any
	if json.Unmarshal(rl.Attachment, &a) != nil {
		return
	}
	typ, _ := a["type"].(string)
	// Memory files surface in attachments under various shapes; walk every string.
	if typ == "instructions" {
		files, _ := a["files"].([]any)
		for _, f := range files {
			fm, _ := f.(map[string]any)
			path, _ := fm["path"].(string)
			if !isMemoryPath(path) {
				continue
			}
			content, _ := fm["content"].(string)
			mu := st.access(path, MemoryAccess{Time: rl.Timestamp, Op: "loaded", Actor: "system", UUID: rl.UUID, Content: content})
			if mu.TokensEst == 0 {
				mu.TokensEst = int64(len(content) / 4)
			}
		}
	} else if strings.Contains(typ, "memory") || strings.Contains(typ, "claude_md") || strings.Contains(typ, "nested") {
		walkStrings(a, func(k, v string) {
			if isMemoryPath(v) {
				st.access(v, MemoryAccess{Time: rl.Timestamp, Op: "loaded", Actor: "system", UUID: rl.UUID})
			}
		})
	}
	ev := Event{UUID: rl.UUID, Time: rl.Timestamp, Actor: "system", Kind: "attachment", Tool: typ}
	if typ == "queued_command" {
		if p, _ := a["prompt"].(string); p != "" {
			ev.Kind, ev.Text = "notification", p
		}
	} else {
		b, _ := json.Marshal(a)
		ev.Text = clip(string(b), maxText)
	}
	if actor != "main" && actor != "sidechain" {
		ev.Actor = actor
		if ev.Kind == "attachment" {
			ev.Actor = "system"
		}
	}
	st.emit(ev)
}

func (st *state) finish() {
	d, s := st.d, &st.d.Summary
	switch {
	case st.custom != "":
		s.Title = st.custom
	case st.aiTitle != "":
		s.Title = st.aiTitle
	case st.summary != "":
		s.Title = st.summary
	default:
		s.Title = clip(strings.SplitN(s.FirstPrompt, "\n", 2)[0], 80)
	}
	if s.Title == "" {
		s.Title = "(untitled)"
	}
	s.Project = projectName(s.Cwd)
	s.UnpricedModel = st.unpriced

	sort.SliceStable(d.Events, func(i, j int) bool { return d.Events[i].Time.Before(d.Events[j].Time) })
	// Re-index tool events after sorting.
	for i, e := range d.Events {
		if e.Kind == "tool_use" {
			st.toolEvents[e.ToolID] = i
		}
	}

	d.Main = AgentInfo{ID: "main", Type: "main thread", Description: s.Title, Start: s.Start, End: s.End}
	// Usage totals per session, per model, per agent.
	models := map[string]*ModelUsage{}
	for _, pt := range st.points {
		s.Usage.Add(pt.Usage)
		s.CostUSD += pt.CostUSD
		mu := models[pt.Model]
		if mu == nil {
			mu = &ModelUsage{Model: pt.Model}
			models[pt.Model] = mu
		}
		mu.Usage.Add(pt.Usage)
		mu.CostUSD += pt.CostUSD
		a, ok := st.agents[pt.Actor]
		if !ok {
			a = &d.Main
		}
		a.Usage.Add(pt.Usage)
		a.CostUSD += pt.CostUSD
		if !contains(a.Models, pt.Model) {
			a.Models = append(a.Models, pt.Model)
		}
	}
	for _, mu := range models {
		for r := range st.rates[mu.Model] {
			mu.Rates = append(mu.Rates, r)
		}
		sort.Strings(mu.Rates)
		if mu.Rates == nil {
			mu.Rates = []string{"unpriced"}
		}
		d.Models = append(d.Models, *mu)
		s.Models = append(s.Models, mu.Model)
	}
	sort.Slice(d.Models, func(i, j int) bool { return d.Models[i].CostUSD > d.Models[j].CostUSD })
	sort.Strings(s.Models)

	// Link subagents to the tool call that spawned them.
	for _, id := range st.agentOrder {
		a := st.agents[id]
		idx, ok := st.toolEvents[a.ToolUseID]
		if !ok {
			for i, e := range d.Events {
				if e.AgentLink == id {
					idx, ok = i, true
					break
				}
			}
		}
		if ok {
			e := &d.Events[idx]
			e.AgentLink = id
			a.ToolUseID = e.ToolID
			if e.Actor != "main" {
				a.ParentID = e.Actor
			}
			var in struct {
				Description  string `json:"description"`
				Prompt       string `json:"prompt"`
				SubagentType string `json:"subagent_type"`
				Background   bool   `json:"run_in_background"`
			}
			_ = json.Unmarshal(e.Input, &in)
			if a.Description == "" {
				a.Description = in.Description
			}
			if a.Type == "subagent" && in.SubagentType != "" {
				a.Type = in.SubagentType
			}
			a.Prompt = clip(in.Prompt, 4000)
			a.Background = a.Background || in.Background
			if ts := st.tools[e.Tool]; ts != nil {
				ts.SubagentCost += a.CostUSD
				ts.SubagentToken += a.Usage.PromptTokens() + a.Usage.Output
			}
		}
		d.Agents = append(d.Agents, *a)
	}
	s.Subagents = len(d.Agents)
	d.Main.ToolCalls, d.Main.ToolErrors = s.ToolCalls, s.ToolErrors

	for _, ts := range st.tools {
		d.Tools = append(d.Tools, *ts)
	}
	sort.Slice(d.Tools, func(i, j int) bool { return d.Tools[i].Calls > d.Tools[j].Calls })
	for _, su := range st.skills {
		d.Skills = append(d.Skills, *su)
		if su.Kind == "skill" {
			s.Skills = append(s.Skills, su.Name)
		}
	}
	sort.Slice(d.Skills, func(i, j int) bool { return d.Skills[i].Count > d.Skills[j].Count })
	sort.Strings(s.Skills)
	for _, mu := range st.memories {
		foldAccesses(mu)
		mu.Accesses = nonNil(mu.Accesses)
		d.Memories = append(d.Memories, *mu)
	}
	sort.Slice(d.Memories, func(i, j int) bool { return d.Memories[i].First.Before(d.Memories[j].First) })

	s.ActiveSeconds = activeSeconds(d.Events)
	d.Insights = st.insights()
	// Empty lists serialize as [] rather than null for the frontend.
	d.Agents = nonNil(d.Agents)
	d.Tools = nonNil(d.Tools)
	d.Skills = nonNil(d.Skills)
	d.Memories = nonNil(d.Memories)
	d.Insights = nonNil(d.Insights)
	d.Models = nonNil(d.Models)
	d.Events = nonNil(d.Events)
	for _, sl := range []*[]string{&s.Models, &s.Skills, &s.Tags} {
		if *sl == nil {
			*sl = []string{}
		}
	}
}

func activeSeconds(events []Event) int64 {
	var total time.Duration
	var prev time.Time
	for _, e := range events {
		if e.Time.IsZero() {
			continue
		}
		if !prev.IsZero() {
			gap := e.Time.Sub(prev)
			if gap > activeGapCap {
				gap = activeGapCap
			}
			if gap > 0 {
				total += gap
			}
		}
		prev = e.Time
	}
	return int64(total.Seconds())
}

func (st *state) insights() []Insight {
	d, s := st.d, &st.d.Summary
	var out []Insight
	collect := func(pred func(e Event) bool) []string {
		var ids []string
		for _, e := range d.Events {
			if pred(e) {
				ids = append(ids, e.UUID)
			}
		}
		return ids
	}
	if ids := collect(func(e Event) bool { return e.Result != nil && e.Result.IsError && e.Result.Kind != "rejected" }); len(ids) > 0 {
		sev := "warn"
		if s.ToolCalls > 0 && float64(len(ids))/float64(s.ToolCalls) > 0.15 {
			sev = "bad"
		}
		out = append(out, Insight{Kind: "tool_errors", Severity: sev, Title: "Failed tool calls", Count: len(ids), Events: ids,
			Detail: "Tool calls that returned errors. Recurring errors from the same tool often point to missing setup, wrong paths or flaky commands worth fixing in CLAUDE.md."})
	}
	if ids := collect(func(e Event) bool { return e.Result != nil && e.Result.Kind == "rejected" }); len(ids) > 0 {
		out = append(out, Insight{Kind: "rejections", Severity: "warn", Title: "Rejected tool calls", Count: len(ids), Events: ids,
			Detail: "Calls the user declined. Frequent rejections suggest Claude is heading the wrong way, or that permissions could be pre-approved."})
	}
	if ids := collect(func(e Event) bool { return e.Kind == "interrupt" }); len(ids) > 0 {
		out = append(out, Insight{Kind: "interrupts", Severity: "warn", Title: "User interruptions", Count: len(ids), Events: ids,
			Detail: "Turns the user stopped mid-flight. Each one usually marks wasted work; clearer up-front instructions or plan mode can help."})
	}
	if ids := collect(func(e Event) bool { return e.Kind == "system" && e.Tool == "api_error" }); len(ids) > 0 {
		out = append(out, Insight{Kind: "api_errors", Severity: "warn", Title: "API errors", Count: len(ids), Events: ids, Detail: "Requests that failed (rate limits, overload, context length)."})
	}
	if s.Compactions > 0 {
		out = append(out, Insight{Kind: "compactions", Severity: "info", Title: "Context compactions", Count: s.Compactions,
			Events: collect(func(e Event) bool { return e.Kind == "compact" || e.Tool == "compact_boundary" }),
			Detail: "The conversation outgrew its context. Long sessions lose detail on compaction; splitting work into smaller sessions is often cheaper."})
	}
	var repeated []string
	n := 0
	for _, ids := range st.callSigs {
		if len(ids) >= 3 {
			n++
			repeated = append(repeated, ids...)
		}
	}
	if n > 0 {
		out = append(out, Insight{Kind: "repeats", Severity: "warn", Title: "Identical tool calls repeated 3+ times", Count: n, Events: repeated,
			Detail: "The same tool was called with the same input over and over, typically a retry loop or re-reading the same file."})
	}
	if ids := collect(func(e Event) bool { return e.Result != nil && e.Result.Chars > bigResult }); len(ids) > 0 {
		out = append(out, Insight{Kind: "big_results", Severity: "info", Title: "Very large tool results", Count: len(ids), Events: ids,
			Detail: "Tool outputs over ~6k tokens. They bloat context and are paid for again on every later turn via cache reads; narrower commands or subagents help."})
	}
	var gaps []string
	var prev time.Time
	for _, e := range d.Events {
		if e.Actor == "main" || e.Actor == "user" {
			if !prev.IsZero() && e.Time.Sub(prev) > idleGap {
				gaps = append(gaps, e.UUID)
			}
			prev = e.Time
		}
	}
	if len(gaps) > 0 {
		out = append(out, Insight{Kind: "idle", Severity: "info", Title: "Idle gaps over 15 minutes", Count: len(gaps), Events: gaps,
			Detail: "Long pauses in the main thread. A cold cache after a 5-minute (or 1-hour) gap means the next turn re-writes the whole context."})
	}
	if p := s.Usage.PromptTokens(); p > 50_000 {
		hit := float64(s.Usage.CacheRead) / float64(p)
		if hit < 0.7 {
			out = append(out, Insight{Kind: "cache", Severity: "warn", Title: "Low prompt-cache hit rate", Count: int(hit * 100),
				Detail: fmt.Sprintf("Only %.0f%% of prompt tokens were cache reads. Cache writes cost 1.25-2x input; reads cost ~0.1x.", hit*100)})
		}
	}
	return out
}

// --- helpers ---

func contentText(m *rawMessage) string {
	if m == nil {
		return ""
	}
	return blockContentText(m.Content)
}

func blockContentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []block
	if json.Unmarshal(raw, &blocks) != nil {
		return string(raw)
	}
	var sb strings.Builder
	for _, b := range blocks {
		switch b.Type {
		case "text":
			sb.WriteString(b.Text)
			sb.WriteByte('\n')
		case "image":
			sb.WriteString("[image]\n")
		case "tool_reference":
			sb.WriteString("[tool " + b.ToolName + "]\n")
		default:
			if b.Text != "" {
				sb.WriteString(b.Text + "\n")
			} else if len(b.Content) > 0 {
				sb.WriteString(blockContentText(b.Content))
			}
		}
	}
	return strings.TrimRight(sb.String(), "\n")
}

func toolSummary(name string, input json.RawMessage) string {
	var in map[string]any
	if json.Unmarshal(input, &in) != nil {
		return ""
	}
	for _, k := range []string{"command", "file_path", "notebook_path", "pattern", "query", "url", "description", "skill", "prompt", "path"} {
		if v, ok := in[k].(string); ok && v != "" {
			if name == "Grep" || name == "Glob" {
				if p, ok := in["path"].(string); ok && k == "pattern" {
					v += " in " + p
				}
			}
			return clip(strings.SplitN(v, "\n", 2)[0], 200)
		}
	}
	for _, v := range in {
		if s, ok := v.(string); ok {
			return clip(strings.SplitN(s, "\n", 2)[0], 200)
		}
	}
	return ""
}

func isMemoryPath(p string) bool {
	if p == "" || !strings.HasSuffix(p, ".md") {
		return false
	}
	base := filepath.Base(p)
	return base == "CLAUDE.md" || base == "CLAUDE.local.md" || strings.Contains(p, "/memory/") || strings.Contains(p, "/.claude/rules/")
}

func memoryKind(p string) string {
	switch {
	case strings.Contains(p, "/memory/"):
		return "auto-memory"
	case strings.Contains(p, "/.claude/rules/"):
		return "rules"
	case strings.HasSuffix(p, "CLAUDE.md") || strings.HasSuffix(p, "CLAUDE.local.md"):
		return "CLAUDE.md"
	}
	return "other"
}

func walkStrings(v any, fn func(k, v string)) {
	switch t := v.(type) {
	case map[string]any:
		for k, x := range t {
			if s, ok := x.(string); ok {
				fn(k, s)
				// Some attachment fields hold JSON-encoded strings.
				if strings.HasPrefix(s, "{") || strings.HasPrefix(s, "[") {
					var inner any
					if json.Unmarshal([]byte(s), &inner) == nil {
						walkStrings(inner, fn)
					}
				}
			} else {
				walkStrings(x, fn)
			}
		}
	case []any:
		for _, x := range t {
			if s, ok := x.(string); ok {
				fn("", s)
			} else {
				walkStrings(x, fn)
			}
		}
	}
}

func projectName(cwd string) string {
	if cwd == "" {
		return "(unknown)"
	}
	return filepath.Base(cwd)
}

func firstGroup(re *regexp.Regexp, s string) string {
	if m := re.FindStringSubmatch(s); len(m) > 1 {
		return m[1]
	}
	return ""
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// Avoid splitting a UTF-8 sequence.
	for n > 0 && n < len(s) && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n] + "…"
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

func nonNil[T any](xs []T) []T {
	if xs == nil {
		return []T{}
	}
	return xs
}

// rateDesc names the price-table row (and modifiers) a response was billed with.
func rateDesc(r *pricing.Row, speed, geo string) string {
	d := r.Label + " list price"
	if r.From != "" {
		d += " from " + r.From
	}
	if speed == "fast" && r.FastMultiplier > 0 {
		d += fmt.Sprintf(" · fast ×%g", r.FastMultiplier)
	}
	if m, ok := r.GeoMultipliers[geo]; ok {
		d += fmt.Sprintf(" · %s inference ×%g", geo, m)
	}
	return d
}
