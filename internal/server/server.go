// Package server exposes the session index over a JSON API and serves the web UI.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bdrennan/claude-session-browser/internal/classify"
	"github.com/bdrennan/claude-session-browser/internal/config"
	"github.com/bdrennan/claude-session-browser/internal/enrich"
	"github.com/bdrennan/claude-session-browser/internal/pricing"
	"github.com/bdrennan/claude-session-browser/internal/sessions"
)

const refreshEvery = 5 * time.Second

type Server struct {
	cfg    *config.Config
	index  *sessions.Index
	enrich *enrich.Store
	runner *classify.Runner
	static fs.FS

	checkMu sync.Mutex
	check   *pricing.CheckResult
}

func New(cfg *config.Config, ix *sessions.Index, es *enrich.Store, runner *classify.Runner, static fs.FS) *Server {
	return &Server{cfg: cfg, index: ix, enrich: es, runner: runner, static: static}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/meta", s.meta)
	mux.HandleFunc("GET /api/sessions", s.listSessions)
	mux.HandleFunc("GET /api/sessions/{id}", s.getSession)
	mux.HandleFunc("GET /api/sessions/{id}/tools/{toolId}", s.getToolCall)
	mux.HandleFunc("PUT /api/sessions/{id}/enrichment", s.putEnrichment)
	mux.HandleFunc("POST /api/sessions/{id}/suggestion/{action}", s.resolveSuggestion)
	mux.HandleFunc("GET /api/usage", s.usage)
	mux.HandleFunc("POST /api/tags", s.addTag)
	mux.HandleFunc("DELETE /api/tags/{tag}", s.deleteTag)
	mux.HandleFunc("GET /api/classify", s.classifyStatus)
	mux.HandleFunc("POST /api/classify", s.classify)
	mux.HandleFunc("GET /api/pricing", s.pricing)
	mux.HandleFunc("POST /api/pricing/check", s.pricingCheck)
	mux.Handle("/", s.spa())
	return logRequests(mux)
}

// CheckPricingDaily compares the price table with the live pricing page once a day.
func (s *Server) CheckPricingDaily(ctx context.Context) {
	for {
		s.runCheck(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(24 * time.Hour):
		}
	}
}

func (s *Server) runCheck(ctx context.Context) pricing.CheckResult {
	res := s.index.Prices().Check(ctx)
	if res.Error != "" {
		log.Printf("pricing check: %s", res.Error)
	} else if len(res.Changes) > 0 {
		log.Printf("pricing check: %d differences from %s; run `csb pricing check -write`", len(res.Changes), pricing.PageURL)
	}
	s.checkMu.Lock()
	s.check = &res
	s.checkMu.Unlock()
	return res
}

func (s *Server) fresh(w http.ResponseWriter) bool {
	if err := s.index.Refresh(refreshEvery); err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return false
	}
	return true
}

func (s *Server) meta(w http.ResponseWriter, r *http.Request) {
	if !s.fresh(w) {
		return
	}
	sources := []string{}
	for _, src := range s.cfg.AllSources() {
		sources = append(sources, src.Name)
	}
	s.checkMu.Lock()
	check := s.check
	s.checkMu.Unlock()
	writeJSON(w, map[string]any{
		"tags":         s.enrich.Tags(),
		"sources":      sources,
		"modelLabels":  s.index.Prices().Labels(),
		"classifier":   s.runner.Status(),
		"pricingCheck": check,
	})
}

// sessionRow is a summary with its enrichment attached.
type sessionRow struct {
	sessions.Summary
	Suggestion *enrich.Suggestion `json:"suggestion,omitempty"`
}

func (s *Server) row(sum sessions.Summary) sessionRow {
	info := s.enrich.Session(sum.ID)
	sum.Tags, sum.Note = info.Tags, info.Note
	return sessionRow{Summary: sum, Suggestion: info.Suggestion}
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	if !s.fresh(w) {
		return
	}
	from, to, err := parseRange(r)
	if err != nil {
		httpError(w, err, http.StatusBadRequest)
		return
	}
	list := s.index.Summaries(from, to)
	out := make([]sessionRow, len(list))
	for i := range list {
		out[i] = s.row(list[i])
	}
	writeJSON(w, out)
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	if !s.fresh(w) {
		return
	}
	d, err := s.index.Detail(r.PathValue("id"))
	if errors.Is(err, os.ErrNotExist) {
		httpError(w, err, http.StatusNotFound)
		return
	}
	if err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	row := s.row(d.Summary)
	d.Summary = row.Summary
	writeJSON(w, struct {
		*sessions.Detail
		Suggestion *enrich.Suggestion `json:"suggestion,omitempty"`
	}{d, row.Suggestion})
}

func (s *Server) getToolCall(w http.ResponseWriter, r *http.Request) {
	if !s.fresh(w) {
		return
	}
	c, err := s.index.ToolCall(r.PathValue("id"), r.PathValue("toolId"))
	if errors.Is(err, os.ErrNotExist) {
		httpError(w, err, http.StatusNotFound)
		return
	}
	if err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	writeJSON(w, c)
}

func (s *Server) putEnrichment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Tags []string `json:"tags"`
		Note string   `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, err, http.StatusBadRequest)
		return
	}
	if err := s.enrich.SetSession(r.PathValue("id"), body.Tags, body.Note); err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	writeJSON(w, s.enrich.Session(r.PathValue("id")))
}

func (s *Server) resolveSuggestion(w http.ResponseWriter, r *http.Request) {
	action := r.PathValue("action")
	if action != "accept" && action != "dismiss" {
		httpError(w, errors.New("action must be accept or dismiss"), http.StatusBadRequest)
		return
	}
	if err := s.enrich.ResolveSuggestion(r.PathValue("id"), action == "accept"); err != nil {
		httpError(w, err, http.StatusBadRequest)
		return
	}
	writeJSON(w, s.enrich.Session(r.PathValue("id")))
}

func (s *Server) addTag(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Tag string `json:"tag"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Tag) == "" {
		httpError(w, errors.New("tag required"), http.StatusBadRequest)
		return
	}
	if err := s.enrich.AddTag(body.Tag); err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	writeJSON(w, s.enrich.Tags())
}

func (s *Server) deleteTag(w http.ResponseWriter, r *http.Request) {
	if err := s.enrich.DeleteTag(r.PathValue("tag")); err != nil {
		httpError(w, err, http.StatusInternalServerError)
		return
	}
	writeJSON(w, s.enrich.Tags())
}

func (s *Server) classifyStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.runner.Status())
}

// classify queues sessions for tag suggestions: explicit ids, or every session in
// [from, to] that has no tags and no pending suggestion.
func (s *Server) classify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IDs  []string  `json:"ids"`
		From time.Time `json:"from"`
		To   time.Time `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpError(w, err, http.StatusBadRequest)
		return
	}
	ids := body.IDs
	if len(ids) == 0 {
		if !s.fresh(w) {
			return
		}
		for _, sum := range s.index.Summaries(body.From, body.To) {
			info := s.enrich.Session(sum.ID)
			if len(info.Tags) == 0 && sum.UserPrompts > 0 && !sum.Archived && (info.Suggestion == nil || info.Suggestion.Status == "error") {
				ids = append(ids, sum.ID)
			}
		}
	}
	n := s.runner.Enqueue(ids...)
	st := s.runner.Status()
	if st.Disabled != "" {
		httpError(w, errors.New(st.Disabled), http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, map[string]any{"queued": n, "status": st})
}

func (s *Server) pricing(w http.ResponseWriter, r *http.Request) {
	if !s.fresh(w) {
		return
	}
	t := s.index.Prices()
	// Models seen in transcripts, with whether the table prices them.
	type seen struct {
		Model  string `json:"model"`
		Label  string `json:"label"`
		Priced bool   `json:"priced"`
	}
	models := map[string]bool{}
	for _, sum := range s.index.Summaries(time.Time{}, time.Time{}) {
		for _, m := range sum.Models {
			models[m] = true
		}
	}
	out := []seen{}
	for m := range models {
		row, ok := t.Lookup(m, time.Now())
		sm := seen{Model: m, Priced: ok}
		if ok {
			sm.Label = row.Label
		}
		out = append(out, sm)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Model < out[j].Model })
	s.checkMu.Lock()
	check := s.check
	s.checkMu.Unlock()
	writeJSON(w, map[string]any{"table": t, "seen": out, "check": check, "pageUrl": pricing.PageURL})
}

func (s *Server) pricingCheck(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.runCheck(r.Context()))
}

func (s *Server) usage(w http.ResponseWriter, r *http.Request) {
	if !s.fresh(w) {
		return
	}
	from, to, err := parseRange(r)
	if err != nil {
		httpError(w, err, http.StatusBadRequest)
		return
	}
	if from.IsZero() {
		from = time.Now().AddDate(0, 0, -7)
	}
	if to.IsZero() {
		to = time.Now()
	}
	loc := time.Local
	if tz := r.URL.Query().Get("tz"); tz != "" {
		if l, err := time.LoadLocation(tz); err == nil {
			loc = l
		}
	}
	bucket := r.URL.Query().Get("bucket")
	if bucket == "" {
		bucket = "day"
		if to.Sub(from) <= 48*time.Hour {
			bucket = "hour"
		}
	}
	writeJSON(w, s.index.Usage(sessions.UsageQuery{
		From: from, To: to, Bucket: bucket, Loc: loc,
		Group:  r.URL.Query().Get("group"),
		TagsOf: func(id string) []string { return s.enrich.Session(id).Tags },
	}))
}

// spa serves the embedded frontend, falling back to index.html for client routes.
func (s *Server) spa() http.Handler {
	files := http.FileServerFS(s.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" {
			if _, err := fs.Stat(s.static, p); err == nil {
				files.ServeHTTP(w, r)
				return
			}
		}
		http.ServeFileFS(w, r, s.static, "index.html")
	})
}

func parseRange(r *http.Request) (from, to time.Time, err error) {
	q := r.URL.Query()
	if v := q.Get("from"); v != "" {
		if from, err = time.Parse(time.RFC3339, v); err != nil {
			return
		}
	}
	if v := q.Get("to"); v != "" {
		to, err = time.Parse(time.RFC3339, v)
	}
	return
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("encode: %v", err)
	}
}

func httpError(w http.ResponseWriter, err error, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

func logRequests(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}
