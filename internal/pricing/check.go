package pricing

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// PageURL is the markdown rendering of Anthropic's pricing page.
const PageURL = "https://platform.claude.com/docs/en/about-claude/pricing.md"

// Change is a difference between the pricing page and the table's current rows.
type Change struct {
	Kind  string `json:"kind"` // "changed" or "new"
	Match string `json:"match"`
	Label string `json:"label"`
	Old   *Row   `json:"old,omitempty"`
	New   Row    `json:"new"`
}

// CheckResult is the outcome of comparing the live page with the table.
type CheckResult struct {
	CheckedAt time.Time `json:"checkedAt"`
	Changes   []Change  `json:"changes"`
	Error     string    `json:"error,omitempty"`
}

var (
	reLink  = regexp.MustCompile(`\(\[[^\]]*\]\([^)]*\)\)|<sup>[^<]*</sup>`)
	rePrice = regexp.MustCompile(`\$([0-9.]+)`)
	reModel = regexp.MustCompile(`^Claude (\w+) ([0-9.]+)(?: \(for prompts (up to|over) ([0-9,]+) tokens\))?$`)
)

// Check fetches the pricing page and reports rows that differ from the prices
// currently in effect.
func (t *Table) Check(ctx context.Context) CheckResult {
	res := CheckResult{CheckedAt: time.Now().UTC(), Changes: []Change{}}
	page, err := fetch(ctx, PageURL)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	rows, err := ParsePage(page)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	for _, nr := range rows {
		cur := t.current(nr.Match)
		switch {
		case cur == nil:
			res.Changes = append(res.Changes, Change{Kind: "new", Match: nr.Match, Label: nr.Label, New: nr})
		case !samePrices(cur, &nr):
			c := *cur
			res.Changes = append(res.Changes, Change{Kind: "changed", Match: nr.Match, Label: cur.Label, Old: &c, New: nr})
		}
	}
	return res
}

// current returns the newest row whose Match equals match exactly.
func (t *Table) current(match string) *Row {
	for i := range t.Models {
		if t.Models[i].Match == match {
			return &t.Models[i] // sorted newest first within a match
		}
	}
	return nil
}

func samePrices(a, b *Row) bool {
	eq := func(x, y float64) bool { return math.Abs(x-y) < 1e-9 }
	base := eq(a.Input, b.Input) && eq(a.Output, b.Output) && eq(a.CacheWrite5m, b.CacheWrite5m) &&
		eq(a.CacheWrite1h, b.CacheWrite1h) && eq(a.CacheRead, b.CacheRead)
	if b.LongAbove == 0 {
		// The page only lists long-context tiers for current models; keep historical tiers.
		return base
	}
	return base && a.LongAbove == b.LongAbove && eq(a.LongInput, b.LongInput) && eq(a.LongOutput, b.LongOutput) &&
		eq(a.LongCacheWrite5m, b.LongCacheWrite5m) && eq(a.LongCacheWrite1h, b.LongCacheWrite1h) && eq(a.LongCacheRead, b.LongCacheRead)
}

// ParsePage extracts the "Model pricing" table from the pricing page markdown.
func ParsePage(md string) ([]Row, error) {
	start := strings.Index(md, "## Model pricing")
	if start < 0 {
		return nil, fmt.Errorf("pricing page: no \"Model pricing\" section")
	}
	section := md[start:]
	if end := strings.Index(section[3:], "\n## "); end > 0 {
		section = section[:end+3]
	}
	var rows []Row
	byMatch := map[string]int{}
	for _, line := range strings.Split(section, "\n") {
		if !strings.HasPrefix(line, "| Claude") {
			continue
		}
		cells := strings.Split(strings.Trim(line, "|"), "|")
		if len(cells) < 6 {
			continue
		}
		name := strings.Join(strings.Fields(reLink.ReplaceAllString(cells[0], "")), " ")
		m := reModel.FindStringSubmatch(name)
		if m == nil {
			continue
		}
		family, version := strings.ToLower(m[1]), strings.ReplaceAll(m[2], ".", "-")
		match := "claude-" + family + "-" + version
		if strings.HasPrefix(m[2], "3") { // Claude 3.x ids put the version first
			match = "claude-" + version + "-" + family
		}
		var p [5]float64
		for i := 0; i < 5; i++ {
			pm := rePrice.FindStringSubmatch(cells[i+1])
			if pm == nil {
				return nil, fmt.Errorf("pricing page: cannot parse price in %q", line)
			}
			p[i], _ = strconv.ParseFloat(pm[1], 64)
		}
		label := strings.TrimPrefix(fmt.Sprintf("%s %s", m[1], m[2]), "Claude ")
		if m[3] == "over" {
			// Second row of a tiered model: fold into the base row's long tier.
			if i, ok := byMatch[match]; ok {
				r := &rows[i]
				r.LongAbove, _ = strconv.ParseInt(strings.ReplaceAll(m[4], ",", ""), 10, 64)
				r.LongInput, r.LongCacheWrite5m, r.LongCacheWrite1h, r.LongCacheRead, r.LongOutput = p[0], p[1], p[2], p[3], p[4]
			}
			continue
		}
		byMatch[match] = len(rows)
		rows = append(rows, Row{Match: match, Label: label, Input: p[0], CacheWrite5m: p[1], CacheWrite1h: p[2], CacheRead: p[3], Output: p[4]})
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("pricing page: no model rows found")
	}
	return rows, nil
}

// AppendChanges appends one dated row per change to the table file, preserving
// its comments and existing rows, and returns how many rows were written.
// Modifiers (fast/geo multipliers) are carried over from the row being replaced.
func (t *Table) AppendChanges(changes []Change, from time.Time) (int, error) {
	if len(changes) == 0 {
		return 0, nil
	}
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("  # Added by `csb pricing check` on %s\n", time.Now().UTC().Format("2006-01-02")))
	for _, c := range changes {
		r := c.New
		if c.Old != nil {
			r.Label, r.FastMultiplier, r.GeoMultipliers = c.Old.Label, c.Old.FastMultiplier, c.Old.GeoMultipliers
		}
		sb.WriteString(fmt.Sprintf("  - {match: %s, label: %s, from: %s, input: %g, cache_write_5m: %g, cache_write_1h: %g, cache_read: %g, output: %g",
			r.Match, r.Label, from.Format("2006-01-02"), r.Input, r.CacheWrite5m, r.CacheWrite1h, r.CacheRead, r.Output))
		if r.LongAbove > 0 {
			sb.WriteString(fmt.Sprintf(", long_above: %d, long_input: %g, long_cache_write_5m: %g, long_cache_write_1h: %g, long_cache_read: %g, long_output: %g",
				r.LongAbove, r.LongInput, r.LongCacheWrite5m, r.LongCacheWrite1h, r.LongCacheRead, r.LongOutput))
		}
		if r.FastMultiplier > 0 {
			sb.WriteString(fmt.Sprintf(", fast_multiplier: %g", r.FastMultiplier))
		}
		if len(r.GeoMultipliers) > 0 {
			var parts []string
			for k, v := range r.GeoMultipliers {
				parts = append(parts, fmt.Sprintf("%s: %g", k, v))
			}
			sb.WriteString(", geo_multipliers: {" + strings.Join(parts, ", ") + "}")
		}
		sb.WriteString("}\n")
	}
	b, err := os.ReadFile(t.Path)
	if err != nil {
		return 0, err
	}
	out := string(b)
	if !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	out += sb.String()
	if _, err := Parse([]byte(out)); err != nil {
		return 0, fmt.Errorf("refusing to write an invalid table: %w", err)
	}
	return len(changes), os.WriteFile(t.Path, []byte(out), 0o644)
}

func fetch(ctx context.Context, url string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return string(b), err
}
