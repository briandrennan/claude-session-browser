package sessions

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
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

func TestContentsExtractionAndReloads(t *testing.T) {
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
	if len(a.Accesses) != 1 || a.Ops["loaded"] != 2 {
		t.Fatalf("a accesses: %+v", a.Accesses)
	}
	if x := a.Accesses[0]; x.Content != "- one\n- two" || x.Op != "loaded" || x.Actor != "system" || x.UUID != "r1" ||
		len(x.Reloads) != 1 || x.Reloads[0].UUID != "r2" || x.Reloads[0].Actor != "system" || x.Reloads[0].Time.IsZero() {
		t.Fatalf("a[0]: %+v", x)
	}
	if len(b.Accesses) != 2 || b.Accesses[0].Content != "other body" || b.Accesses[1].Content != "other body v2" || len(b.Accesses[1].Reloads) != 0 {
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
	if len(a.Accesses) != 1 || a.Accesses[0].Content != strings.Repeat("m", 400) || a.Accesses[0].UUID != "a1" ||
		len(a.Accesses[0].Reloads) != 1 || a.Accesses[0].Reloads[0].UUID != "a2" {
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

func TestReloadFolding(t *testing.T) {
	load := func(i int, uuid, body string) m { return reminder(i, uuid, contentsReminder(body, "x")) }
	dir := t.TempDir()
	main := filepath.Join(dir, "s.jsonl")

	write(t, main, jl(t, load(1, "r1", "same"), load(2, "r2", "same"), load(3, "r3", "same")))
	a := mem(parse(t, main), memA)
	if len(a.Accesses) != 1 || a.Ops["loaded"] != 3 || len(a.Accesses[0].Reloads) != 2 ||
		a.Accesses[0].Reloads[0].UUID != "r2" || a.Accesses[0].Reloads[1].UUID != "r3" {
		t.Fatalf("three identical: %+v", a)
	}

	// A, B, A: the third load changed relative to B, so it gets its own row.
	write(t, main, jl(t, load(1, "r1", "A"), load(2, "r2", "B"), load(3, "r3", "A"), load(4, "r4", "A")))
	a = mem(parse(t, main), memA)
	if len(a.Accesses) != 3 || a.Ops["loaded"] != 4 || len(a.Accesses[2].Reloads) != 1 || a.Accesses[2].Reloads[0].UUID != "r4" ||
		len(a.Accesses[0].Reloads) != 0 || len(a.Accesses[1].Reloads) != 0 {
		t.Fatalf("A,B,A,A: %+v", a)
	}

	// A reload after intervening reads folds into the load row, not the read row.
	write(t, main, jl(t, load(1, "r1", "A"), toolUse(2, "u1", "toolu_1", "Read", m{"file_path": memA}), load(3, "r3", "A")))
	a = mem(parse(t, main), memA)
	if len(a.Accesses) != 2 || a.Accesses[0].Op != "loaded" || len(a.Accesses[0].Reloads) != 1 || len(a.Accesses[1].Reloads) != 0 || a.Ops["loaded"] != 2 {
		t.Fatalf("read between: %+v", a)
	}
}

func TestReloadFoldingAcrossActors(t *testing.T) {
	load := func(i int, uuid, body string) m { return reminder(i, uuid, contentsReminder(body, "x")) }
	dir := t.TempDir()
	main := filepath.Join(dir, "s.jsonl")
	sub := filepath.Join(dir, "s", "subagents", "agent-a1.jsonl")

	// Main A@1, A@9 and a subagent A@5: one row, reloads in time order.
	write(t, main, jl(t, load(1, "m1", "A"), load(9, "m9", "A")))
	write(t, sub, jl(t, load(5, "s5", "A")))
	a := mem(parse(t, main), memA)
	if len(a.Accesses) != 1 || a.Ops["loaded"] != 3 || len(a.Accesses[0].Reloads) != 2 ||
		a.Accesses[0].Reloads[0].UUID != "s5" || a.Accesses[0].Reloads[1].UUID != "m9" {
		t.Fatalf("A,A + sub A: %+v", a)
	}

	// Main A@1, B@9 and a subagent A@5: A, A(reload), B, with no spurious extra A row.
	write(t, main, jl(t, load(1, "m1", "A"), load(9, "m9", "B")))
	a = mem(parse(t, main), memA)
	if len(a.Accesses) != 2 || a.Accesses[0].Content != "A" || a.Accesses[1].Content != "B" ||
		len(a.Accesses[0].Reloads) != 1 || a.Accesses[0].Reloads[0].UUID != "s5" || a.Ops["loaded"] != 3 {
		t.Fatalf("A,B + sub A: %+v", a)
	}
}

func TestReloadFoldingCaps(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "s.jsonl")
	// Fill the access cap with reads, so the load row itself is never appended.
	var lines []any
	for i := 0; i < maxAccesses; i++ {
		lines = append(lines, toolUse(1, fmt.Sprintf("x%d", i), fmt.Sprintf("toolu_x%d", i), "Read", m{"file_path": memA}))
	}
	lines = append(lines, reminder(2, "r1", contentsReminder("same", "x")), reminder(3, "r2", contentsReminder("same", "x")))
	write(t, main, jl(t, lines...))
	a := mem(parse(t, main), memA)
	if len(a.Accesses) != maxAccesses || a.Ops["loaded"] != 2 {
		t.Fatalf("cap: %d accesses, ops %v", len(a.Accesses), a.Ops)
	}
	for _, x := range a.Accesses {
		if len(x.Reloads) != 0 {
			t.Fatalf("reload attached to a wrong row: %+v", x)
		}
	}

	// Reloads per row are capped.
	lines = nil
	for i := 0; i < maxAccesses+20; i++ {
		lines = append(lines, reminder(1, fmt.Sprintf("r%d", i), contentsReminder("same", "x")))
	}
	write(t, main, jl(t, lines...))
	a = mem(parse(t, main), memA)
	if len(a.Accesses) != 1 || len(a.Accesses[0].Reloads) != maxAccesses || a.Ops["loaded"] != maxAccesses+20 {
		t.Fatalf("reload cap: %d reloads, ops %v", len(a.Accesses[0].Reloads), a.Ops)
	}
}

func TestToolEventPaths(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "s.jsonl")
	write(t, main, jl(t,
		toolUse(1, "u1", "toolu_1", "Edit", m{"file_path": "/a/b.go", "path": "/a", "old_string": "x"}),
		toolUse(2, "u2", "toolu_2", "Bash", m{"command": "cd /a/b && go test ./..."}),
		toolUse(3, "u3", "toolu_3", "Glob", m{"pattern": "*.go", "path": "/a/b.go"}),
		toolUse(4, "u4", "toolu_4", "Read", m{"file_path": ""}),
	))
	ev := map[string]Event{}
	for _, e := range parse(t, main).Events {
		ev[e.ToolID] = e
	}
	if p := ev["toolu_1"].Paths; !reflect.DeepEqual(p, []string{"/a/b.go", "/a"}) || ev["toolu_1"].CmdPaths != nil {
		t.Fatalf("edit: %+v", ev["toolu_1"])
	}
	if e := ev["toolu_2"]; e.Paths != nil || !reflect.DeepEqual(e.CmdPaths, []string{"/a/b", "./..."}) {
		t.Fatalf("bash: %+v", e)
	}
	if p := ev["toolu_3"].Paths; !reflect.DeepEqual(p, []string{"/a/b.go"}) {
		t.Fatalf("glob: %+v", p)
	}
	if ev["toolu_4"].Paths != nil {
		t.Fatalf("empty path: %+v", ev["toolu_4"].Paths)
	}
}

func TestCmdPaths(t *testing.T) {
	long := ""
	for i := 0; i < 100; i++ {
		long += fmt.Sprintf(" /p/%d", i)
	}
	for _, tc := range []struct {
		cmd  string
		want []string
	}{
		{"cd /a/b && go test ./...", []string{"/a/b", "./..."}},
		{"rg -n foo internal/x.go", []string{"internal/x.go"}},
		{"cat > /tmp/out.txt <<EOF\nhello\nEOF", []string{"/tmp/out.txt"}},
		{`sed -i 's/a/b/' "path with space/f.md"`, []string{"path with space/f.md"}},
		{"cat <<-'EOF' > /tmp/o.txt\n\t/in/body.go\n\tEOF\nls /after/x", []string{"/tmp/o.txt", "/after/x"}},
		{"cat > /tmp/out.txt <<\"END\"\n/in/body.go\nEND\nls /y.go", []string{"/tmp/out.txt", "/y.go"}},
		{"git commit -m \"fix: update README.md and foo/bar\"", nil},
		{"git commit -m '" + strings.Repeat("word /x/y ", 40) + "'", nil},
		{"git commit -m 'a\nb/c.go'", nil},
		{"FOO=/a/b make", []string{"/a/b"}},
		{"docker run -v /a:/b img", []string{"/a", "/b"}},
		{"PATH=/x/bin:/y/bin ls", []string{"/x/bin", "/y/bin"}},
		{"echo a:b host:/c", []string{"host:/c"}},
		{"sed -e 's|a|b|g' -e 's#x#y#' f.txt", []string{"f.txt"}},
		{"ls src/s.txt", []string{"src/s.txt"}},
		{"curl https://x.y/z.json", nil},
		{"git log --oneline -5", nil},
		{"echo v1.2.3", nil},
		{"echo 1.2.3 3.14", nil},
		{"ls -la ~/.claude/projects", []string{"~/.claude/projects"}},
		{"go build --out=bin/csb ./cmd/csb 2>/dev/null; cat a.txt | head", []string{"bin/csb", "./cmd/csb", "/dev/null", "a.txt"}},
		{"cp --to=/x/y a.txt a.txt", []string{"/x/y", "a.txt"}},
		{`grep -r 'foo bar' src/: ,`, []string{"src/"}},
		{`echo a\ b/c.go`, []string{"a b/c.go"}},
		{"make test", nil},
		{"", nil},
	} {
		if got := CmdPaths(tc.cmd); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("CmdPaths(%q) = %q, want %q", tc.cmd, got, tc.want)
		}
	}
	if got := CmdPaths(long); len(got) != maxCmdPaths {
		t.Errorf("cap: %d", len(got))
	}
}
