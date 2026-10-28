// Package config loads the YAML configuration for the session browser.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Source is one ~/.claude directory to index.
type Source struct {
	Name string `yaml:"name"`
	Path string `yaml:"path"`
}

type Classifier struct {
	Model string `yaml:"model"`
	// Auto classifies sessions that have no tags and no suggestion once they
	// have been idle for MinIdle.
	Auto    bool          `yaml:"auto"`
	MinIdle time.Duration `yaml:"min_idle"`
}

type Config struct {
	Listen      string   `yaml:"listen"`
	DataDir     string   `yaml:"data_dir"`
	PricingFile string   `yaml:"pricing_file"`
	Sources     []Source `yaml:"sources"`
	// TeamDirs hold one folder per person, each produced by `csb export`
	// (<team_dir>/<name>/projects/...). Every such folder becomes a source.
	TeamDirs    []string   `yaml:"team_dirs"`
	DefaultTags []string   `yaml:"default_tags"`
	Classifier  Classifier `yaml:"classifier"`
}

// Load reads path, or returns defaults when path does not exist.
func Load(path string) (*Config, error) {
	cfg := Default()
	b, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err == nil {
		if err := yaml.Unmarshal(b, cfg); err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
	}
	return cfg, cfg.normalize(filepath.Dir(path))
}

func (c *Config) normalize(baseDir string) error {
	abs := func(p string) (string, error) {
		p, err := ExpandHome(p)
		if err != nil || filepath.IsAbs(p) {
			return p, err
		}
		return filepath.Join(baseDir, p), nil
	}
	var err error
	for i := range c.Sources {
		if c.Sources[i].Path, err = abs(c.Sources[i].Path); err != nil {
			return err
		}
		if c.Sources[i].Name == "" {
			c.Sources[i].Name = filepath.Base(filepath.Dir(c.Sources[i].Path))
		}
	}
	for i := range c.TeamDirs {
		if c.TeamDirs[i], err = abs(c.TeamDirs[i]); err != nil {
			return err
		}
	}
	if c.DataDir, err = abs(c.DataDir); err != nil {
		return err
	}
	if c.PricingFile, err = abs(c.PricingFile); err != nil {
		return err
	}
	if c.Classifier.MinIdle == 0 {
		c.Classifier.MinIdle = 30 * time.Minute
	}
	return nil
}

// AllSources returns the configured sources plus one per person folder found in
// TeamDirs. It is re-evaluated on every index refresh so new exports appear.
func (c *Config) AllSources() []Source {
	seen := map[string]bool{}
	for _, s := range c.Sources {
		seen[s.Name] = true
	}
	var team []Source
	for _, dir := range c.TeamDirs {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			p := filepath.Join(dir, e.Name())
			if !e.IsDir() || seen[e.Name()] {
				continue
			}
			if fi, err := os.Stat(filepath.Join(p, "projects")); err == nil && fi.IsDir() {
				seen[e.Name()] = true
				team = append(team, Source{Name: e.Name(), Path: p})
			}
		}
	}
	sort.Slice(team, func(i, j int) bool { return team[i].Name < team[j].Name })
	return append(append([]Source{}, c.Sources...), team...)
}

func ExpandHome(p string) (string, error) {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, strings.TrimPrefix(p, "~")), nil
	}
	return p, nil
}

func Default() *Config {
	user := os.Getenv("USER")
	if user == "" {
		user = "me"
	}
	return &Config{
		Listen:      "127.0.0.1:8484",
		DataDir:     "./data",
		PricingFile: "./pricing.yml",
		Sources:     []Source{{Name: user, Path: "~/.claude"}},
		DefaultTags: []string{"exploration", "feature-dev", "bug-fixing", "performance-engineering", "simplification", "code-review", "testing"},
		Classifier:  Classifier{Model: "claude-haiku-5-5", Auto: true},
	}
}
