// Package export copies a person's Claude Code transcripts into a shared team
// folder (<dest>/<name>/projects/...) that the browser reads via team_dirs.
package export

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Options struct {
	ClaudeDir string   // usually ~/.claude
	Dest      string   // team folder
	Name      string   // person's folder name inside Dest
	Redact    bool     // strip prompts, responses and tool I/O; keep structure and usage
	Exclude   []string // globs matched against project folder names (e.g. "*secret*")
}

type Report struct {
	Copied    int   `yaml:"copied"`
	Unchanged int   `yaml:"unchanged"`
	Excluded  int   `yaml:"excluded"`
	Bytes     int64 `yaml:"bytes"`
}

type manifest struct {
	Name       string    `yaml:"name"`
	Host       string    `yaml:"host"`
	ExportedAt time.Time `yaml:"exported_at"`
	Redacted   bool      `yaml:"redacted"`
	Report     Report    `yaml:"last_run"`
}

// Run copies new or changed transcript files. A file is unchanged when the
// destination's mtime equals the source's (copies are stamped with the source mtime).
func Run(o Options) (Report, error) {
	var rep Report
	if o.Name == "" || strings.ContainsAny(o.Name, `/\`) {
		return rep, fmt.Errorf("export: invalid name %q", o.Name)
	}
	src := filepath.Join(o.ClaudeDir, "projects")
	root := filepath.Join(o.Dest, o.Name)
	// Switching between redacted and full exports must rewrite every file.
	prev := readManifest(root)
	force := prev != nil && prev.Redacted != o.Redact

	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		if d.IsDir() {
			if rel != "." && !strings.Contains(rel, string(filepath.Separator)) && excluded(d.Name(), o.Exclude) {
				rep.Excluded++
				return filepath.SkipDir
			}
			// Only transcripts and subagent metadata are exported (not memory/, tool-results/, …).
			if base := d.Name(); base == "memory" || base == "tool-results" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".jsonl") && !strings.HasSuffix(path, ".meta.json") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		dst := filepath.Join(root, "projects", rel)
		if di, err := os.Stat(dst); err == nil && !force && di.ModTime().Equal(info.ModTime()) {
			rep.Unchanged++
			return nil
		}
		n, err := copyFile(path, dst, o.Redact && strings.HasSuffix(path, ".jsonl"))
		if err != nil {
			return fmt.Errorf("%s: %w", rel, err)
		}
		rep.Copied++
		rep.Bytes += n
		return os.Chtimes(dst, info.ModTime(), info.ModTime())
	})
	if err != nil {
		return rep, err
	}
	host, _ := os.Hostname()
	b, _ := yaml.Marshal(manifest{Name: o.Name, Host: host, ExportedAt: time.Now().UTC(), Redacted: o.Redact, Report: rep})
	return rep, os.WriteFile(filepath.Join(root, "export.yml"), b, 0o644)
}

func readManifest(root string) *manifest {
	b, err := os.ReadFile(filepath.Join(root, "export.yml"))
	if err != nil {
		return nil
	}
	var m manifest
	if yaml.Unmarshal(b, &m) != nil {
		return nil
	}
	return &m
}

func excluded(name string, globs []string) bool {
	for _, g := range globs {
		if ok, _ := filepath.Match(g, name); ok {
			return true
		}
	}
	return false
}

func copyFile(src, dst string, redact bool) (int64, error) {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return 0, err
	}
	in, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return 0, err
	}
	var n int64
	if redact {
		n, err = redactStream(in, out)
	} else {
		n, err = io.Copy(out, in)
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return 0, err
	}
	return n, os.Rename(tmp, dst)
}

// Redaction is allowlist-based so fields added by future Claude Code versions are
// dropped by default. Only these line types are kept…
var keptTypes = map[string]bool{"user": true, "assistant": true, "attachment": true, "system": true, "ai-title": true, "custom-title": true, "summary": true}

// …with only these top-level fields (message, content, attachment and
// toolUseResult are rebuilt below).
var keptKeys = map[string]bool{
	"type": true, "uuid": true, "parentUuid": true, "timestamp": true, "sessionId": true, "agentId": true,
	"isSidechain": true, "isMeta": true, "isCompactSummary": true, "isApiErrorMessage": true, "cwd": true,
	"gitBranch": true, "version": true, "entrypoint": true, "subtype": true, "userType": true,
	"aiTitle": true, "customTitle": true, "summary": true, "requestId": true,
}

var keptMessageKeys = map[string]bool{"id": true, "role": true, "model": true, "usage": true, "stop_reason": true, "type": true}

// Tool input keys kept in redacted exports: enough to attribute skills, agents and memory files.
var keptInputKeys = map[string]bool{"skill": true, "subagent_type": true, "description": true, "model": true, "run_in_background": true, "file_path": true}

func redactStream(r io.Reader, w io.Writer) (int64, error) {
	br := bufio.NewReaderSize(r, 1<<20)
	bw := bufio.NewWriter(w)
	var n int64
	for {
		line, err := br.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var m map[string]any
			if json.Unmarshal(line, &m) == nil {
				if typ, _ := m["type"].(string); keptTypes[typ] {
					b, _ := json.Marshal(redactLine(m))
					k, werr := bw.Write(append(b, '\n'))
					n += int64(k)
					if werr != nil {
						return n, werr
					}
				}
			}
		}
		if err == io.EOF {
			return n, bw.Flush()
		}
		if err != nil {
			return n, err
		}
	}
}

func redactLine(m map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		if keptKeys[k] {
			out[k] = v
		}
	}
	if c, ok := m["content"].(string); ok {
		out["content"] = placeholder(c)
	}
	if att, ok := m["attachment"].(map[string]any); ok {
		out["attachment"] = map[string]any{"type": att["type"]}
	}
	// Keep the subagent id an Agent call returned, so agents stay linked.
	if tur, ok := m["toolUseResult"].(map[string]any); ok && tur["agentId"] != nil {
		out["toolUseResult"] = map[string]any{"agentId": tur["agentId"]}
	}
	msg, ok := m["message"].(map[string]any)
	if !ok {
		return out
	}
	rm := map[string]any{}
	for k, v := range msg {
		if keptMessageKeys[k] {
			rm[k] = v
		}
	}
	out["message"] = rm
	switch c := msg["content"].(type) {
	case string:
		rm["content"] = placeholder(c)
	case []any:
		blocks := make([]any, 0, len(c))
		for _, raw := range c {
			b, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			kept := map[string]any{}
			for _, k := range []string{"type", "id", "name", "tool_use_id", "is_error"} {
				if v, ok := b[k]; ok {
					kept[k] = v
				}
			}
			switch b["type"] {
			case "text":
				kept["text"] = placeholder(fmt.Sprint(b["text"]))
			case "thinking":
				kept["thinking"] = ""
			case "tool_use", "server_tool_use":
				in := map[string]any{}
				if src, ok := b["input"].(map[string]any); ok {
					for k, v := range src {
						if keptInputKeys[k] {
							in[k] = v
						}
					}
				}
				kept["input"] = in
			case "tool_result":
				b2, _ := json.Marshal(b["content"])
				kept["content"] = placeholder(string(b2))
			}
			blocks = append(blocks, kept)
		}
		rm["content"] = blocks
	}
	return out
}

func placeholder(s string) string {
	// Keep slash commands and interruption markers: they carry no content but drive metrics.
	t := strings.TrimSpace(s)
	if strings.HasPrefix(t, "<command-name>") || strings.HasPrefix(t, "[Request interrupted") {
		if i := strings.Index(t, "<command-args>"); i > 0 {
			return t[:i]
		}
		return t
	}
	return fmt.Sprintf("[redacted %d chars]", len(s))
}
