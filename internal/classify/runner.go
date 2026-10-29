package classify

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/bdrennan/claude-session-browser/internal/enrich"
	"github.com/bdrennan/claude-session-browser/internal/sessions"
)

const workers = 4

// Status is the runner's progress, shown in the UI.
type Status struct {
	Enabled   bool    `json:"enabled"`
	Auto      bool    `json:"auto"`
	Model     string  `json:"model"`
	Disabled  string  `json:"disabled,omitempty"` // why classification is unavailable
	Queued    int     `json:"queued"`
	Running   int     `json:"running"`
	Done      int     `json:"done"`
	Failed    int     `json:"failed"`
	CostUSD   float64 `json:"cost"`
	LastError string  `json:"lastError,omitempty"`
}

// Runner classifies queued sessions in the background.
type Runner struct {
	cls     *Classifier
	ix      *sessions.Index
	store   *enrich.Store
	auto    bool
	minIdle time.Duration

	mu     sync.Mutex
	queue  []string
	queued map[string]bool
	status Status
	cond   *sync.Cond
}

func NewRunner(cls *Classifier, ix *sessions.Index, store *enrich.Store, auto bool, minIdle time.Duration) *Runner {
	r := &Runner{
		cls: cls, ix: ix, store: store, auto: auto, minIdle: minIdle,
		queued: map[string]bool{},
		status: Status{Enabled: true, Auto: auto, Model: cls.model},
	}
	r.cond = sync.NewCond(&r.mu)
	return r
}

func (r *Runner) Status() Status {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.status
	st.Queued = len(r.queue)
	return st
}

// Enqueue adds sessions to classify; already-queued ids are ignored.
func (r *Runner) Enqueue(ids ...string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.status.Disabled != "" {
		return 0
	}
	n := 0
	for _, id := range ids {
		if !r.queued[id] {
			r.queued[id] = true
			r.queue = append(r.queue, id)
			n++
		}
	}
	r.cond.Broadcast()
	return n
}

// Run processes the queue and, when auto is on, periodically enqueues idle
// sessions that have neither tags nor a suggestion. It returns when ctx ends.
func (r *Runner) Run(ctx context.Context) {
	go func() {
		<-ctx.Done()
		r.mu.Lock()
		r.cond.Broadcast()
		r.mu.Unlock()
	}()
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.worker(ctx)
		}()
	}
	if r.auto {
		tick := time.NewTicker(2 * time.Minute)
		defer tick.Stop()
		for {
			r.enqueueIdle()
			select {
			case <-ctx.Done():
				wg.Wait()
				return
			case <-tick.C:
			}
		}
	}
	wg.Wait()
}

func (r *Runner) enqueueIdle() {
	if err := r.ix.Refresh(time.Minute); err != nil {
		return
	}
	cutoff := time.Now().Add(-r.minIdle)
	var ids []string
	for _, s := range r.ix.Summaries(time.Time{}, time.Time{}) {
		if s.End.After(cutoff) || s.UserPrompts == 0 || s.Archived {
			continue
		}
		info := r.store.Session(s.ID)
		if len(info.Tags) == 0 && info.Suggestion == nil {
			ids = append(ids, s.ID)
		}
	}
	if n := r.Enqueue(ids...); n > 0 {
		log.Printf("classifier: auto-queued %d sessions", n)
	}
}

func (r *Runner) next(ctx context.Context) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for ctx.Err() == nil {
		if len(r.queue) > 0 && r.status.Disabled == "" {
			id := r.queue[0]
			r.queue = r.queue[1:]
			r.status.Running++
			return id, true
		}
		r.cond.Wait()
	}
	return "", false
}

func (r *Runner) worker(ctx context.Context) {
	for {
		id, ok := r.next(ctx)
		if !ok {
			return
		}
		err := r.classifyOne(ctx, id)
		r.mu.Lock()
		r.status.Running--
		delete(r.queued, id)
		if err != nil {
			r.status.Failed++
			r.status.LastError = err.Error()
			if IsAuthError(err) && r.status.Disabled == "" {
				r.status.Disabled = "Tag suggestions need Anthropic API credentials: set ANTHROPIC_API_KEY or run `ant auth login`, then restart. (" + strings.SplitN(err.Error(), "\n", 2)[0] + ")"
				r.status.Enabled = false
				r.queue, r.queued = nil, map[string]bool{}
				log.Printf("classifier disabled: %v", err)
			}
		} else {
			r.status.Done++
		}
		r.mu.Unlock()
	}
}

func (r *Runner) classifyOne(ctx context.Context, id string) error {
	d, err := r.ix.Detail(id)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	sg, err := r.cls.Classify(ctx, d, r.store.Tags())
	r.mu.Lock()
	r.status.CostUSD += sg.CostUSD
	r.mu.Unlock()
	if err != nil {
		if IsAuthError(err) {
			return err
		}
		sg.Model, sg.At, sg.Error, sg.Status = r.cls.model, time.Now().UTC(), err.Error(), "error"
	}
	if serr := r.store.SetSuggestion(d.Summary.ID, sg); serr != nil {
		return serr
	}
	return err
}
