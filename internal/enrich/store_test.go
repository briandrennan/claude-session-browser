package enrich

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// A suggestion with no existing-vocabulary tags (only a proposed new tag, or an
// error record) loses its empty tag list in YAML; after a reload it must still
// serialize as [] so the UI can iterate it.
func TestSuggestionTagsSurviveReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "enrichment.yml")
	s, err := Open(path, []string{"testing"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetSuggestion("a", Suggestion{NewTag: "docs", Rationale: "r", Model: "m"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSuggestion("b", Suggestion{Model: "m", Error: "boom", Status: "error"}); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b", "missing"} {
		b, _ := json.Marshal(s.Session(id))
		if strings.Contains(string(b), "null") {
			t.Errorf("session %s serializes with null: %s", id, b)
		}
	}
}
