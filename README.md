# Claude Code Session Browser

A local web app for exploring Claude Code transcripts (`~/.claude/projects/**.jsonl`):
usage and API-equivalent cost over time by project / model / project × model, session
classification tags, and a per-session view with turn history, agents, tools, skills,
memories and friction insights.

## Run

```sh
make build          # pnpm build (web/) + go build -> bin/csb
./bin/csb           # http://127.0.0.1:8484, reads config.yml
./bin/csb list      # print indexed sessions
./bin/csb dump <session-id>    # parsed session detail as JSON
make dev            # Go API on :8484 + Vite on :5173 with hot reload
```

### Ports

The server listens on `listen` from `config.yml` (default `127.0.0.1:8484`). To use a different
port without editing the config, pass `-listen` (a bare port binds `127.0.0.1`; `host:port` is
used as given):

```sh
./bin/csb -listen 9090                  # http://127.0.0.1:9090
./bin/csb -listen 0.0.0.0:9090          # every interface
make run PORT=9090                      # build, then serve on 127.0.0.1:9090
make dev PORT=9090 WEB_PORT=5174        # API on :9090, Vite on http://localhost:5174
```

`make dev` points the Vite `/api` proxy at `PORT` (via `CSB_PORT`), so set it there rather than
in `config.yml` alone. Vite uses `--strictPort`: if `WEB_PORT` is taken it exits rather than
picking another port.

## Team usage

Each person exports their transcripts into a shared folder (a mount, synced drive, or a
local folder you `rsync` somewhere):

```sh
csb export -dest /srv/claude-usage -name alice                  # full transcripts
csb export -dest /srv/claude-usage -name bob -redact            # metrics only
csb export -dest /srv/claude-usage -name carol -exclude '*-secret-*'
```

Exports are incremental (unchanged files are skipped), so a cron entry such as
`*/30 * * * * csb export -dest /srv/claude-usage -name $USER` keeps it current. `-redact`
keeps usage, models, tool names, skills, subagent types/descriptions, file paths and session
titles, and drops prompts, responses, thinking and tool input/output (the allowlist is in
`internal/export/export.go`). Add the folder to `team_dirs` and every person appears as a
source; the dashboard gains a *Person* grouping.

## Tag suggestions

With `ANTHROPIC_API_KEY` set (or after `ant auth login`), Claude Haiku 5.5 proposes 1-3 tags
from your vocabulary (or one new tag) for each untagged session, from a digest of its prompts,
edited files, commands, tools, skills and subagents (`csb classify -dry-run` prints it). Suggestions wait for
review (accept/dismiss in the table or on the session page) and are stored with their cost in
`data/enrichment.yml`. `classifier.auto` suggests for sessions idle for `min_idle`;
`csb classify` runs it from the CLI. Redacted exports classify from titles and file paths only.

## Pricing

Costs are undiscounted API list prices **at the time of each response**, from `pricing.yml`
(created from a built-in default on first run, checked against the pricing page on
2026-10-28). Rows carry an optional `from` date; when a price changes, a new row is appended,
so earlier usage keeps its original price. The server compares the table with the live
pricing page daily (see the Pricing page); `csb pricing check -write` appends dated rows for
any differences. Long-context tiers (Haiku 5.5 over 100K prompt tokens), fast mode and
US-only inference (`inference_geo: us`, ×1.1) are applied per response.

## Configuration (`config.yml`)

- `sources`: one entry per `~/.claude` directory. Point extra sources at copies of
  teammates' `~/.claude/projects` folders to compare usage across people.
- `default_tags`: seed vocabulary for classification. Tags and notes are stored in
  `data/enrichment.yml`.
- `team_dirs`: folders of `csb export` output, one sub-folder per person.
- `pricing_file`: the time-versioned price table (see above).
- `classifier`: model, `auto`, and `min_idle` for tag suggestions.

## How transcripts are interpreted

| Need | Source in the JSONL |
| --- | --- |
| Title | last `custom-title`, else `ai-title`, else `summary`, else first prompt |
| Tokens / cost | `assistant.message.usage`, de-duplicated by `message.id` (one response is logged once per content block); cache writes split into 5m / 1h via `usage.cache_creation` |
| Subagents | `<session>/subagents/agent-<id>.jsonl` + `.meta.json` (type, description, parent `toolUseId`); legacy top-level `agent-*.jsonl` files are attached by `sessionId` |
| Tool calls | `tool_use` blocks, results from `tool_result` blocks (`is_error`), rejection text |
| Skills | `Skill` tool calls, plus `<command-name>` slash commands |
| Memories | `CLAUDE.md` / `.claude/rules/*.md` / `memory/*.md` files loaded as `Contents of <path>` in injected context (meta lines and `<system-reminder>` blocks, not prompts or relayed subagent reports) or `instructions` attachments, with their content; plus Read/Write/Edit calls on those paths |
| Friction | tool errors, rejections, `[Request interrupted by user]`, API errors, compactions, repeated identical calls, very large tool results, idle gaps, low cache hit rate |

Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default; raise it in
`~/.claude/settings.json` to keep history). Sessions whose transcript is gone are still listed
as **archived**, rebuilt from `history.jsonl` (the prompts you typed, by `sessionId`) and any
leftover `projects/*/sessions-index.json` (title, branch, start/end). They have no responses,
usage or cost, and are not auto-classified. On the usage timeline they count toward the
Sessions metric (model `(archived)`), placed at their prompt timestamps.

Per-tool token figures are estimates (≈4 characters per token); session and model costs use
the exact usage that the API reported.
