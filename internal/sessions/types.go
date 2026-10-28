// Package sessions parses Claude Code transcript files (~/.claude/projects/*/*.jsonl)
// into summaries, usage points and full session detail.
package sessions

import (
	"encoding/json"
	"time"
)

// Usage is the token accounting of one or more API responses.
type Usage struct {
	Input        int64 `json:"input"`
	Output       int64 `json:"output"`
	CacheRead    int64 `json:"cacheRead"`
	CacheWrite5m int64 `json:"cacheWrite5m"`
	CacheWrite1h int64 `json:"cacheWrite1h"`
	Thinking     int64 `json:"thinking"`
	WebSearches  int64 `json:"webSearches"`
	Messages     int64 `json:"messages"`
}

func (u *Usage) Add(o Usage) {
	u.Input += o.Input
	u.Output += o.Output
	u.CacheRead += o.CacheRead
	u.CacheWrite5m += o.CacheWrite5m
	u.CacheWrite1h += o.CacheWrite1h
	u.Thinking += o.Thinking
	u.WebSearches += o.WebSearches
	u.Messages += o.Messages
}

// PromptTokens is everything the model read: fresh input plus cache reads and writes.
func (u Usage) PromptTokens() int64 {
	return u.Input + u.CacheRead + u.CacheWrite5m + u.CacheWrite1h
}

// UsagePoint is one deduplicated API response, the unit of the usage-over-time charts.
type UsagePoint struct {
	Time    time.Time `json:"t"`
	Model   string    `json:"model"`
	Actor   string    `json:"actor"` // "main" or a subagent id
	Usage   Usage     `json:"usage"`
	CostUSD float64   `json:"cost"`
	MsgID   string    `json:"-"`
}

// Summary is what the session table and dashboard need; it is kept in memory for every session.
type Summary struct {
	ID            string    `json:"id"`
	Source        string    `json:"source"`
	Project       string    `json:"project"`
	Cwd           string    `json:"cwd"`
	Title         string    `json:"title"`
	FirstPrompt   string    `json:"firstPrompt"`
	Start         time.Time `json:"start"`
	End           time.Time `json:"end"`
	ActiveSeconds int64     `json:"activeSeconds"`
	Version       string    `json:"version"`
	GitBranch     string    `json:"gitBranch"`
	Entrypoint    string    `json:"entrypoint"`
	Models        []string  `json:"models"`
	Usage         Usage     `json:"usage"`
	CostUSD       float64   `json:"cost"`
	UnpricedModel bool      `json:"unpricedModel,omitempty"`
	UserPrompts   int       `json:"userPrompts"`
	ToolCalls     int       `json:"toolCalls"`
	ToolErrors    int       `json:"toolErrors"`
	Interrupts    int       `json:"interrupts"`
	Rejections    int       `json:"rejections"`
	Compactions   int       `json:"compactions"`
	Subagents     int       `json:"subagents"`
	Skills        []string  `json:"skills"`
	Tags          []string  `json:"tags"`
	Note          string    `json:"note,omitempty"`
}

// ToolResult is attached to the tool_use event that produced it.
type ToolResult struct {
	Text    string `json:"text"`
	Chars   int    `json:"chars"`
	IsError bool   `json:"isError"`
	Kind    string `json:"kind,omitempty"` // "rejected" when the user declined the call
}

// Event is one renderable item of the turn history.
type Event struct {
	UUID      string          `json:"uuid"`
	Time      time.Time       `json:"t"`
	Actor     string          `json:"actor"` // "user", "main", "system" or a subagent id
	Kind      string          `json:"kind"`  // prompt, command, command_output, interrupt, text, thinking, tool_use, meta, attachment, system, compact, notification
	Text      string          `json:"text,omitempty"`
	Truncated bool            `json:"truncated,omitempty"`
	Tool      string          `json:"tool,omitempty"`
	ToolID    string          `json:"toolId,omitempty"`
	Summary   string          `json:"summary,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	Result    *ToolResult     `json:"result,omitempty"`
	Model     string          `json:"model,omitempty"`
	Usage     *Usage          `json:"usage,omitempty"`
	AgentLink string          `json:"agentLink,omitempty"` // subagent id spawned by this tool_use
}

type ToolStat struct {
	Name          string         `json:"name"`
	Group         string         `json:"group"` // "builtin", "mcp:<server>"
	Calls         int            `json:"calls"`
	Errors        int            `json:"errors"`
	Rejected      int            `json:"rejected"`
	InputTokens   int64          `json:"inputTokensEst"`
	ResultTokens  int64          `json:"resultTokensEst"`
	SubagentCost  float64        `json:"subagentCost,omitempty"`
	SubagentToken int64          `json:"subagentTokens,omitempty"`
	ByActor       map[string]int `json:"byActor"`
}

type AgentInfo struct {
	ID          string    `json:"id"`
	ParentID    string    `json:"parentId,omitempty"`
	Type        string    `json:"type"`
	Description string    `json:"description"`
	Prompt      string    `json:"prompt,omitempty"`
	Models      []string  `json:"models"`
	Background  bool      `json:"background"`
	Start       time.Time `json:"start"`
	End         time.Time `json:"end"`
	ToolCalls   int       `json:"toolCalls"`
	ToolErrors  int       `json:"toolErrors"`
	Usage       Usage     `json:"usage"`
	CostUSD     float64   `json:"cost"`
	ToolUseID   string    `json:"toolUseId,omitempty"`
}

type SkillUse struct {
	Name  string      `json:"name"`
	Kind  string      `json:"kind"` // "skill" (Skill tool) or "command" (slash command)
	Count int         `json:"count"`
	Uses  []SkillCall `json:"uses"`
}

type SkillCall struct {
	Time  time.Time `json:"t"`
	Actor string    `json:"actor"`
	Args  string    `json:"args,omitempty"`
	UUID  string    `json:"uuid"`
}

type MemoryUse struct {
	Path      string         `json:"path"`
	Kind      string         `json:"kind"` // CLAUDE.md, auto-memory, rules, other
	Ops       map[string]int `json:"ops"`  // loaded, read, write, edit
	TokensEst int64          `json:"tokensEst"`
	First     time.Time      `json:"first"`
}

type Insight struct {
	Kind     string   `json:"kind"`
	Severity string   `json:"severity"` // info, warn, bad
	Title    string   `json:"title"`
	Detail   string   `json:"detail"`
	Count    int      `json:"count"`
	Events   []string `json:"events,omitempty"`
}

type ModelUsage struct {
	Model   string   `json:"model"`
	Usage   Usage    `json:"usage"`
	CostUSD float64  `json:"cost"`
	Rates   []string `json:"rates"` // price-table rows applied to this model's responses
}

// Detail is the full session page payload.
type Detail struct {
	Summary  Summary      `json:"summary"`
	Main     AgentInfo    `json:"main"`
	Events   []Event      `json:"events"`
	Agents   []AgentInfo  `json:"agents"`
	Tools    []ToolStat   `json:"tools"`
	Skills   []SkillUse   `json:"skills"`
	Memories []MemoryUse  `json:"memories"`
	Insights []Insight    `json:"insights"`
	Models   []ModelUsage `json:"models"`
}
