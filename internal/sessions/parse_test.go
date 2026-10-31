package sessions

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func jl(t *testing.T, lines ...any) string {
	t.Helper()
	var sb strings.Builder
	for _, l := range lines {
		b, err := json.Marshal(l)
		if err != nil {
			t.Fatal(err)
		}
		sb.Write(b)
		sb.WriteByte('\n')
	}
	return sb.String()
}

type m = map[string]any

func ts(i int) string { return fmt.Sprintf("2026-01-01T00:00:%02dZ", i) }

func toolUse(i int, uuid, id, name string, input any) m {
	return m{"type": "assistant", "uuid": uuid, "timestamp": ts(i), "message": m{"id": "msg_" + uuid, "role": "assistant", "content": []m{{"type": "tool_use", "id": id, "name": name, "input": input}}}}
}

func toolResult(i int, uuid, id, text string) m {
	return m{"type": "user", "uuid": uuid, "timestamp": ts(i), "message": m{"role": "user", "content": []m{{"type": "tool_result", "tool_use_id": id, "content": text}}}}
}

func reminder(i int, uuid, text string) m {
	return m{"type": "user", "uuid": uuid, "timestamp": ts(i), "isMeta": true, "message": m{"role": "user", "content": []m{{"type": "text", "text": text}}}}
}

func write(t *testing.T, path, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func parse(t *testing.T, path string) *Detail {
	t.Helper()
	d, _, err := (&Parser{}).Parse(path, "test", nil)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func mem(d *Detail, path string) *MemoryUse {
	for i := range d.Memories {
		if d.Memories[i].Path == path {
			return &d.Memories[i]
		}
	}
	return nil
}

func TestTruncationAndToolCall(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "s1.jsonl")
	big := strings.Repeat("x", maxResult+500)
	hugeIn := map[string]string{"command": strings.Repeat("y", maxInput+10)}
	write(t, main, jl(t,
		toolUse(1, "u1", "toolu_big", "Bash", hugeIn),
		toolResult(2, "u2", "toolu_big", big),
		toolUse(3, "u3", "toolu_small", "Bash", m{"command": "ls"}),
		toolResult(4, "u4", "toolu_small", "ok"),
	))
	write(t, filepath.Join(dir, "s1", "subagents", "agent-a1.jsonl"), jl(t,
		toolUse(5, "u5", "toolu_sub", "Read", m{"file_path": "/x"}),
		toolResult(6, "u6", "toolu_sub", big+big),
	))
	d := parse(t, main)
	ev := map[string]Event{}
	for _, e := range d.Events {
		if e.Kind == "tool_use" {
			ev[e.ToolID] = e
		}
	}
	if e := ev["toolu_big"]; !e.InputTruncated || !e.Result.Truncated || e.Result.Chars != len(big) || len(e.Result.Text) > maxResult+4 {
		t.Fatalf("big call not flagged: %+v %+v", e.InputTruncated, e.Result)
	}
	if e := ev["toolu_small"]; e.InputTruncated || e.Result.Truncated {
		t.Fatalf("small call flagged")
	}

	ix := &Index{entries: map[string]*entry{"s1": {path: main, summary: Summary{ID: "s1"}}, "gone": {summary: Summary{ID: "gone"}}}}
	c, err := ix.ToolCall("s1", "toolu_big")
	if err != nil {
		t.Fatal(err)
	}
	var in map[string]string
	if err := json.Unmarshal(c.Input, &in); err != nil || len(in["command"]) != maxInput+10 || c.Name != "Bash" {
		t.Fatalf("input not full: %v %s", err, c.Name)
	}
	if c.Result == nil || c.Result.Text != big || c.Result.Truncated || c.Result.Chars != len(big) {
		t.Fatalf("result not full")
	}
	c, err = ix.ToolCall("s1", "toolu_sub")
	if err != nil || c.Name != "Read" || c.Result == nil || c.Result.Chars != 2*len(big) {
		t.Fatalf("subagent call: %v %+v", err, c)
	}
	for _, id := range []string{"toolu_nope", ""} {
		if _, err := ix.ToolCall("s1", id); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("tool %q: want not found, got %v", id, err)
		}
	}
	if _, err := ix.ToolCall("missing", "toolu_big"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing session: %v", err)
	}
	if _, err := ix.ToolCall("gone", "toolu_big"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("archived session: %v", err)
	}
}

func TestToolCallResultCap(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "s.jsonl")
	huge := strings.Repeat("z", maxFullText+1000)
	write(t, main, jl(t, toolUse(1, "u1", "toolu_h", "Bash", m{}), toolResult(2, "u2", "toolu_h", huge)))
	ix := &Index{entries: map[string]*entry{"s": {path: main, summary: Summary{ID: "s"}}}}
	c, err := ix.ToolCall("s", "toolu_h")
	if err != nil || !c.Result.Truncated || c.Result.Chars != len(huge) || len(c.Result.Text) > maxFullText+4 {
		t.Fatalf("cap: %v %+v", err, c.Result.Truncated)
	}
}

const memA = "/home/u/.claude/projects/p/memory/MEMORY.md"
const memB = "/home/u/.claude/projects/p/memory/other.md"

func contentsReminder(a, b string) string {
	return "<system-reminder>\nContents of " + memA + " (user's auto-memory, persists across conversations):\n\n" + a +
		"\n\nContents of " + memB + " (user's auto-memory, persists across conversations):\n\n" + b +
		"\n\n</system-reminder>"
}

func TestContentsExtractionAndUnchanged(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "s.jsonl")
	write(t, main, jl(t,
		reminder(1, "r1", contentsReminder("- one\n- two", "other body")),
		reminder(2, "r2", contentsReminder("- one\n- two", "other body v2")),
	))
	d := parse(t, main)
	a, b := mem(d, memA), mem(d, memB)
	if a == nil || b == nil {
		t.Fatalf("memories: %+v", d.Memories)
	}
	if len(a.Accesses) != 2 || a.Ops["loaded"] != 2 {
		t.Fatalf("a accesses: %+v", a.Accesses)
	}
	if x := a.Accesses[0]; x.Content != "- one\n- two" || x.Op != "loaded" || x.Actor != "system" || x.UUID != "r1" || x.Unchanged {
		t.Fatalf("a[0]: %+v", x)
	}
	if x := a.Accesses[1]; !x.Unchanged || x.Content != "" || x.UUID != "r2" {
		t.Fatalf("a[1]: %+v", x)
	}
	if b.Accesses[0].Content != "other body" || b.Accesses[1].Content != "other body v2" || b.Accesses[1].Unchanged {
		t.Fatalf("b: %+v", b.Accesses)
	}
}

func TestMentionOnlyAndEmptyAccesses(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "s.jsonl")
	report := "<system-reminder>\n<agent-message from=\"x\">\nContents of " + memB + " (quoted):\n\nquoted\n</agent-message>\n</system-reminder>"
	write(t, main, jl(t, reminder(1, "r1", "see "+memA+" for notes"), reminder(2, "r2", report)))
	d := parse(t, main)
	if a, b := mem(d, memA), mem(d, memB); a != nil || b != nil {
		t.Fatalf("mention or quoted report counted as a load: %+v %+v", a, b)
	}
	if d2 := parse(t, func() string { p := filepath.Join(dir, "e.jsonl"); write(t, p, ""); return p }()); d2.Memories == nil {
		t.Fatal("memories must be non-nil")
	}
}

func TestInstructionsAttachment(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "s.jsonl")
	att := func(i int, uuid, content string) m {
		return m{"type": "attachment", "uuid": uuid, "timestamp": ts(i), "attachment": m{"type": "instructions", "files": []m{
			{"path": memA, "type": "AutoMem", "content": content},
			{"path": "/etc/hosts", "type": "Other", "content": "ignored"},
		}}}
	}
	write(t, main, jl(t, att(1, "a1", strings.Repeat("m", 400)), att(2, "a2", strings.Repeat("m", 400))))
	d := parse(t, main)
	a := mem(d, memA)
	if a == nil || len(d.Memories) != 1 || a.TokensEst != 100 || a.Ops["loaded"] != 2 {
		t.Fatalf("memories: %+v", d.Memories)
	}
	if a.Accesses[0].Content != strings.Repeat("m", 400) || a.Accesses[0].UUID != "a1" || !a.Accesses[1].Unchanged {
		t.Fatalf("accesses: %+v", a.Accesses)
	}
	for _, e := range d.Events {
		if e.Kind == "attachment" && e.Truncated {
			t.Fatal("small attachment truncated")
		}
	}
}

func TestToolAccessesAndCap(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "s.jsonl")
	lines := []any{
		toolUse(1, "u1", "toolu_r", "Read", m{"file_path": memA}),
		toolUse(2, "u2", "toolu_w", "Write", m{"file_path": memB, "content": strings.Repeat("c", 80)}),
		toolUse(3, "u3", "toolu_e", "Edit", m{"file_path": memA, "old_string": "a", "new_string": "b"}),
	}
	for i := 0; i < maxAccesses+10; i++ {
		lines = append(lines, toolUse(4, fmt.Sprintf("x%d", i), fmt.Sprintf("toolu_x%d", i), "Read", m{"file_path": memB}))
	}
	write(t, main, jl(t, lines...))
	d := parse(t, main)
	a, b := mem(d, memA), mem(d, memB)
	if len(a.Accesses) != 2 || a.Accesses[0].Op != "read" || a.Accesses[0].ToolID != "toolu_r" || a.Accesses[0].UUID != "u1" || a.Accesses[0].Actor != "main" ||
		a.Accesses[1].Op != "edit" || a.Accesses[1].ToolID != "toolu_e" {
		t.Fatalf("a: %+v", a.Accesses)
	}
	if b.TokensEst != 20 || b.Accesses[0].Op != "write" || b.Accesses[0].ToolID != "toolu_w" {
		t.Fatalf("b: %+v", b)
	}
	if len(b.Accesses) != maxAccesses || b.Ops["read"] != maxAccesses+10 {
		t.Fatalf("cap: %d accesses, %d reads", len(b.Accesses), b.Ops["read"])
	}
}

func TestContentsHeaderPrefixPath(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "s.jsonl")
	short, long := "/h/memory/a.md", "/h/memory/a.md.md"
	write(t, main, jl(t, reminder(1, "r1", "<system-reminder>\nContents of "+long+" (x):\n\nLONG\n\nContents of "+short+" (y):\n\nSHORT\n</system-reminder>")))
	d := parse(t, main)
	a, b := mem(d, short), mem(d, long)
	if a == nil || b == nil || a.Accesses[0].Content != "SHORT" || b.Accesses[0].Content != "LONG" {
		t.Fatalf("prefix: %+v", d.Memories)
	}
}

func TestPromptMentionsAreNotLoads(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "s.jsonl")
	prompt := func(i int, uuid, text string) m {
		return m{"type": "user", "uuid": uuid, "timestamp": ts(i), "message": m{"role": "user", "content": text}}
	}
	write(t, main, jl(t,
		prompt(1, "p1", "Please edit "+memA+"; it starts with:\nContents of "+memB+" (x):\n\nnot injected"),
		prompt(2, "p2", "<system-reminder>\nContents of "+memA+" (y):\n\nINJECTED\n</system-reminder>\nhi"),
	))
	d := parse(t, main)
	if mem(d, memB) != nil {
		t.Fatalf("prompt text counted as a load: %+v", mem(d, memB))
	}
	a := mem(d, memA)
	if a == nil || len(a.Accesses) != 1 || a.Accesses[0].UUID != "p2" || a.Accesses[0].Content != "INJECTED" {
		t.Fatalf("reminder load: %+v", a)
	}
}
