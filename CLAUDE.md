# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # Run the server (http://localhost:3000)
```

No test runner or linter is configured. Node >= 18 required.

## Environment

`.env.example` references an `MTA_API_KEY` but the app currently makes unauthenticated requests to `api-endpoint.mta.info` and works without one.

## Architecture

Single-file Express server (`server.js`) + static frontend (`public/index.html`).

### Data flow

1. **Static station data** — fetched once from the MTA GTFS zip (`google_transit.zip`), cached in memory for 24 hours. Parsed into a station list (parent stops grouped by name) and a `stopNameMap` (stop_id → name) used to derive live headsigns.

2. **Live arrivals** (`GET /api/arrivals?stopIds=235,D24,R31`) — accepts one or more parent stop IDs, maps each to the correct MTA GTFS-RT feed URL (`feedUrlForStopId`), fetches in parallel, and merges results. Results are cached 15 seconds per unique stop-ID set.

3. **LIRR special case** — when Atlantic Av-Barclays Ctr stops are requested (`ATLANTIC_PARENT_STOPS`), an additional LIRR feed is fetched and filtered to only show departures from Atlantic Terminal (stop 349) that subsequently stop at Jamaica (stop 102).

### Key design decisions

- **Feed routing**: MTA splits realtime data across multiple feed endpoints by line group (1/2/3, A/C/E, B/D/F/M, etc.). `feedUrlForStopId` maps a parent stop ID's prefix to the right endpoint.
- **Headsign derivation**: The destination shown to users comes from `stopNameMap` (the last stop in each trip's live sequence), not from GTFS static trip headsign data — this reflects the actual current terminus.
- **Directional stop IDs**: GTFS-RT uses `stopId + "N"` / `stopId + "S"` suffixes for platform direction. The server matches both and annotates each arrival accordingly.
