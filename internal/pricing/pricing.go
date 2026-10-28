// Package pricing holds the time-versioned API price table and prices token usage
// with the rates that were in effect when the usage happened.
package pricing

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

//go:embed default.yml
var defaultTable []byte

// Row is one model's prices (USD per million tokens) from a point in time.
type Row struct {
	Match            string             `yaml:"match" json:"match"`
	Label            string             `yaml:"label" json:"label"`
	From             string             `yaml:"from,omitempty" json:"from,omitempty"` // YYYY-MM-DD, UTC
	Input            float64            `yaml:"input" json:"input"`
	Output           float64            `yaml:"output" json:"output"`
	CacheWrite5m     float64            `yaml:"cache_write_5m" json:"cacheWrite5m"`
	CacheWrite1h     float64            `yaml:"cache_write_1h" json:"cacheWrite1h"`
	CacheRead        float64            `yaml:"cache_read" json:"cacheRead"`
	LongAbove        int64              `yaml:"long_above,omitempty" json:"longAbove,omitempty"`
	LongInput        float64            `yaml:"long_input,omitempty" json:"longInput,omitempty"`
	LongOutput       float64            `yaml:"long_output,omitempty" json:"longOutput,omitempty"`
	LongCacheWrite5m float64            `yaml:"long_cache_write_5m,omitempty" json:"longCacheWrite5m,omitempty"`
	LongCacheWrite1h float64            `yaml:"long_cache_write_1h,omitempty" json:"longCacheWrite1h,omitempty"`
	LongCacheRead    float64            `yaml:"long_cache_read,omitempty" json:"longCacheRead,omitempty"`
	FastMultiplier   float64            `yaml:"fast_multiplier,omitempty" json:"fastMultiplier,omitempty"`
	GeoMultipliers   map[string]float64 `yaml:"geo_multipliers,omitempty" json:"geoMultipliers,omitempty"`
	Note             string             `yaml:"note,omitempty" json:"note,omitempty"`

	from time.Time
}

type PricePoint struct {
	From  string  `yaml:"from,omitempty" json:"from,omitempty"`
	Price float64 `yaml:"price" json:"price"`
	from  time.Time
}

type Table struct {
	WebSearchPer1K []PricePoint `yaml:"web_search_per_1k" json:"webSearchPer1k"`
	Models         []Row        `yaml:"models" json:"models"`
	Path           string       `yaml:"-" json:"path"`
}

// Tokens is the billable usage of one API response.
type Tokens struct {
	Input, Output, CacheRead, CacheWrite5m, CacheWrite1h, WebSearches int64
}

// Load reads the table at path, writing the built-in default there first if it
// does not exist so the table can be versioned and edited.
func Load(path string) (*Table, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, defaultTable, 0o644); err != nil {
			return nil, err
		}
		b = defaultTable
	} else if err != nil {
		return nil, err
	}
	t, err := Parse(b)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	t.Path = path
	return t, nil
}

func Parse(b []byte) (*Table, error) {
	var t Table
	if err := yaml.Unmarshal(b, &t); err != nil {
		return nil, err
	}
	for i := range t.Models {
		r := &t.Models[i]
		if r.Match == "" {
			return nil, fmt.Errorf("models[%d]: match is required", i)
		}
		d, err := parseDate(r.From)
		if err != nil {
			return nil, fmt.Errorf("models[%d] (%s): %w", i, r.Match, err)
		}
		r.from = d
		r.fillDefaults()
	}
	for i := range t.WebSearchPer1K {
		d, err := parseDate(t.WebSearchPer1K[i].From)
		if err != nil {
			return nil, fmt.Errorf("web_search_per_1k[%d]: %w", i, err)
		}
		t.WebSearchPer1K[i].from = d
	}
	// Longest match first; within a match, newest row first.
	sort.SliceStable(t.Models, func(i, j int) bool {
		a, b := t.Models[i], t.Models[j]
		if len(a.Match) != len(b.Match) {
			return len(a.Match) > len(b.Match)
		}
		if a.Match != b.Match {
			return a.Match < b.Match
		}
		return a.from.After(b.from)
	})
	sort.SliceStable(t.WebSearchPer1K, func(i, j int) bool { return t.WebSearchPer1K[i].from.After(t.WebSearchPer1K[j].from) })
	return &t, nil
}

func parseDate(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	return time.Parse("2006-01-02", s)
}

// fillDefaults applies the standard cache multipliers where a price is omitted.
func (r *Row) fillDefaults() {
	def := func(v *float64, base, mult float64) {
		if *v == 0 {
			*v = base * mult
		}
	}
	def(&r.CacheWrite5m, r.Input, 1.25)
	def(&r.CacheWrite1h, r.Input, 2)
	def(&r.CacheRead, r.Input, 0.1)
	if r.LongAbove > 0 {
		def(&r.LongCacheWrite5m, r.LongInput, 1.25)
		def(&r.LongCacheWrite1h, r.LongInput, 2)
		def(&r.LongCacheRead, r.LongInput, 0.1)
	}
	if r.Label == "" {
		r.Label = r.Match
	}
}

// Lookup returns the row for model in effect at t.
func (t *Table) Lookup(model string, at time.Time) (*Row, bool) {
	match := ""
	for i := range t.Models {
		r := &t.Models[i]
		if match != "" && r.Match != match {
			break // rows for the longest matching prefix are exhausted
		}
		if !strings.HasPrefix(model, r.Match) {
			continue
		}
		match = r.Match
		if !r.from.After(at) {
			return r, true
		}
	}
	if match != "" {
		// Usage before the earliest row for this model: use the earliest row.
		for i := len(t.Models) - 1; i >= 0; i-- {
			if t.Models[i].Match == match {
				return &t.Models[i], true
			}
		}
	}
	return nil, false
}

// Cost prices one response. ok is false when no row matches the model.
func (t *Table) Cost(model string, at time.Time, u Tokens, speed, geo string) (usd float64, row *Row, ok bool) {
	r, ok := t.Lookup(model, at)
	if !ok {
		return 0, nil, false
	}
	in, out, w5, w1, rd := r.Input, r.Output, r.CacheWrite5m, r.CacheWrite1h, r.CacheRead
	if r.LongAbove > 0 && u.Input+u.CacheRead+u.CacheWrite5m+u.CacheWrite1h > r.LongAbove {
		in, out, w5, w1, rd = r.LongInput, r.LongOutput, r.LongCacheWrite5m, r.LongCacheWrite1h, r.LongCacheRead
	}
	const m = 1e6
	usd = (float64(u.Input)*in + float64(u.Output)*out + float64(u.CacheWrite5m)*w5 +
		float64(u.CacheWrite1h)*w1 + float64(u.CacheRead)*rd) / m
	if speed == "fast" && r.FastMultiplier > 0 {
		usd *= r.FastMultiplier
	}
	if mult, ok := r.GeoMultipliers[geo]; ok && mult > 0 {
		usd *= mult
	}
	if u.WebSearches > 0 {
		usd += float64(u.WebSearches) * t.webSearchPrice(at) / 1000
	}
	return usd, r, true
}

func (t *Table) webSearchPrice(at time.Time) float64 {
	for _, p := range t.WebSearchPer1K {
		if !p.from.After(at) {
			return p.Price
		}
	}
	if n := len(t.WebSearchPer1K); n > 0 {
		return t.WebSearchPer1K[n-1].Price
	}
	return 0
}

// Labels maps each match prefix to its display label.
func (t *Table) Labels() map[string]string {
	out := map[string]string{}
	for _, r := range t.Models {
		out[r.Match] = r.Label
	}
	return out
}

// Effective returns the date a row takes effect, or "" for "since the beginning".
func (r *Row) Effective() string { return r.From }
