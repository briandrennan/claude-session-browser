package sessions

import (
	"encoding/json"
	"regexp"
	"strings"
)

const maxCmdPaths = 64

// inputPaths returns the file paths named by a tool input (file_path, notebook_path, path).
func inputPaths(input json.RawMessage) []string {
	var in map[string]any
	if json.Unmarshal(input, &in) != nil {
		return nil
	}
	var out []string
	for _, k := range []string{"file_path", "notebook_path", "path"} {
		if v, ok := in[k].(string); ok && v != "" && !contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}

// bashPaths returns the path-like words of a Bash tool input's command.
func bashPaths(input json.RawMessage) []string {
	var in struct {
		Command string `json:"command"`
	}
	if json.Unmarshal(input, &in) != nil {
		return nil
	}
	return CmdPaths(in.Command)
}

var (
	fileWordRe = regexp.MustCompile(`^[\w.@~+-]*\.[A-Za-z0-9]{1,8}$`)
	versionRe  = regexp.MustCompile(`^v?[\d.]+$`)
	envAssign  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	extSuffix  = regexp.MustCompile(`\.[A-Za-z0-9]{1,8}$`)
)

const maxWordLen = 256

// shellWord is one word of a command; quoted is set when any part of it was quoted.
type shellWord struct {
	s      string
	quoted bool
}

// CmdPaths extracts path-like words from a shell command: words containing a slash, or
// filenames with an extension. It is a heuristic, not a shell parser; URLs, options,
// numbers, version strings, heredoc bodies, sed expressions, over-long words and prose
// (quoted words with spaces that don't end in a path-like segment) are skipped.
func CmdPaths(cmd string) []string {
	var out []string
	for _, sw := range shellWords(cmd) {
		w := sw.s
		if len(w) > maxWordLen || strings.ContainsAny(w, "\n\r") {
			continue
		}
		if strings.HasPrefix(w, "-") {
			// --flag=value: keep the value.
			i := strings.IndexByte(w, '=')
			if !strings.HasPrefix(w, "--") || i < 0 {
				continue
			}
			w = w[i+1:]
		} else if loc := envAssign.FindStringIndex(w); loc != nil {
			w = w[loc[1]:] // FOO=/a/b make
		}
		w = strings.TrimRight(w, ":,")
		if sw.quoted && strings.ContainsAny(w, " \t") && !proseFree(w) {
			continue
		}
		for _, p := range splitColonPaths(w) {
			if p == "" || strings.HasPrefix(p, "-") || strings.Contains(p, "://") || versionRe.MatchString(p) || isSedExpr(p) {
				continue
			}
			if !strings.Contains(p, "/") && !fileWordRe.MatchString(p) {
				continue
			}
			if !contains(out, p) {
				out = append(out, p)
				if len(out) == maxCmdPaths {
					return out
				}
			}
		}
	}
	return out
}

func hasPathStart(w string) bool {
	return strings.HasPrefix(w, "/") || strings.HasPrefix(w, "./") || strings.HasPrefix(w, "../") || strings.HasPrefix(w, "~")
}

// proseFree reports whether a quoted word containing whitespace still looks like a path: its
// final segment has no whitespace and either carries an extension or the word starts like a path.
func proseFree(w string) bool {
	last := w[strings.LastIndexByte(w, '/')+1:]
	if strings.ContainsAny(last, " \t") {
		return false
	}
	return extSuffix.MatchString(last) || hasPathStart(w)
}

// splitColonPaths splits "a:b" (PATH lists, docker -v /a:/b) when every side starts like a path.
func splitColonPaths(w string) []string {
	if !strings.Contains(w, ":") || strings.Contains(w, "://") {
		return []string{w}
	}
	parts := strings.Split(w, ":")
	for _, p := range parts {
		if !hasPathStart(p) {
			return []string{w}
		}
	}
	return parts
}

// isSedExpr matches sed substitutions such as s/a/b/g, i.e. ^s(.).*\1.*\1[a-zA-Z]*$ (RE2 has no
// backreferences). The delimiter must be punctuation so that words like "src" are not caught.
func isSedExpr(w string) bool {
	if len(w) < 4 || w[0] != 's' {
		return false
	}
	d := w[1]
	if d >= 0x80 || d == ' ' || d >= '0' && d <= '9' || d >= 'a' && d <= 'z' || d >= 'A' && d <= 'Z' {
		return false
	}
	last := strings.LastIndexByte(w, d)
	if last < 3 || !strings.ContainsRune(w[2:last], rune(d)) {
		return false
	}
	for _, c := range w[last+1:] {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
			return false
		}
	}
	return true
}

// shellWords splits cmd into words, honouring quotes and backslash escapes, and
// treating command separators and redirections (; & | < > and parentheses) as breaks.
// Heredoc bodies (<<EOF ... EOF) are skipped.
func shellWords(cmd string) []shellWord {
	var words []shellWord
	var cur strings.Builder
	has, quoted := false, false
	flush := func() {
		if has {
			words = append(words, shellWord{cur.String(), quoted})
		}
		cur.Reset()
		has, quoted = false, false
	}
	type heredoc struct {
		delim string
		dash  bool
	}
	var pending []heredoc
	rs := []rune(cmd)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		switch {
		case c == '\\' && i+1 < len(rs):
			i++
			if rs[i] != '\n' { // line continuation
				cur.WriteRune(rs[i])
				has = true
			}
		case c == '\'':
			has, quoted = true, true
			for i++; i < len(rs) && rs[i] != '\''; i++ {
				cur.WriteRune(rs[i])
			}
		case c == '"':
			has, quoted = true, true
			for i++; i < len(rs) && rs[i] != '"'; i++ {
				if rs[i] == '\\' && i+1 < len(rs) && strings.ContainsRune("\"\\$`", rs[i+1]) {
					i++
				}
				cur.WriteRune(rs[i])
			}
		case c == '<' && i+1 < len(rs) && rs[i+1] == '<' && !(i+2 < len(rs) && rs[i+2] == '<'):
			flush()
			i += 2
			h := heredoc{}
			if i < len(rs) && rs[i] == '-' {
				h.dash = true
				i++
			}
			for i < len(rs) && (rs[i] == ' ' || rs[i] == '\t') {
				i++
			}
			var d strings.Builder
			for ; i < len(rs) && !strings.ContainsRune(" \t\n;&|<>()", rs[i]); i++ {
				if !strings.ContainsRune("'\"\\", rs[i]) {
					d.WriteRune(rs[i])
				}
			}
			i-- // the loop increments past the delimiter
			if d.Len() > 0 {
				h.delim = d.String()
				pending = append(pending, h)
			}
		case c == '\n':
			flush()
			for _, h := range pending {
				// Skip body lines up to and including the terminator.
				for i++; i < len(rs); {
					end := i
					for end < len(rs) && rs[end] != '\n' {
						end++
					}
					line := string(rs[i:end])
					if h.dash {
						line = strings.TrimLeft(line, "\t")
					}
					i = end + 1
					if line == h.delim {
						break
					}
				}
				i-- // point at the newline that ended the terminator line
			}
			pending = nil
		case c == ' ' || c == '\t' || c == '\r' || strings.ContainsRune(";&|<>()", c):
			flush()
		default:
			cur.WriteRune(c)
			has = true
		}
	}
	flush()
	return words
}
