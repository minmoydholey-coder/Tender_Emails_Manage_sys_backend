# Match Emails Portal - Codebase Summary

## Overview
This repository is a portal that syncs Google Sheets tender data with email threads stored in a MySQL database, matches tender IDs against email content, and exposes the results through an Express API plus a React frontend.

## Main Components

### `server.js`
The backend server and sync engine.

Key responsibilities:
- Loads environment variables from `.env`
- Initializes database schema for `tender_matches`
- Connects to Google Sheets via `credentials.json` / `token.json`
- Connects to MySQL using `mysql2/promise`
- Supports automatic background sync and manual `/api/sync`
- Parses tenders from Google Sheets and matches them against email threads
- Writes tender-email match records to the `tender_matches` table
- Uses OpenAI for email summarization, status inference, reply decision, and reply suggestion
- Serves frontend assets from `dist/` when present

Important server logic:
- `runSync()` — main synchronization workflow
  - loads last sync cache
  - fetches current tender list from Google Sheets
  - optionally performs incremental sync or full sync
  - fetches emails from MySQL and normalizes text
  - matches tenders with emails using token regexes
  - stores matches into `tender_matches`
  - saves sync metadata to `data/sync_cache.json`
- `fetchGoogleSheetTenders()` — fetches the entire sheet tab range
- `parseSheetRows(rows)` — converts sheet rows into tender objects
- `fetchEmailsFromDb(sinceDateOrId)` — reads email thread rows from MySQL
- `getEmailSummary(subject, body, ocrText)` — OpenAI-based or rule-based summary
- `getTenderStatus(subject, body, summary)` — AI/rule-based tender status label
- `getReplyDecision(subject, body, summary)` — decides whether a reply is required
- `getReplySuggestion` route — drafts a reply using OpenAI

API endpoints:
- `GET /api/sync` — triggers a manual sync
- `GET /api/status` — health status of Google Sheets, DB, and OpenAI
- `GET /api/sync-info` — cache sync metadata and match counts
- `GET /api/tenders` — returns tenders merged with match data
- `GET /api/tenders/:rowNumber/emails` — matched emails for a tender row
- `GET /api/recent-matches` — latest matched emails for dashboard
- `GET /api/matched-emails` — matched emails list with optional date filters
- `POST /api/emails/:id/summarize` — regenerate email summary
- `GET /api/emails/:id/reply-suggestion` — draft reply content
- `POST /api/emails/send` — send an email via SMTP

### `matcher.js`
Matcher utility module for tender token extraction and email matching.

Key functions:
- `extractTenderTokens(rawString)` — extracts tender tokens from a sheet string using regex patterns for slash/dash/underscore codes, large numbers, reference codes, and mixed alphanumeric IDs.
- `normalizeText(text)` — lowercases and collapses whitespace for matching
- `makeTokenRegex(token)` — builds a flexible regex for token matching with boundaries and optional spaces around separators
- `checkMatch(tokens, subject, body, ocrText)` — finds matches using normalized email content
- `checkMatchNormalized(tokens, normSubject, normBody, normOcr)` — same with pre-normalized strings
- `checkMatchCompiled(compiledRegexes, normSubject, normBody, normOcr)` — checks precompiled regexes for high/medium/none confidence

### `frontend/`
React + Vite application for the user interface.

Important files:
- `frontend/src/main.jsx` — React root bootstrap
- `frontend/src/App.jsx` — main UI and client-side app logic
- `frontend/App.css` — app styles
- `frontend/index.css` — global styles

Frontend features:
- dashboard of matched tenders and status
- tender list and matched email browsing
- manual portal sync button
- filters for participated tenders, matched emails, date ranges, and excluded domains
- reply suggestion and email sending UI

### `package.json`
Root Node project config for the server app.
- dependencies: `express`, `cors`, `dotenv`, `googleapis`, `mysql2`, `nodemailer`, `openai`
- type: `commonjs`

### `frontend/package.json`
Frontend package config for Vite and React.
- dependencies: `react`, `react-dom`, `lucide-react`
- devDependencies: `vite`, `@vitejs/plugin-react`, `eslint`, etc.

## Utility scripts

### `check-databases.js`
A small database debug script that connects to MySQL and retrieves the latest matched email records per tender.

### `debug-check.js`
Debug helper that loads the sync cache and scans all stored threads in MySQL for tender matches, printing details.

### `test-match.js`
Tests the matcher logic in `matcher.js` with representative tender strings and email match assertions.

### `test-latest-status.js`
Searches `data/sync_cache.json` for specific row numbers or tender IDs to inspect cached tender entries.

### `get-sheet-rows.js`
Reads and inspects the cached sheet rows from `data/sync_cache.json` by tender row number or token.

### `setup-mock-db.js`
Creates or seeds mock email records for the database, useful for local testing of matching logic.

### `list-matched-tokens.js`
Lists all unique matched tokens currently stored in the `tender_matches` table.

## Configuration files

### `.env`
Contains server, MySQL, Google Sheets, and OpenAI configuration.
Key variables:
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_TABLE`
- `GOOGLE_SPREADSHEET_ID`, `GOOGLE_SHEET_GID`
- `OPENAI_API_KEY`
- `SYNC_INTERVAL_MS` — controls automatic sync frequency
- `FORCE_FULL_SYNC` — when true, forces full data sync instead of incremental 7-day sync

### `credentials.json` and `token.json`
Google API auth files used by the Google Sheets client.

## Data storage

### `data/sync_cache.json`
Stores the most recent sheet sync payload and metadata for the portal UI and incremental sync logic.

## Build output

### `dist/`
Contains built frontend assets for production deployment.

## How the sync flow works

1. `server.js` starts and initializes the DB schema.
2. Background sync runs on an interval (`SYNC_INTERVAL_MS`) and can also be triggered manually.
3. Sync fetches all tenders from Google Sheets and saves the cache.
4. If no new tenders are found and `FORCE_FULL_SYNC` is disabled, sync scans emails from the last 7 days; otherwise it performs a full scan.
5. The matcher extracts tokens from each participated tender and matches them against normalized email content.
6. Matches are inserted into `tender_matches`, with AI-generated summary, status, and reply decision metadata.
7. The React frontend reads `/api/tenders`, `/api/recent-matches`, and `/api/tenders/:rowNumber/emails` to visualize results.

## Notes
- The backend is CommonJS, while the frontend uses ES modules.
- The actual email source table in MySQL is configurable through environment variables.
- The app has a strong focus on heuristic tender token extraction and email matching.

---
This summary has been created as `CODEBASE_SUMMARY.md` in the project root.