package pricing

import (
	"math"
	"os"
	"testing"
	"time"
)

func TestDefaultTableMatchesPricingPage(t *testing.T) {
	page, err := os.ReadFile("testdata/pricing-2026-10-28.md")
	if err != nil {
		t.Fatal(err)
	}
	rows, err := ParsePage(string(page))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) < 20 {
		t.Fatalf("parsed %d rows, want >= 20", len(rows))
	}
	tbl, err := Parse(defaultTable)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		cur := tbl.current(r.Match)
		if cur == nil {
			t.Errorf("%s: missing from default table", r.Match)
			continue
		}
		if !samePrices(cur, &r) {
			t.Errorf("%s: table %+v != page %+v", r.Match, *cur, r)
		}
	}
}

func TestLookupIsTimeVersioned(t *testing.T) {
	tbl, err := Parse([]byte(`
models:
  - {match: claude-x-1, input: 10, output: 50}
  - {match: claude-x-1, from: 2026-06-01, input: 5, output: 25}
  - {match: claude-x, input: 1, output: 1}
`))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		model string
		at    string
		input float64
	}{
		{"claude-x-1", "2026-05-31", 10},
		{"claude-x-1", "2026-06-01", 5},
		{"claude-x-1-20260101", "2027-01-01", 5},
		{"claude-x-2", "2026-01-01", 1},
	}
	for _, c := range cases {
		at, _ := time.Parse("2006-01-02", c.at)
		r, ok := tbl.Lookup(c.model, at)
		if !ok || r.Input != c.input {
			t.Errorf("Lookup(%s, %s) = %+v, want input %g", c.model, c.at, r, c.input)
		}
	}
}

func TestCostModifiers(t *testing.T) {
	tbl, _ := Parse(defaultTable)
	at := time.Date(2026, 10, 28, 0, 0, 0, 0, time.UTC)
	approx := func(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

	// Haiku 5.5 switches every price to the long tier above 100K prompt tokens.
	short, _, _ := tbl.Cost("claude-haiku-5-5", at, Tokens{Input: 1000, CacheRead: 90_000, Output: 1000}, "", "global")
	long, _, _ := tbl.Cost("claude-haiku-5-5", at, Tokens{Input: 1000, CacheRead: 110_000, Output: 1000}, "", "global")
	if !approx(short, (1000*0.10+90_000*0.01+1000*0.50)/1e6) || !approx(long, (1000*0.50+110_000*0.05+1000*2.50)/1e6) {
		t.Errorf("haiku tiers: short %g long %g", short, long)
	}
	// Fast mode and US-only inference stack.
	base, _, _ := tbl.Cost("claude-opus-5-5", at, Tokens{Output: 1_000_000}, "", "")
	fastUS, _, _ := tbl.Cost("claude-opus-5-5", at, Tokens{Output: 1_000_000}, "fast", "us")
	if !approx(base, 20) || !approx(fastUS, 20*2*1.1) {
		t.Errorf("opus modifiers: base %g fast+us %g", base, fastUS)
	}
}
