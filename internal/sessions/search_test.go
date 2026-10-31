package sessions

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/bdrennan/claude-session-browser/internal/config"
)

// searchIndex builds an index over a one-session corpus with a subagent.
func searchIndex(t *testing.T) *Index {
	t.Helper()
	dir := t.TempDir()
	main := filepath.Join(dir, "s1.jsonl")
	write(t, main, jl(t,
		toolUse(1, "u1", "toolu_a", "Bash", m{"command": "go test ./...\necho Done", "description": "run tests"}),
		toolResult(2, "u2", "toolu_a", "ok  \tpkg\nFAIL: TestFoo\nline three\r\nFoo again"),
		toolUse(3, "u3", "toolu_b", "Write", m{"file_path": "/x/notes.md", "content": "alpha\nbeta needle\ngamma"}),
		toolResult(4, "u4", "toolu_b", "wrote file"),
		toolUse(5, "u5", "toolu_c", "Read", m{"file_path": "/x/other.go", "limit": 20}),
		toolResult(6, "u6", "toolu_c", "héllo wörld needle ünïcode"),
	))
	write(t, filepath.Join(dir, "s1", "subagents", "agent-ag1.jsonl"), jl(t,
		toolUse(7, "s1", "toolu_sub", "Grep", m{"pattern": "needle"}),
		toolResult(8, "s2", "toolu_sub", "sub needle result"),
	))
	cfg := config.Default()
	return &Index{cfg: cfg, parser: &Parser{}, entries: map[string]*entry{"s1": {path: main, summary: Summary{ID: "s1"}}}}
}

func engines(t *testing.T) []string {
	if rgBinary() == "" {
		t.Log("rg not installed; skipping rg engine")
		return []string{"go"}
	}
	return []string{"go", "rg"}
}

func search(t *testing.T, ix *Index, q SearchQuery) *SearchResult {
	t.Helper()
	r, err := ix.Search(context.Background(), "s1", q)
	if err != nil {
		t.Fatalf("%+v: %v", q, err)
	}
	return r
}

func ids(r *SearchResult) []string {
	out := []string{}
	for _, c := range r.Calls {
		out = append(out, c.ToolID)
	}
	return out
}

func TestSearchEnginesAgree(t *testing.T) {
	ix := searchIndex(t)
	for _, q := range []SearchQuery{
		{Q: "needle"}, {Q: "foo"}, {Q: "Foo"}, {Q: "t.*e", Case: "sensitive"}, {Q: "ü", Case: "insensitive"},
		{Q: "need|alpha"}, {Q: "x", Scope: "output"}, {Q: "x", Scope: "input"}, {Q: "a.b", Literal: true}, {Q: "zzz"},
	} {
		var results []*SearchResult
		for _, e := range engines(t) {
			q.Engine = e
			r := search(t, ix, q)
			if r.Engine != e {
				t.Fatalf("engine %q reported %q", e, r.Engine)
			}
			r.Engine = ""
			results = append(results, r)
		}
		for _, r := range results[1:] {
			if !reflect.DeepEqual(results[0], r) {
				a, _ := json.Marshal(results[0])
				b, _ := json.Marshal(r)
				t.Errorf("%+v differ:\n go: %s\n rg: %s", q, a, b)
			}
		}
	}
}

func TestSearchBehaviour(t *testing.T) {
	ix := searchIndex(t)
	for _, e := range engines(t) {
		t.Run(e, func(t *testing.T) {
			q := func(q SearchQuery) *SearchResult { q.Engine = e; return search(t, ix, q) }

			// Smart case: lower-case is insensitive, an upper-case letter makes it sensitive.
			if got := ids(q(SearchQuery{Q: "foo"})); !reflect.DeepEqual(got, []string{"toolu_a"}) {
				t.Errorf("smart insensitive: %v", got)
			}
			r := q(SearchQuery{Q: "Foo"})
			if len(r.Calls) != 1 || len(r.Calls[0].Hits) != 2 { // "FAIL: TestFoo" and "Foo again"
				t.Errorf("smart sensitive: %+v", r)
			}
			if got := ids(q(SearchQuery{Q: "foo", Case: "sensitive"})); len(got) != 0 {
				t.Errorf("sensitive: %v", got)
			}
			if got := ids(q(SearchQuery{Q: "FOO", Case: "insensitive"})); len(got) != 1 {
				t.Errorf("insensitive: %v", got)
			}
			// \S is not an upper-case letter in a regex, so the search stays insensitive.
			if got := ids(q(SearchQuery{Q: `\Sfoo`})); len(got) != 1 {
				t.Errorf(`smart with \S: %v`, got)
			}

			// Literal.
			if got := ids(q(SearchQuery{Q: "./...", Literal: true})); !reflect.DeepEqual(got, []string{"toolu_a"}) {
				t.Errorf("literal: %v", got)
			}
			if got := ids(q(SearchQuery{Q: "t.st"})); len(got) < 1 {
				t.Errorf("regex dot: %v", got)
			}
			if got := ids(q(SearchQuery{Q: "t.st", Literal: true})); len(got) != 0 {
				t.Errorf("literal dot: %v", got)
			}

			// Scope.
			if r := q(SearchQuery{Q: "needle", Scope: "input"}); !reflect.DeepEqual(ids(r), []string{"toolu_b", "toolu_sub"}) {
				t.Errorf("scope input: %v", ids(r))
			}
			if r := q(SearchQuery{Q: "needle", Scope: "output"}); !reflect.DeepEqual(ids(r), []string{"toolu_c", "toolu_sub"}) {
				t.Errorf("scope output: %v", ids(r))
			}
			r = q(SearchQuery{Q: "needle"})
			if !reflect.DeepEqual(ids(r), []string{"toolu_b", "toolu_c", "toolu_sub"}) || r.TotalCalls != 3 || r.Truncated {
				t.Errorf("both + subagent: %+v", r)
			}

			// Multi-line output: line numbers and CRLF stripping.
			r = q(SearchQuery{Q: "again|three", Scope: "output"})
			h := r.Calls[0].Hits
			if len(h) != 2 || h[0].Line != 3 || h[0].Text != "line three" || h[1].Line != 4 || h[1].Field != "output" {
				t.Errorf("multi-line: %+v", h)
			}

			// Input is rendered with real newlines: "^echo" matches the second line of the command,
			// and "test ./...$" would only match if \n were not the raw JSON escape.
			r = q(SearchQuery{Q: `^echo Done$`, Scope: "input"})
			if len(r.Calls) != 1 || r.Calls[0].Hits[0].Line != 2 || r.Calls[0].Hits[0].Text != "echo Done" {
				t.Errorf("input newline: %+v", r)
			}
			if r = q(SearchQuery{Q: `\\n`, Scope: "input", Literal: false}); len(r.Calls) != 0 {
				t.Errorf("raw JSON escape visible: %+v", r)
			}
			// Key order and key: value rendering.
			r = q(SearchQuery{Q: `^limit: 20$`, Scope: "input"})
			if len(r.Calls) != 1 || r.Calls[0].ToolID != "toolu_c" || r.Calls[0].Hits[0].Line != 2 {
				t.Errorf("non-string value: %+v", r)
			}

			// Byte offsets into UTF-8 text.
			r = q(SearchQuery{Q: "needle", Scope: "output"})
			var hit SearchHit
			for _, c := range r.Calls {
				if c.ToolID == "toolu_c" {
					hit = c.Hits[0]
				}
			}
			rg := hit.Ranges[0]
			if hit.Text[rg[0]:rg[1]] != "needle" {
				t.Errorf("ranges: %+v", hit)
			}

			// Errors.
			if _, err := ix.Search(context.Background(), "s1", SearchQuery{Q: "(", Engine: e}); err == nil {
				t.Error("bad regex accepted")
			} else if se := (*SearchError)(nil); !errors.As(err, &se) {
				t.Errorf("bad regex error type %T", err)
			}
			if _, err := ix.Search(context.Background(), "s1", SearchQuery{Q: "", Engine: e}); err == nil {
				t.Error("empty query accepted")
			}
			if _, err := ix.Search(context.Background(), "nope", SearchQuery{Q: "x", Engine: e}); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("unknown session: %v", err)
			}
			// No matches (rg exit 1) is an empty result, not an error.
			r = q(SearchQuery{Q: "qqqqqq"})
			if r.TotalCalls != 0 || r.Calls == nil || len(r.Calls) != 0 {
				t.Errorf("no match: %+v", r)
			}
		})
	}
}

func TestSearchLimits(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "s1.jsonl")
	var lines []any
	lines = append(lines, toolUse(1, "u0", "toolu_many", "Bash", m{"command": "x"}),
		toolResult(2, "r0", "toolu_many", strings.Repeat("hit line\n", 30)))
	long := strings.Repeat("a", 1000) + "TARGET" + strings.Repeat("é", 300)
	lines = append(lines, toolUse(3, "u1", "toolu_long", "Bash", m{"command": "y"}), toolResult(4, "r1", "toolu_long", long))
	write(t, main, jl(t, lines...))
	ix := &Index{cfg: config.Default(), parser: &Parser{}, entries: map[string]*entry{"s1": {path: main, summary: Summary{ID: "s1"}}}}
	for _, e := range engines(t) {
		r, err := ix.Search(context.Background(), "s1", SearchQuery{Q: "hit line|TARGET", Engine: e, Scope: "output", Case: "sensitive"})
		if err != nil {
			t.Fatal(err)
		}
		c := r.Calls[0]
		if len(c.Hits) != 5 || c.More != 25 {
			t.Errorf("%s hits %d more %d", e, len(c.Hits), c.More)
		}
		h := r.Calls[1].Hits[0]
		if len(h.Text) > 400 || !strings.Contains(h.Text, "TARGET") || h.Text[h.Ranges[0][0]:h.Ranges[0][1]] != "TARGET" {
			t.Errorf("%s clipped: len %d ranges %v", e, len(h.Text), h.Ranges)
		}
		if !strings.HasSuffix(h.Text, "é") && strings.ContainsRune(h.Text, '�') {
			t.Errorf("%s split a rune", e)
		}
	}
}

func TestClipMatch(t *testing.T) {
	text := strings.Repeat("é", 500) // 1000 bytes
	got, ranges := clipMatch(text, [][2]int{{600, 602}, {990, 992}})
	if len(got) > searchLineClip || strings.ContainsRune(got, '�') {
		t.Fatalf("len %d", len(got))
	}
	if len(ranges) == 0 || got[ranges[0][0]:ranges[0][1]] != "é" {
		t.Fatalf("ranges %v", ranges)
	}
	short, r := clipMatch("abc", [][2]int{{1, 2}})
	if short != "abc" || !reflect.DeepEqual(r, [][2]int{{1, 2}}) {
		t.Fatalf("%q %v", short, r)
	}
}

func TestSearchEngineSelection(t *testing.T) {
	ix := searchIndex(t)
	ix.cfg.Search.Engine = "go"
	if r := search(t, ix, SearchQuery{Q: "needle"}); r.Engine != "go" {
		t.Fatalf("config default ignored: %s", r.Engine)
	}
	if rgBinary() != "" {
		if r := search(t, ix, SearchQuery{Q: "needle", Engine: "auto"}); r.Engine != "rg" {
			t.Fatalf("auto: %s", r.Engine)
		}
	}
	if _, err := ix.Search(context.Background(), "s1", SearchQuery{Q: "x", Engine: "bogus"}); err == nil {
		t.Fatal("bogus engine accepted")
	}
}

// corpusIndex builds a session with one call whose output is text.
func corpusIndex(t *testing.T, text string) *Index {
	t.Helper()
	dir := t.TempDir()
	main := filepath.Join(dir, "s1.jsonl")
	write(t, main, jl(t, toolUse(1, "u1", "toolu_x", "Bash", m{"command": "x"}), toolResult(2, "r1", "toolu_x", text)))
	return &Index{cfg: config.Default(), parser: &Parser{}, entries: map[string]*entry{"s1": {path: main, summary: Summary{ID: "s1"}}}}
}

func hitLines(r *SearchResult) []int {
	var out []int
	for _, c := range r.Calls {
		for _, h := range c.Hits {
			out = append(out, h.Line)
		}
	}
	return out
}

func TestSearchSmartCaseParity(t *testing.T) {
	ix := corpusIndex(t, "ax\naX\nAx\nAX\nfoo\nFoo\nbx\nbX")
	for _, tc := range []struct {
		q     string
		upper bool
	}{
		{`ax`, false}, {`Ax`, true}, {`Foo`, true}, {`\Sx`, false}, {`\wx`, false}, {`\Wx`, false},
		{`(?P<N>x)`, false}, {`(?P<n>X)`, true}, {`[[:upper:]]x`, false}, {`[aA]x`, true}, {`\p{Lu}x`, false}, {`[A-Z]x`, true},
		{`[^a]x`, false}, {`\pLx`, false}, {`a|B`, true}, {`\x41x`, true},
	} {
		if got := hasUpper(tc.q, false); got != tc.upper {
			t.Errorf("hasUpper(%q) = %v, want %v", tc.q, got, tc.upper)
		}
		var first []int
		for i, e := range engines(t) {
			r, err := ix.Search(context.Background(), "s1", SearchQuery{Q: tc.q, Engine: e})
			if err != nil {
				t.Fatalf("%s %q: %v", e, tc.q, err)
			}
			if i == 0 {
				first = hitLines(r)
			} else if !reflect.DeepEqual(first, hitLines(r)) {
				t.Errorf("%q: go %v vs %s %v", tc.q, first, e, hitLines(r))
			}
		}
	}
	if !hasUpper("Foo", true) || hasUpper(`foo\S`, true) == false {
		t.Error("literal smart case checks the raw query")
	}
}

func TestSearchMultiLineAndCRLF(t *testing.T) {
	ix := corpusIndex(t, "foo\r\nbar\r\nlast foo")
	for _, e := range engines(t) {
		for _, q := range []SearchQuery{{Q: "foo\nbar"}, {Q: `foo\nbar`}, {Q: "foo\nbar", Literal: true}} {
			q.Engine = e
			_, err := ix.Search(context.Background(), "s1", q)
			var se *SearchError
			if !errors.As(err, &se) || se.Msg != multiLineMsg {
				t.Errorf("%s %q: %v", e, q.Q, err)
			}
		}
		// A literal backslash-n is not a newline.
		if _, err := ix.Search(context.Background(), "s1", SearchQuery{Q: `foo\nbar`, Literal: true, Engine: e}); err != nil {
			t.Errorf("%s literal backslash-n: %v", e, err)
		}
		r, err := ix.Search(context.Background(), "s1", SearchQuery{Q: `foo$`, Engine: e})
		if err != nil || !reflect.DeepEqual(hitLines(r), []int{1, 3}) {
			t.Errorf("%s foo$ on CRLF text: %v %v", e, hitLines(r), err)
		}
		_, err = ix.Search(context.Background(), "s1", SearchQuery{Q: "(", Engine: e})
		if err == nil || strings.Contains(err.Error(), "(?i)") {
			t.Errorf("%s bad regex error leaks the prefix: %v", e, err)
		}
	}
}

func TestSearchMatchCapAndCancel(t *testing.T) {
	ix := corpusIndex(t, strings.Repeat("hit\n", 1500))
	for _, e := range engines(t) {
		r, err := ix.Search(context.Background(), "s1", SearchQuery{Q: "hit", Engine: e})
		if err != nil {
			t.Fatal(err)
		}
		if c := r.Calls[0]; len(c.Hits) != searchHitsPerCall || c.More != searchMaxPerFile-searchHitsPerCall {
			t.Errorf("%s hits %d more %d", e, len(c.Hits), c.More)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := ix.Search(ctx, "s1", SearchQuery{Q: "hit", Engine: e}); !errors.Is(err, context.Canceled) {
			t.Errorf("%s canceled search: %v", e, err)
		}
	}
}
