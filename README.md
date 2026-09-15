# 2MG Invoice Ledger

A shared Pro Forma Invoice archive for the Finance team — create, edit, and
export invoices to a branded PDF. Replaces duplicating the old Excel
"Pro Forma Invoice" tab per client.

A small backend holds one shared invoice archive that every person who opens
the app sees and edits. Storage is **Turso** (hosted, SQLite-compatible) when
deployed, or a local SQLite file with zero setup when run on your own
machine — see `lib/db.js`.

This app can run two ways from the exact same code:

- **Vercel** (recommended) — `server.js` is not used; Vercel runs
  `api/state.js` as a serverless function and serves `public/` automatically.
- **Your own server/VPS** (Render, Railway, Fly.io, a company server) — run
  `server.js`, a normal long-lived Node/Express process.

Both talk to the same `lib/db.js` storage layer, so there's exactly one
implementation of the save/load/versioning logic either way.

## Run it locally

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

With no setup at all, this uses a local SQLite file at `data/invoices.db` —
fine for trying things out, but that file lives only on your machine.

To point local dev at the real shared Turso database instead, copy
`.env.example` to `.env` and fill in `TURSO_DATABASE_URL` /
`TURSO_AUTH_TOKEN` (see below) — `npm start` picks these up automatically.

Change the port with an environment variable:

```bash
PORT=8080 npm start
```

## Deploying to Vercel (GitHub → Vercel)

### 1. Create a Turso database (one-time)

Vercel's serverless functions have no persistent disk, so the shared archive
needs to live somewhere reachable over the network — that's Turso, a hosted
SQLite-compatible database with a generous free tier.

1. Go to **https://turso.tech** and sign up (this has to be done by someone
   on the team directly — Claude can't create third-party accounts).
2. Create a database (via their web dashboard, or the `turso` CLI:
   `turso db create invoice-ledger`).
3. Get the two values the app needs:
   - **Database URL** — looks like `libsql://invoice-ledger-yourname.turso.io`
   - **Auth token** — a long token string
   Both are shown in the Turso dashboard for the database, or via
   `turso db show invoice-ledger --url` and `turso db tokens create invoice-ledger`.

### 2. Migrate your existing invoices into it (one-time)

The Turso database starts empty. To move your real archive into it instead
of starting over:

1. On the machine that has the real `data/invoices.db` (the one this app has
   been saving to), create a `.env` file in the project folder (copy
   `.env.example`) with the `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` from
   step 1.
2. Run `npm start` **once**. On startup it will detect the empty Turso
   database, find your local `data/invoices.db`, and import everything into
   Turso automatically — you'll see a log line like
   `Importing existing archive from .../invoices.db (7 invoice(s), version 19)...`
3. Open `http://localhost:3000` and confirm your real invoices are there.
   From this point on, Turso is the source of truth — the local file is no
   longer needed (keep it as a backup, it doesn't hurt anything).

### 3. Push this project to GitHub

If it isn't already, get this project into a GitHub repo (already done for
this project — `srsjyy/invoice-ledger-app`).

### 4. Create the Vercel project

1. Go to **https://vercel.com** and sign in (with GitHub is easiest).
2. **Add New → Project**, import the `invoice-ledger-app` GitHub repo.
3. Framework Preset: **Other** (this is a plain static + serverless-function
   project, not a framework Vercel needs to build).
4. Leave Build Command / Output Directory as their defaults — nothing needs
   building here.
5. Before deploying, add **Environment Variables**:
   - `TURSO_DATABASE_URL` = the value from step 1
   - `TURSO_AUTH_TOKEN` = the value from step 1
6. Click **Deploy**.

Vercel automatically serves everything in `public/` at the site root and
turns `api/state.js` into the `/api/state` endpoint — no `vercel.json` or
extra config needed for this project.

### 5. Verify

Open the Vercel URL, confirm the real invoices show up, create/edit a test
invoice, refresh, and confirm it's still there. From then on, every push to
the connected GitHub branch redeploys automatically.

## Deploying the traditional way (Render / Railway / Fly.io / your own VPS)

Instead of Vercel, `server.js` can run as a normal long-lived Node process
anywhere that supports one:

1. Connect this GitHub repo as a Web Service (build command `npm install`,
   start command `npm start`).
2. Add the same two environment variables as above
   (`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`) so it shares the same archive
   as the Vercel deployment (or any other deployment) — or omit them to use
   a local SQLite file instead, in which case that file only reflects that
   one instance.
3. Deploy.

## How the shared archive works

- `GET /api/state` — loads the current archive (`{ version, invoices }`)
- `PUT /api/state` — saves it, with a simple version-number check: if two
  people save around the same time, whoever's request arrives second gets a
  "conflict" response and the app automatically adopts the other person's
  saved version instead of overwriting it (a toast tells them this happened).
  This is enforced with a real database transaction, so it holds even when
  requests arrive as genuinely simultaneous, separate serverless invocations
  (as they do on Vercel).
- Every browser polls for updates every 8 seconds while looking at the
  archive list (not while someone is actively editing an invoice), so
  changes from other teammates show up without a manual refresh.
- If this app previously ran an older plain-JSON or local-SQLite version,
  its data is imported automatically into Turso the first time it connects
  to an empty Turso database — see "Migrate your existing invoices" above.

## Project structure

```
invoice-ledger-app/
├── server.js            Express server for self-hosting (Render/VPS/local
│                          dev) — serves the frontend + /api/state
├── api/
│   └── state.js          The same /api/state API as a Vercel serverless
│                          function — this is what Vercel actually runs
├── lib/
│   └── db.js              Shared storage/versioning logic used by both of
│                          the above — the only place the database logic lives
├── seed-state.json       Starting data, only used on a genuinely fresh
│                          install with no prior data anywhere
├── .env.example          Copy to .env for local dev against Turso
├── package.json
├── data/                  Local-only fallback database (gitignored) — not
│                          used once TURSO_DATABASE_URL is set
└── public/
    ├── index.html         Page shell
    ├── styles.css         All styling (GetMeds blue/green brand colors)
    └── app.js             The whole client-side app: rendering, editing,
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
- **Change the API/storage behavior:** edit `lib/db.js` (used by both
  `server.js` and `api/state.js` — one change updates both deployment paths).

No build step — this is plain HTML/CSS/JS plus a small storage layer, so
frontend changes take effect on a page refresh, and backend changes take
effect on the next deploy (Vercel) or server restart (self-hosted).

## Relationship to the claude.ai-hosted version

A version of this same tool is also published as a Claude Artifact — same
look, same fields, same PDF export — where the "server" is Claude's Artifact
platform instead of this app. That version needs zero hosting/setup but only
works on claude.ai. This folder is the standalone version to run wherever
your organization can host it. The two are separate copies; a change made in
one does not automatically appear in the other.
