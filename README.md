<div align="center">

# DocSpace

**A self-hosted, collaborative documentation platform that runs entirely on your own hardware.**

Write, review, publish and search your docs — with real-time co-editing, branches and change requests, API references, analytics and optional local AI — and **no dependency on third-party services**.

![Version](https://img.shields.io/badge/version-1.0.0-2557d6)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL%208%20%2F%20MariaDB%2010.6-4479A1?logo=mysql&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-D97757)

</div>

> 🤖 **Built with Claude Code.** This project was designed and developed with the help of [Claude Code](https://claude.com/claude-code), Anthropic's agentic coding tool. See [Acknowledgements](#acknowledgements) for details.

---

## Table of contents

- [Overview](#overview)
- [Demo login](#demo-login)
- [Quick start](#quick-start)
- [Features](#features)
- [Configuration](#configuration)
- [Local AI (optional)](#local-ai-optional)
- [Deployment](#deployment)
- [Testing](#testing)
- [REST API](#rest-api)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Acknowledgements](#acknowledgements)

---

## Overview

DocSpace is a complete documentation workspace you run on your own machine or server. The editor, real-time collaboration, search, AI, analytics, file storage and public site publishing all run locally.

| Layer | Technology |
| --- | --- |
| Frontend | React · TypeScript · Tailwind CSS (Vite) · TipTap / ProseMirror |
| Backend | Node.js · Express · TypeScript |
| Collaboration | Yjs CRDT over WebSockets |
| Database | MySQL 8+ or MariaDB 10.6+ |
| Cache / scaling | Redis *(optional)* |
| File storage | Local disk, or any self-hosted S3 (MinIO, SeaweedFS, Garage, Ceph) |
| AI | Ollama, LM Studio, llama.cpp, vLLM or any OpenAI-compatible server *(optional)* |

---

## Demo login

After running `npm run seed` (see [Quick start](#quick-start)), sign in at **http://localhost:4000** with:

| Field | Value |
| --- | --- |
| **Email** | `admin@docspace.local` |
| **Password** | `ChangeMe123` |

This account is the instance administrator and owner of the demo organization **Acme Inc.**, which contains two published sites:

| Site | URL | Contents |
| --- | --- | --- |
| Product Docs | http://localhost:4000/s/acme/product-docs | Guides, quickstart, configuration and troubleshooting pages |
| API Reference | http://localhost:4000/s/acme/api | Reference generated from a bundled OpenAPI spec, with a "Try it" playground |

> [!WARNING]
> These are **demo credentials only**. Change the password under **Account & security** right after signing in, and never expose a seeded instance to the internet as-is.
> You can choose different seed credentials with the `SEED_EMAIL` and `SEED_PASSWORD` environment variables before running `npm run seed`.

Prefer to start empty? Skip `npm run seed` — the first account you register becomes the instance administrator.

---

## Quick start

Works on **Windows, macOS and Linux**. Docker is not required.

### Prerequisites

- **Node.js 20 or newer**
- **MySQL 8+** or **MariaDB 10.6+**, running locally
- *Optional:* Redis, and a local AI model server

### 1. Install dependencies

```bash
npm install
```

### 2. Create your configuration

Generates `.env` with a random `APP_SECRET` and your database settings:

```bash
node scripts/setup.mjs --db-user=root --db-password=YOUR_DB_PASSWORD
```

### 3. Build the app

```bash
npm run build
```

### 4. Load the demo data *(optional)*

```bash
npm run seed
```

### 5. Start the server

```bash
npm start
```

Open **http://localhost:4000** and sign in with the [demo login](#demo-login).

> [!NOTE]
> The database (`DB_NAME`, default `docspace`) is created automatically if your database user has permission; otherwise create it first. Migrations run automatically on every start.

### Development mode

```bash
npm run dev
```

Runs the API with auto-reload on port `4000` and the Vite dev server on **http://localhost:5173** (proxied to the API, including WebSockets).

### Docker *(optional)*

```bash
docker compose up -d --build
```

Starts the app, MySQL, Redis and Caddy. Add `--profile s3` for MinIO object storage or `--profile ai` for Ollama.

### Available scripts

| Command | What it does |
| --- | --- |
| `npm run setup` | Create or update `.env` |
| `npm run dev` | Start API + web app in development mode |
| `npm run build` | Build the web app and the server |
| `npm start` | Start the production server |
| `npm run migrate` | Run database migrations manually |
| `npm run seed` | Create the demo admin, organization and sites |
| `npm run typecheck` | Type-check both apps |

---

## Features

### ✍️ Editor
- Block-based TipTap / ProseMirror editor with a `/` slash command menu and bubble toolbar
- Markdown shortcuts and Markdown paste
- Rich text: bold, italic, underline, strikethrough, code, highlight, sub/superscript, links
- Headings, bulleted / numbered / task lists, quotes, dividers
- Syntax-highlighted code blocks (190+ languages) and resizable tables
- Callouts (info, success, warning, danger), expandables and tabs
- Mermaid diagrams with live preview
- Image, video, audio and file uploads (paste or drag & drop) and iframe embeds
- Internal page links, reusable (synced) content blocks and embedded API operations

### 🗂️ Structure
- Organizations → spaces → nested pages, with section groups and external links
- Drag-and-drop page tree, hide-from-nav, page icons and descriptions
- Space templates (product docs, API reference)
- Markdown import (single files or whole folders) and export

### 👥 Collaboration
- Real-time co-editing with live cursors and presence
- Inline comments anchored to text — threads, replies and resolve
- @mentions and in-app notifications

### 🔀 Review workflow
- Version history with diffs and one-click restore
- **Branches and change requests**, reviewers and required approvals
- Approve / request changes, merge with conflict detection and admin override
- "Sync branch with main", and an option to lock `main` behind change requests

### 🔐 Teams & permissions
- Roles: reader, commenter, reviewer, editor, creator, admin, owner
- Teams, per-space permissions for people and teams, restricted spaces
- Invitation links

### 🌐 Publishing
- Server-rendered, responsive, SEO-friendly sites at `/s/{org}/{space}` or on **custom domains** (DNS verification and automatic TLS with Caddy)
- Themes: colors, logo, favicon, font, light / dark / auto, header links, footer, custom CSS
- Titles, meta tags, Open Graph, JSON-LD, `sitemap.xml` and `robots.txt`
- Manual and automatic redirects
- Access control: **public, unlisted, password-protected, secret share link, members-only**
- **"View as visitor"** — signed-in members can preview exactly what outsiders see
- Redis-backed page cache with ETags

### 🔎 Search
- Hybrid search: MySQL full-text + semantic vector search, merged with Reciprocal Rank Fusion
- Works fully offline with built-in local embeddings, or with model embeddings (e.g. `nomic-embed-text`)

### 📘 API documentation
- Import OpenAPI 3.x / Swagger 2.0 (JSON or YAML — file, paste or URL)
- Generated reference pages per tag: parameters, request bodies, nested schemas, responses and examples
- Interactive **"Try it" playground** with auth, cURL snippets and an optional server-side relay (CORS-free, SSRF-guarded)

### 🤖 AI *(optional, runs locally)*
- Writing assistant: improve, fix, shorten, expand, simplify, change tone, explain, translate, continue, custom prompts and full-page drafts
- Page translation
- **"Ask AI"** chat on published sites, with citations and follow-up questions
- Content-gap detection, rule-based quality checks and AI editorial review
- `llms.txt`, `llms-full.txt` and a `.md` version of every page for AI agents

### 📊 Analytics
- Page views and anonymous visitors (no cookies; daily-rotating hash)
- Searches and zero-result searches, AI questions and unanswered questions
- Reader feedback (👍 / 👎 with comments)
- **AI agent traffic** (ChatGPT, Claude, Perplexity, Gemini, …), referrers and API playground usage

### 🔌 Integrations
- Webhooks: HMAC-signed, retries with backoff, delivery log and redelivery
- REST API with personal API tokens

### 🛡️ Security & administration
- bcrypt password hashing and TOTP two-factor authentication (enforceable per organization)
- Session management, IP allowlists and allowed email domains
- CSRF protection, rate limiting, Helmet / CSP
- Organization audit log with CSV export
- Instance admin console: health, users, organizations and maintenance

---

## Configuration

All settings live in `.env`. See [.env.example](.env.example) for the full, commented list. The most important ones:

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Public URL of the app (used for links, cookies and default site URLs) |
| `APP_SECRET` | Long random secret — required in production (`npm run setup` generates one) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL / MariaDB connection |
| `REDIS_URL` | Enables the Redis cache and pub/sub (required for multiple app instances) |
| `STORAGE_DRIVER` | `local` (default, uses `STORAGE_DIR`) or `s3` with the `S3_*` settings |
| `MAX_UPLOAD_MB` | Maximum upload size (default `50`) |
| `AI_PROVIDER` | `none` (default), `ollama`, or `openai` for any OpenAI-compatible server |
| `ALLOW_REGISTRATION` | Allow open sign-up (otherwise invitation only) |
| `TRUST_PROXY` | Set to `true` behind Caddy / Nginx so client IPs are correct |
| `PLAYGROUND_PROXY_ALLOW_PRIVATE` | Let the API playground relay call private-network hosts (e.g. `localhost`) |

---

## Local AI (optional)

Without any model, DocSpace still provides semantic search (local embeddings), extractive answers in *Ask AI*, offline fix / shorten / summarize, quality checks and content-gap detection.

For full generative features, install [Ollama](https://ollama.com) on the same machine or network and pull the models once:

```bash
ollama pull llama3.2
```

```bash
ollama pull nomic-embed-text
```

Then set the following in `.env` and restart:

```env
AI_PROVIDER=ollama
AI_CHAT_MODEL=llama3.2
AI_EMBED_MODEL=nomic-embed-text
```

Search indexes rebuild automatically when the embedding model changes. LM Studio, llama.cpp `server`, vLLM and LocalAI work with `AI_PROVIDER=openai` and their `AI_BASE_URL`.

---

## Deployment

DocSpace is a single stateless Node.js process plus MySQL. Production guides for native installs (systemd on Linux, Task Scheduler on Windows), Docker Compose, reverse proxies and custom domains are in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

Ready-made configs are in [`deploy/`](deploy): a [Caddyfile](deploy/Caddyfile), an [nginx.conf](deploy/nginx.conf) and a [systemd unit](deploy/docspace.service).

---

## Testing

With the server running and the demo data seeded:

**End-to-end smoke test** — login, branching, change requests with diffs, review, merge, publishing, versions, comments, quality checks, public search, feedback, AI-agent Markdown, analytics, content gaps, webhooks, audit log and admin stats:

```bash
node scripts/smoke-test.mjs
```

**Published-site access test** — every visibility mode, for anonymous visitors, signed-in members, "view as visitor", password unlocks and share links:

```bash
node scripts/access-test.mjs
```

**Type checking** for both apps:

```bash
npm run typecheck
```

Both test scripts accept an optional base URL, e.g. `node scripts/access-test.mjs http://localhost:4000`.

---

## REST API

Every action in the UI goes through the JSON API under `/api`. Create a personal token under **Account & security → API tokens** and send it as:

```http
Authorization: Bearer dsk_…
```

Useful endpoints:

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/orgs/:org/spaces` | List spaces in an organization |
| `GET` | `/api/spaces/:id` | Get a space |
| `GET` | `/api/spaces/:id/branches/:branchId/tree` | Get the page tree of a branch |
| `POST` | `/api/spaces/:id/branches/:branchId/pages` | Create a page |
| `PUT` | `/api/pages/:pageId/content` | Replace page content (`{ markdown }` or `{ content }`) — ideal for publishing from CI |
| `POST` | `/api/spaces/:id/branches/:branchId/import` | Bulk Markdown import |
| `POST` | `/api/spaces/:id/openapi` | Import or refresh an OpenAPI spec (`{ url }` or `{ text }`) |
| `POST` | `/api/spaces/:id/change-requests` | Open a change request |
| `POST` | `/api/spaces/:id/change-requests/:n/merge` | Merge a change request |
| `GET` | `/api/public/sites/:spaceId/search?q=` | Public site search |
| `POST` | `/api/public/sites/:spaceId/ask` | Public "Ask AI" |

**Webhook signatures:** verify the `X-DocSpace-Signature` header as

```
sha256 = HMAC_SHA256(secret, "<X-DocSpace-Timestamp>.<raw body>")
```

---

## Architecture

```
            ┌──────────────── Caddy / Nginx (TLS, custom domains) ────────────────┐
            │                                                                      │
   Browser ─┼─▶  Node.js app (stateless, scale horizontally)                       │
            │     ├─ /api/*            REST API (auth, orgs, spaces, pages, CRs…) │
            │     ├─ /collab/:pageId   Yjs WebSocket sync (y-protocols)           │
            │     ├─ /s/:org/:space/*  server-rendered published sites            │
            │     ├─ custom domains    same renderer, chosen by Host header        │
            │     ├─ /files/*          uploads (local disk or S3-compatible)       │
            │     └─ SPA (editor/dashboard) served from apps/web/dist             │
            └──────────────────────────────────────────────────────────────────────┘
                  │                    │                          │
               MySQL               Redis (optional)         Ollama / OpenAI-compatible
         content, versions,     page cache, rate limits,      server (optional, local)
         search index, events   pub/sub for collaboration
```

- **Content model** — pages are stored as ProseMirror JSON plus a Yjs document. The collaboration server persists Yjs state and derives JSON and plain text for rendering, search and diffs.
- **Branching** — each space has a `main` branch. A branch copies pages and records the `main` version it forked from; merges apply changed pages and detect conflicts when `main` has moved on.
- **Publishing** — published sites always render `main`. Every change bumps a per-space `content_version` that namespaces the HTML cache, so there are no stale pages and no manual purges.
- **Scaling** — run several app instances behind the proxy with `REDIS_URL` set. Redis relays Yjs updates between nodes and shares the cache. Webhook delivery uses `SELECT … FOR UPDATE SKIP LOCKED`, so any node can process the queue.

---

## Project structure

```
apps/
  server/     Express API, collaboration, site renderer, search, AI and workers (TypeScript)
  web/        React SPA: dashboard, editor, settings and insights (TypeScript + Tailwind)
deploy/       Caddyfile, nginx.conf and systemd unit
docs/         Deployment guide
scripts/      Setup, dev runner, smoke test and access test
```

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Access denied` / cannot connect to the database | Check the `DB_*` values in `.env`, or rerun `node scripts/setup.mjs` with the right credentials. |
| Database does not exist | Create it manually: `CREATE DATABASE docspace CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;` |
| Demo login doesn't work | Make sure you ran `npm run seed` against the same database the server uses. |
| Published site looks open even though it is restricted | You're signed in as a member. Use **View as visitor** on the site, or a private window. |
| AI features are greyed out or limited | Set `AI_PROVIDER` and the model variables in `.env`, then restart. |
| Real-time editing doesn't sync across multiple servers | Set `REDIS_URL` on every instance. |

---

## Acknowledgements

This project was built with the help of **[Claude Code](https://claude.com/claude-code)**, Anthropic's agentic coding tool, which was used throughout development for design, implementation, testing and documentation.

DocSpace also stands on the shoulders of great open-source projects, including [TipTap](https://tiptap.dev), [ProseMirror](https://prosemirror.net), [Yjs](https://yjs.dev), [React](https://react.dev), [Vite](https://vitejs.dev), [Tailwind CSS](https://tailwindcss.com), [Express](https://expressjs.com), [Mermaid](https://mermaid.js.org) and [Ollama](https://ollama.com).
