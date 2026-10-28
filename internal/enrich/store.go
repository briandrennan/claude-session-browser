// Package enrich stores user-supplied session classification (tags, notes) in a YAML file.
package enrich

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

type SessionInfo struct {
	Tags       []string    `yaml:"tags,omitempty" json:"tags"`
	Note       string      `yaml:"note,omitempty" json:"note"`
	Suggestion *Suggestion `yaml:"suggestion,omitempty" json:"suggestion,omitempty"`
}

// Suggestion is a model-proposed classification awaiting the user's review.
type Suggestion struct {
	Tags      []string  `yaml:"tags,omitempty" json:"tags"`
	NewTag    string    `yaml:"new_tag,omitempty" json:"newTag,omitempty"`
	Rationale string    `yaml:"rationale,omitempty" json:"rationale"`
	Model     string    `yaml:"model" json:"model"`
	At        time.Time `yaml:"at" json:"at"`
	CostUSD   float64   `yaml:"cost_usd" json:"cost"`
	Error     string    `yaml:"error,omitempty" json:"error,omitempty"`
	// Status is "pending" (awaiting review), "accepted" or "dismissed".
	Status string `yaml:"status" json:"status"`
}

type file struct {
	Tags     []string                `yaml:"tags"`
	Sessions map[string]*SessionInfo `yaml:"sessions"`
}

type Store struct {
	path string
	mu   sync.RWMutex
	data file
}

// Open loads path, seeding the tag vocabulary with defaults on first use.
func Open(path string, defaults []string) (*Store, error) {
	s := &Store{path: path, data: file{Sessions: map[string]*SessionInfo{}}}
	b, err := os.ReadFile(path)
	switch {
	case os.IsNotExist(err):
		s.data.Tags = append([]string(nil), defaults...)
		return s, s.save()
	case err != nil:
		return nil, err
	}
	if err := yaml.Unmarshal(b, &s.data); err != nil {
		return nil, err
	}
	if s.data.Sessions == nil {
		s.data.Sessions = map[string]*SessionInfo{}
	}
	return s, nil
}

func (s *Store) Tags() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]string{}, s.data.Tags...)
}

func (s *Store) Session(id string) SessionInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if si := s.data.Sessions[id]; si != nil {
		out := SessionInfo{Tags: append([]string{}, si.Tags...), Note: si.Note}
		if si.Suggestion != nil {
			sg := *si.Suggestion
			// YAML drops empty lists, so a reloaded suggestion can have nil tags.
			sg.Tags = append([]string{}, sg.Tags...)
			out.Suggestion = &sg
		}
		return out
	}
	return SessionInfo{Tags: []string{}}
}

// SetSession replaces a session's tags and note; unknown tags join the vocabulary.
func (s *Store) SetSession(id string, tags []string, note string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	si := s.entry(id)
	si.Tags, si.Note = normalize(tags), note
	for _, t := range si.Tags {
		s.addTag(t)
	}
	s.prune(id)
	return s.save()
}

// SetSuggestion records a classifier result for a session.
func (s *Store) SetSuggestion(id string, sg Suggestion) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sg.Tags = normalize(sg.Tags)
	if sg.Status == "" {
		sg.Status = "pending"
	}
	s.entry(id).Suggestion = &sg
	return s.save()
}

// ResolveSuggestion accepts (merging its tags, creating a proposed new tag) or
// dismisses a pending suggestion. The record is kept so it is not re-suggested.
func (s *Store) ResolveSuggestion(id string, accept bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	si := s.data.Sessions[id]
	if si == nil || si.Suggestion == nil {
		return errors.New("no suggestion for session")
	}
	if accept {
		tags := append(append([]string{}, si.Tags...), si.Suggestion.Tags...)
		if si.Suggestion.NewTag != "" {
			tags = append(tags, si.Suggestion.NewTag)
		}
		si.Tags = normalize(tags)
		for _, t := range si.Tags {
			s.addTag(t)
		}
		si.Suggestion.Status = "accepted"
	} else {
		si.Suggestion.Status = "dismissed"
	}
	return s.save()
}

func (s *Store) entry(id string) *SessionInfo {
	si := s.data.Sessions[id]
	if si == nil {
		si = &SessionInfo{}
		s.data.Sessions[id] = si
	}
	return si
}

func (s *Store) prune(id string) {
	if si := s.data.Sessions[id]; si != nil && len(si.Tags) == 0 && si.Note == "" && si.Suggestion == nil {
		delete(s.data.Sessions, id)
	}
}

func (s *Store) AddTag(tag string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := normalize([]string{tag}); len(t) == 1 {
		s.addTag(t[0])
	}
	return s.save()
}

// DeleteTag removes a tag from the vocabulary and from every session.
func (s *Store) DeleteTag(tag string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Tags = without(s.data.Tags, tag)
	for _, si := range s.data.Sessions {
		si.Tags = without(si.Tags, tag)
	}
	return s.save()
}

func (s *Store) addTag(t string) {
	for _, x := range s.data.Tags {
		if x == t {
			return
		}
	}
	s.data.Tags = append(s.data.Tags, t)
}

func (s *Store) save() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	b, err := yaml.Marshal(&s.data)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func normalize(tags []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

func without(xs []string, x string) []string {
	out := xs[:0]
	for _, y := range xs {
		if y != x {
			out = append(out, y)
		}
	}
	return out
}
