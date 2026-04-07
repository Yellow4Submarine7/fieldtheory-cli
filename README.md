# Field Theory CLI

Sync and store locally all of your X/Twitter bookmarks. Search, classify, and make them available to Claude Code, Codex, or any agent with shell access.

Free and open source. Designed for Mac.

## Install

```bash
npm install -g fieldtheory
```

Requires Node.js 20+ and Google Chrome.

## Quick start

```bash
# 1. Sync your bookmarks (needs Chrome logged into X)
ft sync

# 2. Search them
ft search "distributed systems"

# 3. Explore
ft viz
ft categories
ft stats
```

On first run, `ft sync` extracts your X session from Chrome and downloads your bookmarks into `~/.ft-bookmarks/`.

## Sync liked tweets

If you use likes as your primary way to save tweets, use `ft sync-likes`:

```bash
# Sync your liked tweets (auto-detects user ID from Chrome cookies)
ft sync-likes

# Explicitly pass your Twitter user ID
ft sync-likes --user-id 123456789

# Full crawl, then classify
ft sync-likes --full --classify
```

Liked tweets are stored in `~/.ft-bookmarks/likes.jsonl` and indexed into the same search database as bookmarks, so `ft search`, `ft classify`, `ft viz`, and all other commands work on both.

The Likes API query ID may change over time. If sync fails, set a new one via:

```bash
export FT_LIKES_QUERY_ID=newQueryIdHere
```

## Export to Markdown

Export your bookmarks and/or likes to Markdown files for use with NotebookLM, Obsidian, or any Markdown-compatible tool:

```bash
# Export everything (bookmarks + likes) to current directory
ft export-md

# Export only likes
ft export-md --source likes

# Export only bookmarks, 100 tweets per file, to a specific directory
ft export-md --source bookmarks --batch-size 100 --out-dir ./export

# Then upload the .md files to NotebookLM or drag into Obsidian
```

Each Markdown file contains up to 200 tweets (configurable via `--batch-size`), formatted with author, date, text, links, and engagement stats. NotebookLM supports up to 50 sources per notebook, so for large collections, use a larger batch size.

### Incremental export

Use `--since` to export only records synced after a given date — useful for daily automation:

```bash
# Export only likes synced after a specific date
ft export-md --source likes --since 2026-04-06T00:00:00Z --out-dir ./new-likes
```

When `--since` is provided, output files are named with the current date (e.g. `likes-2026-04-07.md`) instead of sequential numbers, making them safe to accumulate without overwriting.

## Commands

| Command | Description |
|---------|-------------|
| `ft sync` | Download and sync all bookmarks (no API required) |
| `ft sync --classify` | Sync then classify new bookmarks with LLM |
| `ft sync --full` | Full history crawl (not just incremental) |
| `ft sync-likes` | Download and sync your liked tweets |
| `ft sync-likes --user-id <id>` | Sync likes with explicit Twitter user ID |
| `ft search <query>` | Full-text search with BM25 ranking |
| `ft viz` | Terminal dashboard with sparklines, categories, and domains |
| `ft classify` | Classify by category and domain using LLM |
| `ft classify --regex` | Classify by category using simple regex |
| `ft categories` | Show category distribution |
| `ft domains` | Subject domain distribution |
| `ft stats` | Top authors, languages, date range |
| `ft list` | Filter by author, date, category, domain |
| `ft show <id>` | Show one bookmark in detail |
| `ft index` | Merge new bookmarks into search index (preserves classifications) |
| `ft export-md` | Export to Markdown files (for NotebookLM, Obsidian, etc.) |
| `ft export-md --since <date>` | Incremental export (only records synced after date) |
| `ft auth` | Set up OAuth for API-based sync (optional) |
| `ft sync --api` | Sync via OAuth API (cross-platform) |
| `ft fetch-media` | Download media assets (static images only) |
| `ft status` | Show sync status and data location |
| `ft path` | Print data directory path |

## Agent integration

Now you can ask your agent:

> "What have I bookmarked about cancer research in the last three years and how has it progressed?"

> "I bookmarked a number of new open source AI memory tools. Pick the best one and figure out how to incorporate it in this repo."

> "Every day please sync any new X bookmarks using the Field Theory CLI."

Works with Claude Code, Codex, or any agent with shell access. Just tell your agent to use the `ft` CLI.

## Scheduling

```bash
# Sync every morning at 7am
0 7 * * * ft sync

# Sync and classify every morning
0 7 * * * ft sync --classify
```

### Daily likes → NotebookLM pipeline

A bundled `daily-sync.sh` script can sync new likes, export them incrementally, and upload to NotebookLM automatically:

```bash
# Install the script
cp scripts/daily-sync.sh ~/.ft-bookmarks/daily-sync.sh
chmod +x ~/.ft-bookmarks/daily-sync.sh

# Register as a macOS LaunchAgent (runs daily at 11am local time)
cp scripts/com.ft.daily-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ft.daily-sync.plist
```

Requires [`notebooklm-py`](https://github.com/nicholasgasior/notebooklm-py) and [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) for uploads and desktop notifications. Logs are written to `~/.ft-bookmarks/sync.log`.

## Data

All data is stored locally at `~/.ft-bookmarks/`:

```
~/.ft-bookmarks/
  bookmarks.jsonl         # raw bookmark cache (one per line)
  likes.jsonl             # raw likes cache (one per line)
  bookmarks.db            # SQLite FTS5 search index (bookmarks + likes)
  bookmarks-meta.json     # sync metadata
  likes-backfill-state.json  # likes sync state
  oauth-token.json        # OAuth token (if using API mode, chmod 600)
```

Override the location with `FT_DATA_DIR`:

```bash
export FT_DATA_DIR=/path/to/custom/dir
```

To remove all data: `rm -rf ~/.ft-bookmarks`

## Categories

| Category | What it catches |
|----------|----------------|
| **tool** | GitHub repos, CLI tools, npm packages, open-source projects |
| **security** | CVEs, vulnerabilities, exploits, supply chain |
| **technique** | Tutorials, demos, code patterns, "how I built X" |
| **launch** | Product launches, announcements, "just shipped" |
| **research** | ArXiv papers, studies, academic findings |
| **opinion** | Takes, analysis, commentary, threads |
| **commerce** | Products, shopping, physical goods |

Use `ft classify` for LLM-powered classification that catches what regex misses.

## Platform support

| Feature | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Chrome session sync (`ft sync`) | Yes | No* | No* |
| OAuth API sync (`ft sync --api`) | Yes | Yes | Yes |
| Search, list, classify, viz | Yes | Yes | Yes |

\*Chrome session extraction uses macOS Keychain. On other platforms, use `ft auth` + `ft sync --api`.

## Security

**Your data stays local.** No telemetry, no analytics, nothing phoned home. The CLI only makes network requests to X's API during sync.

**Chrome session sync** reads cookies from Chrome's local database, uses them for the sync request, and discards them. Cookies are never stored separately.

**OAuth tokens** are stored with `chmod 600` (owner-only). Treat `~/.ft-bookmarks/oauth-token.json` like a password.

**The default sync uses X's internal GraphQL API**, the same API that x.com uses in your browser. For the official v2 API, use `ft auth` + `ft sync --api`.

## License

MIT — [fieldtheory.dev/cli](https://fieldtheory.dev/cli)
