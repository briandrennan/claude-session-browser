// Package classify suggests purpose tags for sessions with a small Claude model.
package classify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/bdrennan/claude-session-browser/internal/enrich"
	"github.com/bdrennan/claude-session-browser/internal/pricing"
	"github.com/bdrennan/claude-session-browser/internal/sessions"
)

// Descriptions for the default vocabulary; user-defined tags are passed by name only.
var tagHints = map[string]string{
	"exploration":             "understanding a codebase, tool or problem; reading, searching, asking questions, prototyping without shipping",
	"feature-dev":             "building new functionality or extending existing behaviour",
	"bug-fixing":              "diagnosing and fixing incorrect behaviour, failing builds or errors",
	"performance-engineering": "profiling, benchmarking, making code faster or cheaper",
	"simplification":          "refactoring, deleting code, reducing complexity without changing behaviour",
	"code-review":             "reviewing diffs or pull requests, auditing code for problems",
	"testing":                 "writing, fixing or running tests and test infrastructure",
}

const system = `You classify the purpose of Claude Code sessions for an engineering team's usage report.
You receive a digest of one session: the user's prompts, files edited, commands run and tools used.
Pick the 1-3 tags from the allowed list that best describe what the session was mainly for; prefer one tag
unless the session clearly did several distinct things. If no allowed tag fits at all, leave "tags" empty and
put a short lowercase-hyphenated tag in "new_tag"; otherwise "new_tag" is "". "rationale" is one short sentence.`

type Classifier struct {
	client anthropic.Client
	model  string
	prices func() *pricing.Table
}

func New(model string, prices func() *pricing.Table) *Classifier {
	return &Classifier{client: anthropic.NewClient(), model: model, prices: prices}
}

type result struct {
	Tags      []string `json:"tags"`
	NewTag    string   `json:"new_tag"`
	Rationale string   `json:"rationale"`
}

// Classify returns a pending suggestion for the session.
func (c *Classifier) Classify(ctx context.Context, d *sessions.Detail, vocab []string) (enrich.Suggestion, error) {
	if len(vocab) == 0 {
		return enrich.Suggestion{}, errors.New("tag vocabulary is empty")
	}
	var allowed strings.Builder
	for _, t := range vocab {
		if h, ok := tagHints[t]; ok {
			fmt.Fprintf(&allowed, "- %s: %s\n", t, h)
		} else {
			fmt.Fprintf(&allowed, "- %s\n", t)
		}
	}
	schema := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []string{"tags", "new_tag", "rationale"},
		"properties": map[string]any{
			"tags":      map[string]any{"type": "array", "items": map[string]any{"type": "string", "enum": vocab}},
			"new_tag":   map[string]any{"type": "string"},
			"rationale": map[string]any{"type": "string"},
		},
	}
	resp, err := c.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     anthropic.Model(c.model),
		MaxTokens: 4000,
		System:    []anthropic.TextBlockParam{{Text: system}},
		OutputConfig: anthropic.OutputConfigParam{
			Effort: anthropic.OutputConfigEffortLow,
			Format: anthropic.JSONOutputFormatParam{Schema: schema},
		},
		Messages: []anthropic.MessageParam{
			anthropic.NewUserMessage(anthropic.NewTextBlock("Allowed tags:\n" + allowed.String() + "\n" + Digest(d))),
		},
	})
	if err != nil {
		return enrich.Suggestion{}, err
	}
	sg := enrich.Suggestion{Model: c.model, At: time.Now().UTC()}
	sg.CostUSD, _, _ = c.prices().Cost(string(resp.Model), time.Now(), pricing.Tokens{
		Input: resp.Usage.InputTokens, Output: resp.Usage.OutputTokens,
		CacheRead: resp.Usage.CacheReadInputTokens, CacheWrite5m: resp.Usage.CacheCreationInputTokens,
	}, "", "")
	if resp.StopReason == anthropic.StopReasonRefusal {
		return sg, errors.New("model declined to classify this session")
	}
	var text string
	for _, b := range resp.Content {
		if t, ok := b.AsAny().(anthropic.TextBlock); ok {
			text += t.Text
		}
	}
	var r result
	if err := json.Unmarshal([]byte(text), &r); err != nil {
		return sg, fmt.Errorf("unexpected classifier output %q: %w", text, err)
	}
	if len(r.Tags) > 3 {
		r.Tags = r.Tags[:3]
	}
	sg.Tags, sg.NewTag, sg.Rationale = r.Tags, strings.TrimSpace(r.NewTag), r.Rationale
	return sg, nil
}

// IsAuthError reports whether err means the API credentials are missing or invalid.
func IsAuthError(err error) bool {
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == 401 || apiErr.StatusCode == 403
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "api key") || strings.Contains(msg, "x-api-key") || strings.Contains(msg, "authentication") || strings.Contains(msg, "credentials")
}

// Digest is the compact, text-only view of a session the classifier sees.
func Digest(d *sessions.Detail) string {
	s := d.Summary
	var b strings.Builder
	fmt.Fprintf(&b, "Session title: %s\nProject: %s", s.Title, s.Project)
	if s.GitBranch != "" && s.GitBranch != "HEAD" {
		fmt.Fprintf(&b, " (branch %s)", s.GitBranch)
	}
	fmt.Fprintf(&b, "\nActive time: %d min · %d prompts · %d tool calls · %d subagents\n", s.ActiveSeconds/60, s.UserPrompts, s.ToolCalls, s.Subagents)

	b.WriteString("\nUser prompts:\n")
	n := 0
	for _, e := range d.Events {
		if (e.Kind == "prompt" || e.Kind == "command") && e.Actor == "user" && n < 8 {
			n++
			fmt.Fprintf(&b, "%d. %s\n", n, oneLine(e.Text, 700))
		}
	}

	edited := map[string]bool{}
	var commands []string
	for _, e := range d.Events {
		if e.Kind != "tool_use" {
			continue
		}
		switch e.Tool {
		case "Edit", "Write", "MultiEdit", "NotebookEdit":
			edited[e.Summary] = true
		case "Bash":
			if len(commands) < 15 {
				commands = append(commands, oneLine(e.Summary, 120))
			}
		}
	}
	if len(edited) > 0 {
		files := make([]string, 0, len(edited))
		for f := range edited {
			files = append(files, f)
		}
		sort.Strings(files)
		if len(files) > 20 {
			files = append(files[:20], fmt.Sprintf("… and %d more", len(files)-20))
		}
		b.WriteString("\nFiles written or edited:\n- " + strings.Join(files, "\n- ") + "\n")
	}
	if len(commands) > 0 {
		b.WriteString("\nShell commands (first 15):\n- " + strings.Join(commands, "\n- ") + "\n")
	}
	var tools []string
	for _, t := range d.Tools {
		tools = append(tools, fmt.Sprintf("%s×%d", t.Name, t.Calls))
	}
	if len(tools) > 0 {
		b.WriteString("\nTools: " + strings.Join(tools, ", ") + "\n")
	}
	var skills []string
	for _, sk := range d.Skills {
		skills = append(skills, sk.Name)
	}
	if len(skills) > 0 {
		b.WriteString("Skills/commands: " + strings.Join(skills, ", ") + "\n")
	}
	for _, a := range d.Agents {
		fmt.Fprintf(&b, "Subagent %s: %s\n", a.Type, oneLine(a.Description, 120))
	}
	return b.String()
}

func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > n {
		s = strings.ToValidUTF8(s[:n], "") + "…"
	}
	return s
}
