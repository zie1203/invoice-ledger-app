# 2MG Invoice Ledger

A shared Pro Forma Invoice archive for the Finance team — create, edit, and
export invoices to a branded PDF. Replaces duplicating the old Excel
"Pro Forma Invoice" tab per client.

This is the **self-hosted** version: a small Node.js server holds one shared
invoice archive that every person who opens the app sees and edits, backed
by a plain JSON file on disk (no database account or API key to set up).

## Run it

Requires Node.js 18+.

```bash
npm install
npm start
```

Then open **http://localhost:3000** — or whatever host/port you deploy it to.

Change the port with an environment variable:

```bash
PORT=8080 npm start
```

## Deploying

This is a normal Node.js web app — deploy it anywhere that can run a
long-lived Node process: your own server/VPS, or a host like Render,
Railway, Fly.io, or a company app server. It needs:

- Node 18+
- One persistent folder for `data/state.json` (this is the entire
  database — back it up like you would any other file)
- No other services, accounts, or API keys

It is **not** compatible with static-only hosting (GitHub Pages, S3, a plain
CDN) since it needs a running server process for the shared archive to work.
If that's the only hosting available, say so and the app can be adapted to
use a hosted database instead (e.g. Firebase/Supabase) — that's a different,
bigger change from what's here.

## How the shared archive works

- `GET /api/state` — loads the current archive (`{ version, invoices }`)
- `PUT /api/state` — saves it, with a simple version-number check: if two
  people save around the same time, whoever's request arrives second gets a
  "conflict" response and the app automatically adopts the other person's
  saved version instead of overwriting it (a toast tells them this happened).
- Every browser polls for updates every 8 seconds while looking at the
  archive list (not while someone is actively editing an invoice), so
  changes from other teammates show up without a manual refresh.
- The whole archive lives in `data/state.json`. Back this file up the way
  you'd back up any other business file — it's plain JSON, readable in any
  text editor if you ever need to inspect or hand-edit it.

## Project structure

```
invoice-ledger-app/
├── server.js          Express server: serves the frontend + the /api/state API
├── seed-state.json     The starting data (the two real invoices from the
│                        original template) — only used the very first time
│                        data/state.json doesn't exist yet
├── package.json
├── data/                Created automatically; state.json lives here
└── public/
    ├── index.html       Page shell
    ├── styles.css       All styling (GetMeds blue/green brand colors)
    └── app.js           The whole client-side app: rendering, editing,
                          PDF export, and talking to /api/state
```

## Editing

- **Change what a Pro Forma Invoice looks like on screen or in the exported
  PDF:** edit `public/app.js` — `renderEditor()` builds the on-screen form,
  `exportPDF()` builds the PDF (using jsPDF + jspdf-autotable, loaded from
  cdnjs in `public/index.html`).
- **Change styling/branding:** edit `public/styles.css`. Brand colors are
  CSS variables at the top (`--blue`, `--green`, etc.) — GetMeds' official
  palette (blue `#1EA0DA`, green `#61A644`, white, black for body text only).
  Don't introduce other colors.
- **Change the API/storage behavior:** edit `server.js`.

No build step — this is plain HTML/CSS/JS and a small Express server, so
changes take effect on a page refresh (frontend) or a server restart
(`server.js`).

## Relationship to the claude.ai-hosted version

A version of this same tool is also published as a Claude Artifact — same
look, same fields, same PDF export — where the "server" is Claude's Artifact
platform instead of this Node app. That version needs zero hosting/setup but
only works on claude.ai. This folder is the standalone version to run
wherever your organization can host it. The two are separate copies; a
change made in one does not automatically appear in the other.
