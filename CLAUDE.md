# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app does

Real-time NYC subway arrival board. Select any subway station; see each line's next trains grouped by destination (MTA headsign), auto-refreshing every 30 seconds. Atlantic Av-Barclays Ctr also shows LIRR departures filtered to trains that stop at Jamaica Station (for JFK AirTrain connection).

## Commands

```bash
npm install      # first time only
npm start        # serves http://localhost:3000
```

### Auto-start (macOS Launch Agent)

The app is configured to start automatically on login via a launchd Launch Agent.

```bash
# Stop and disable
launchctl unload ~/Library/LaunchAgents/com.garyclarke.subway.plist

# Start and enable
launchctl load ~/Library/LaunchAgents/com.garyclarke.subway.plist

# Check status (PID + exit code 0 = running)
launchctl list | grep subway

# View logs
cat /tmp/subway.log
```

Node >= 18 required (uses built-in `fetch`). No test runner or linter configured.

## Environment

No API key is required. The MTA removed the key requirement from their GTFS-RT feeds. The `.env.example` file is a leftover artifact and can be ignored.

## Architecture

Single Express server (`server.js`) + static frontend (`public/index.html`). No build step.

### Startup sequence

On `npm start` the server:
1. Fetches the MTA NYCT GTFS static zip (`google_transit.zip`) from `web.mta.info`
2. Parses `stops.txt` → builds a station list (379 parent stations, grouped by name) and a `stopNameMap` (stop_id → station name)
3. Caches both in memory for 24 hours
4. Begins serving on port 3000

### API endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/stations` | Returns all 379 NYC subway stations with their parent stop IDs |
| `GET /api/arrivals?stopIds=235,D24,R31` | Returns live arrivals for the given stop IDs, sorted by minutes away |

Arrival results are cached 15 seconds per unique stop-ID set to avoid hammering the MTA feeds.

### Stop ID system

MTA GTFS uses **parent stop IDs** for stations and directional child IDs for platforms:
- Parent: `235` (Atlantic Av-Barclays Ctr, IRT)
- Children: `235N` (northbound), `235S` (southbound)

The API accepts parent stop IDs; the server adds N/S suffixes internally for matching.

**Atlantic Av-Barclays Ctr** has three parent stop IDs (one per line group):
- `235` — 2/3/4/5 trains (IRT Eastern Parkway)
- `D24` — B/D trains (BMT Brighton Line)
- `R31` — N/Q/R trains (BMT Fourth Ave / Sea Beach)

**Important historical note**: the IRT stop ID was originally coded as `234` (wrong) and the LIRR Atlantic Terminal stop was coded as `1` (wrong). The correct values are `235` and `349` respectively.

### Feed routing

MTA splits real-time data across multiple feed endpoints by line group. `feedUrlForStopId(stopId)` maps a parent stop ID's prefix to the correct endpoint:

| Stop ID prefix | Feed | Lines |
|---|---|---|
| Numeric | `gtfs` | 1 2 3 4 5 6 7 |
| A, C, H | `gtfs-ace` | A C E |
| B, D, F, M | `gtfs-bdfm` | B D F M |
| G | `gtfs-g` | G |
| J, Z | `gtfs-jz` | J Z |
| L | `gtfs-l` | L |
| N, Q, R, W | `gtfs-nqrw` | N Q R W |
| S | `gtfs-si` | Staten Island Railway |

### Headsign derivation (destination names)

The MTA GTFS-RT trip IDs use a time-based operational format (e.g. `075050_1..S15R`) that does **not** match the scheduled trip IDs in static `trips.txt`. A direct `trip_id → headsign` lookup therefore fails.

Instead, the destination is derived from the **last stop in each trip's live `stopTimeUpdate` sequence**. That stop ID is looked up in `stopNameMap` to get the official MTA station name. This is more accurate than static headsigns anyway — it reflects the train's actual current terminus (accounting for short-turns mid-service).

### LIRR Jamaica filter

Activated only when Atlantic Av-Barclays Ctr stop IDs are in the request. For each LIRR trip:
1. Find stop `349` (LIRR Atlantic Terminal) in the stop sequence
2. Check if stop `102` (Jamaica Station) appears **after** it
3. If yes → include the departure; if not → skip (doesn't serve Jamaica)

Shows only "To Jamaica" departures — the use case is connecting to the JFK AirTrain at Jamaica.

### Frontend

`public/index.html` is a self-contained page (no framework, no build):

- **Station search**: autocomplete input backed by `/api/stations`, fuzzy substring match, keyboard navigable (↑↓ Enter Esc)
- **Persistence**: selected station stored in `localStorage`, restored on page load
- **Default station**: Atlantic Av-Barclays Ctr
- **Cards**: one per line, sections grouped by destination headsign (not N/S), sorted by most-frequent destination first
- **Refresh**: `setInterval` every 30 seconds; live pulse dot in header
- **Colors**: official MTA line colors; N/Q/R/W/G/L use dark text on light bullet backgrounds

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |
