package sessions

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"regexp/syntax"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	searchMaxCalls    = 500
	searchHitsPerCall = 5
	searchMaxPerFile  = 1000 // matching lines counted per searched text (keeps "more" practically accurate)
	searchLineClip    = 400
	searchRgTimeout   = 10 * time.Second
)

// SearchQuery is one content search over a session's tool calls.
type SearchQuery struct {
	Q       string
	Engine  string // auto, rg, go; empty uses the configured default
	Case    string // smart (default), insensitive, sensitive
	Scope   string // both (default), input, output
	Literal bool
}

// SearchError is a bad query (empty, unknown option, invalid pattern, rg missing).
type SearchError struct{ Msg string }

func (e *SearchError) Error() string { return e.Msg }

func badQuery(format string, a ...any) error { return &SearchError{fmt.Sprintf(format, a...)} }

type SearchHit struct {
	Field  string   `json:"field"` // input or output
	Line   int      `json:"line"`
	Text   string   `json:"text"`
	Ranges [][2]int `json:"ranges"` // byte offsets into Text
}

type SearchCall struct {
	ToolID string      `json:"toolId"`
	Hits   []SearchHit `json:"hits"`
	More   int         `json:"more,omitempty"` // matching lines beyond the returned hits
}

type SearchResult struct {
	Engine     string       `json:"engine"`
	Calls      []SearchCall `json:"calls"`
	TotalCalls int          `json:"totalCalls"`
	Truncated  bool         `json:"truncated"`
}

// callText is the searchable text of one tool call.
type callText struct {
	id      string
	in, out string
}

// lineMatch is one matching line of a searched text.
type lineMatch struct {
	line   int
	text   string // without the line terminator
	ranges [][2]int
}

// fieldMatches holds the first searchHitsPerCall matching lines of one searched text and the
// total number of matching lines (up to searchMaxPerFile).
type fieldMatches struct {
	hits  []lineMatch
	total int
}

func (f *fieldMatches) add(lm lineMatch) {
	f.total++
	if len(f.hits) < searchHitsPerCall {
		f.hits = append(f.hits, lm)
	}
}

// Indexes into a call's [2]fieldMatches.
const (
	fieldIn  = 0
	fieldOut = 1
)

var fieldNames = [2]string{"input", "output"}

const multiLineMsg = "multi-line patterns aren't supported; searches match one line at a time"

var (
	rgOnce sync.Once
	rgPath string
)

// rgBinary returns the path of ripgrep, or "" when it is not on PATH.
func rgBinary() string {
	rgOnce.Do(func() { rgPath, _ = exec.LookPath("rg") })
	return rgPath
}

// Search looks for q in the full input and result text of every tool call of a session,
// including its subagents.
func (ix *Index) Search(ctx context.Context, sessionID string, q SearchQuery) (*SearchResult, error) {
	if q.Q == "" {
		return nil, badQuery("empty query")
	}
	if hasMultiLine(q.Q, q.Literal) {
		return nil, badQuery("%s", multiLineMsg)
	}
	engine := strings.ToLower(q.Engine)
	if engine == "" && ix.cfg != nil {
		engine = ix.cfg.Search.Engine
	}
	switch engine {
	case "", "auto":
		engine = "go"
		if rgBinary() != "" {
			engine = "rg"
		}
	case "rg":
		if rgBinary() == "" {
			return nil, badQuery("rg not found on PATH")
		}
	case "go":
	default:
		return nil, badQuery("unknown engine %q", q.Engine)
	}
	switch q.Case {
	case "":
		q.Case = "smart"
	case "smart", "insensitive", "sensitive":
	default:
		return nil, badQuery("unknown case mode %q", q.Case)
	}
	switch q.Scope {
	case "":
		q.Scope = "both"
	case "both", "input", "output":
	default:
		return nil, badQuery("unknown scope %q", q.Scope)
	}

	e := ix.lookup(sessionID)
	if e == nil || e.path == "" {
		return nil, os.ErrNotExist
	}
	calls, err := collectCalls(e.path, e.extra)
	if err != nil {
		return nil, err
	}

	var matches [][2]fieldMatches // per call: input, output
	if engine == "rg" {
		matches, err = searchRg(ctx, calls, q)
	} else {
		matches, err = searchGo(ctx, calls, q)
	}
	if err != nil {
		return nil, err
	}

	res := &SearchResult{Engine: engine, Calls: []SearchCall{}}
	for i, m := range matches {
		if m[fieldIn].total == 0 && m[fieldOut].total == 0 {
			continue
		}
		res.TotalCalls++
		if len(res.Calls) >= searchMaxCalls {
			res.Truncated = true
			continue
		}
		c := SearchCall{ToolID: calls[i].id, Hits: []SearchHit{}}
		total := 0
		for f, name := range fieldNames {
			total += m[f].total
			for _, lm := range m[f].hits {
				if len(c.Hits) < searchHitsPerCall {
					text, ranges := clipMatch(lm.text, lm.ranges)
					c.Hits = append(c.Hits, SearchHit{Field: name, Line: lm.line, Text: text, Ranges: ranges})
				}
			}
		}
		c.More = total - len(c.Hits)
		res.Calls = append(res.Calls, c)
	}
	return res, nil
}

// lookup finds the index entry for a session id (also matching "<source>/<id>" keys).
func (ix *Index) lookup(sessionID string) *entry {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	for k, v := range ix.entries {
		if k == sessionID || v.summary.ID == sessionID {
			return v
		}
	}
	return nil
}

// collectCalls reads the main transcript and the subagent transcripts (same file set as
// ToolCall) and returns every tool call, in file order, with its rendered input and result.
func collectCalls(path string, extra []string) ([]callText, error) {
	var calls []callText
	byID := map[string]int{}
	for _, f := range append([]string{path}, agentFiles(path, extra)...) {
		err := scanCalls(f, &calls, byID)
		if err != nil && f == path {
			return nil, err
		}
	}
	return calls, nil
}

func scanCalls(path string, calls *[]callText, byID map[string]int) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if bytes.Contains(line, []byte(`"tool_use"`)) || bytes.Contains(line, []byte(`"tool_result"`)) || bytes.Contains(line, []byte(`"server_tool_use"`)) {
			var rl rawLine
			var blocks []block
			if json.Unmarshal(line, &rl) == nil && rl.Message != nil && json.Unmarshal(rl.Message.Content, &blocks) == nil {
				for _, b := range blocks {
					switch b.Type {
					case "tool_use", "server_tool_use":
						if _, dup := byID[b.ID]; !dup && b.ID != "" {
							byID[b.ID] = len(*calls)
							*calls = append(*calls, callText{id: b.ID, in: renderInput(b.Input)})
						}
					case "tool_result":
						if i, ok := byID[b.ToolUseID]; ok && (*calls)[i].out == "" {
							(*calls)[i].out = blockContentText(b.Content)
						}
					}
				}
			}
		}
		if err != nil {
			if err == io.EOF {
				err = nil
			}
			return err
		}
	}
}

// renderInput renders a tool input object as "key: value" lines in transcript key order;
// string values are verbatim (real newlines), others compact JSON.
func renderInput(raw json.RawMessage) string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return string(raw)
	}
	var sb strings.Builder
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			break
		}
		key, _ := kt.(string)
		var v json.RawMessage
		if dec.Decode(&v) != nil {
			break
		}
		sb.WriteString(key)
		sb.WriteString(": ")
		var s string
		if len(v) > 0 && v[0] == '"' && json.Unmarshal(v, &s) == nil {
			sb.WriteString(s)
		} else {
			var cb bytes.Buffer
			if json.Compact(&cb, v) == nil {
				sb.Write(cb.Bytes())
			} else {
				sb.Write(v)
			}
		}
		sb.WriteByte('\n')
	}
	return sb.String()
}

// --- Go engine ---

func compileGo(q SearchQuery) (*regexp.Regexp, error) {
	pat := q.Q
	if q.Literal {
		pat = regexp.QuoteMeta(pat)
	}
	// Compile the user's pattern on its own first so errors never mention the injected (?i).
	re, err := regexp.Compile(pat)
	if err != nil {
		return nil, badQuery("%v", err)
	}
	if q.Case == "insensitive" || q.Case == "smart" && !hasUpper(q.Q, q.Literal) {
		if re, err = regexp.Compile("(?i)" + pat); err != nil {
			return nil, badQuery("%v", err)
		}
	}
	return re, nil
}

// hasMultiLine reports whether a pattern spans lines: a real newline, or (as a regex) an
// unescaped-backslash \n escape. Both engines search one line at a time.
func hasMultiLine(q string, literal bool) bool {
	if strings.ContainsAny(q, "\n\r") {
		return true
	}
	if literal {
		return false
	}
	for i := 0; i+1 < len(q); i++ {
		if q[i] == '\\' {
			if q[i+1] == 'n' || q[i+1] == 'r' {
				return true
			}
			i++
		}
	}
	return false
}

var posixClassRe = regexp.MustCompile(`\[:\^?[a-z]+:\]`)

// hasUpper reports whether a pattern has an uppercase letter that smart case should honour,
// like ripgrep: uppercase literals count; escapes such as \S, \p{Lu}, \w, POSIX classes
// ([[:upper:]]) and group names ((?P<N>x)) do not, while a plain ASCII class with uppercase
// ranges ([A-Z], [aA]) does. In literal mode the raw query is checked.
func hasUpper(q string, literal bool) bool {
	if literal {
		return strings.IndexFunc(q, unicode.IsUpper) >= 0
	}
	// ripgrep ignores POSIX classes ([[:upper:]]); Go expands them to ranges, so neutralize them.
	re, err := syntax.Parse(posixClassRe.ReplaceAllString(q, "[:digit:]"), syntax.Perl)
	if err != nil {
		return false
	}
	return nodeHasUpper(re)
}

func nodeHasUpper(re *syntax.Regexp) bool {
	switch re.Op {
	case syntax.OpLiteral:
		for _, r := range re.Rune {
			if unicode.IsUpper(r) {
				return true
			}
		}
	case syntax.OpCharClass:
		return classHasUpper(re.Rune)
	}
	for _, sub := range re.Sub {
		if nodeHasUpper(sub) {
			return true
		}
	}
	return false
}

// classHasUpper reports whether a character class (rune range pairs) is an explicit ASCII
// class with uppercase letters. Classes reaching beyond ASCII are negations or Unicode
// classes (\S, [^a], \pL), and \w is a builtin, so none of those count.
func classHasUpper(rs []rune) bool {
	upper := false
	for i := 0; i+1 < len(rs); i += 2 {
		lo, hi := rs[i], rs[i+1]
		if hi >= 0x80 {
			return false
		}
		if lo <= 'Z' && hi >= 'A' {
			upper = true
		}
	}
	if len(rs) == 8 && rs[0] == '0' && rs[1] == '9' && rs[2] == 'A' && rs[3] == 'Z' && rs[4] == '_' && rs[5] == '_' && rs[6] == 'a' && rs[7] == 'z' {
		return false // \w
	}
	return upper
}

func searchGo(ctx context.Context, calls []callText, q SearchQuery) ([][2]fieldMatches, error) {
	re, err := compileGo(q)
	if err != nil {
		return nil, err
	}
	out := make([][2]fieldMatches, len(calls))
	for i, c := range calls {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if q.Scope != "output" {
			grepLines(ctx, re, c.in, &out[i][fieldIn])
		}
		if q.Scope != "input" {
			grepLines(ctx, re, c.out, &out[i][fieldOut])
		}
	}
	return out, ctx.Err()
}

// grepLines counts up to searchMaxPerFile matching lines of text, keeping the first few.
func grepLines(ctx context.Context, re *regexp.Regexp, text string, fm *fieldMatches) {
	for n, line := 1, ""; text != "" && fm.total < searchMaxPerFile; n++ {
		if n%4096 == 0 && ctx.Err() != nil {
			return
		}
		line, text, _ = strings.Cut(text, "\n")
		line = strings.TrimSuffix(line, "\r")
		if locs := re.FindAllStringIndex(line, -1); len(locs) > 0 {
			lm := lineMatch{line: n, text: line}
			if fm.total < searchHitsPerCall {
				for _, l := range locs {
					lm.ranges = append(lm.ranges, [2]int{l[0], l[1]})
				}
			}
			fm.add(lm)
		}
	}
}

// --- ripgrep engine ---

func searchRg(ctx context.Context, calls []callText, q SearchQuery) ([][2]fieldMatches, error) {
	dir, err := os.MkdirTemp("", "csb-search-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	// Files are named by call index, never by tool id.
	wrote := false
	for i, c := range calls {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		for _, f := range []struct{ ext, text string }{{"in", c.in}, {"out", c.out}} {
			if f.text == "" || q.Scope == "input" && f.ext == "out" || q.Scope == "output" && f.ext == "in" {
				continue
			}
			if err := os.WriteFile(filepath.Join(dir, strconv.Itoa(i)+"."+f.ext), []byte(f.text), 0o600); err != nil {
				return nil, err
			}
			wrote = true
		}
	}
	out := make([][2]fieldMatches, len(calls))
	if !wrote {
		return out, nil
	}

	args := []string{"--json", "--no-config", "--no-ignore", "--hidden", "--text", "--crlf", "--max-count", strconv.Itoa(searchMaxPerFile)}
	if q.Literal {
		args = append(args, "-F")
	}
	switch q.Case {
	case "smart":
		args = append(args, "-S")
	case "insensitive":
		args = append(args, "-i")
	default:
		args = append(args, "-s")
	}
	args = append(args, "-e", q.Q, "--", dir)

	rctx, cancel := context.WithTimeout(ctx, searchRgTimeout)
	defer cancel()
	cmd := exec.CommandContext(rctx, rgBinary(), args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	type rgText struct {
		Text  string `json:"text"`
		Bytes string `json:"bytes"`
	}
	// Stream the JSON lines so a broad pattern never buffers rg's whole output.
	sawOutput := false
	r := bufio.NewReaderSize(stdout, 1<<20)
	for {
		l, rerr := r.ReadBytes('\n')
		if len(l) > 0 {
			sawOutput = true
			var ev struct {
				Type string `json:"type"`
				Data struct {
					Path       rgText `json:"path"`
					Lines      rgText `json:"lines"`
					LineNumber int    `json:"line_number"`
					Submatches []struct {
						Start int `json:"start"`
						End   int `json:"end"`
					} `json:"submatches"`
				} `json:"data"`
			}
			if json.Unmarshal(l, &ev) == nil && ev.Type == "match" {
				rgAddMatch(out, calls, ev.Data.Path.Text, ev.Data.Lines.Text, ev.Data.Lines.Bytes, ev.Data.LineNumber, func(i int) [2]int {
					return [2]int{ev.Data.Submatches[i].Start, ev.Data.Submatches[i].End}
				}, len(ev.Data.Submatches))
			}
		}
		if rerr != nil {
			break
		}
	}
	werr := cmd.Wait()
	if rctx.Err() != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, badQuery("search timed out")
	}
	if werr != nil {
		var ee *exec.ExitError
		switch {
		case errors.As(werr, &ee) && ee.ExitCode() == 1:
			return out, nil // no matches
		case errors.As(werr, &ee) && ee.ExitCode() == 2 && !sawOutput:
			return nil, badQuery("%s", strings.TrimSpace(stderr.String()))
		case errors.As(werr, &ee) && ee.ExitCode() == 2:
			// partial results with a non-fatal error: use what rg found
		default:
			return nil, werr
		}
	}
	return out, nil
}

// rgAddMatch records one rg "match" event into out.
func rgAddMatch(out [][2]fieldMatches, calls []callText, path, text, textBytes string, line int, submatch func(int) [2]int, nsub int) {
	name := filepath.Base(path)
	ext := filepath.Ext(name)
	n, err := strconv.Atoi(strings.TrimSuffix(name, ext))
	if err != nil || n < 0 || n >= len(calls) {
		return
	}
	field := fieldIn
	if ext == ".out" {
		field = fieldOut
	}
	fm := &out[n][field]
	if len(fm.hits) >= searchHitsPerCall {
		fm.total++ // only the count matters past the hits we return
		return
	}
	if text == "" && textBytes != "" {
		b, _ := base64.StdEncoding.DecodeString(textBytes)
		text = string(b)
	}
	text = strings.TrimSuffix(strings.TrimSuffix(text, "\n"), "\r")
	lm := lineMatch{line: line, text: text}
	for i := 0; i < nsub; i++ {
		r := submatch(i)
		lm.ranges = append(lm.ranges, [2]int{min(r[0], len(text)), min(r[1], len(text))})
	}
	fm.add(lm)
}

// clipMatch clips a long line to searchLineClip bytes on UTF-8 boundaries, centring on
// the first match when it lies beyond the window, and shifts the ranges to match.
func clipMatch(text string, ranges [][2]int) (string, [][2]int) {
	start, end := 0, len(text)
	if len(text) > searchLineClip {
		end = searchLineClip
		if len(ranges) > 0 && ranges[0][0] >= searchLineClip {
			start = ranges[0][0] - searchLineClip/2
			end = start + searchLineClip
			if end > len(text) {
				end = len(text)
				start = max(0, end-searchLineClip)
			}
		}
		for start < len(text) && !utf8.RuneStart(text[start]) {
			start++
		}
		for end < len(text) && !utf8.RuneStart(text[end]) {
			end--
		}
	}
	out := [][2]int{}
	for _, r := range ranges {
		s, e := max(r[0]-start, 0), min(r[1]-start, end-start)
		if e < 0 || s > end-start || s == e && r[0] != r[1] {
			continue
		}
		out = append(out, [2]int{s, max(s, e)})
	}
	return text[start:end], out
}
