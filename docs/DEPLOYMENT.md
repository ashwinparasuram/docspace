# Deploying DocSpace

DocSpace is a single Node.js process plus MySQL. Redis, S3-compatible storage, a reverse proxy and an AI model are optional add-ons you also host yourself.

## 1. Single machine, native (Windows or Linux)

1. Install Node.js 20+ and MySQL 8+ (or MariaDB 10.6+).
2. Create a database user (recommended over root):
   ```sql
   CREATE DATABASE docspace CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'docspace'@'localhost' IDENTIFIED BY 'a-strong-password';
   GRANT ALL ON docspace.* TO 'docspace'@'localhost';
   ```
3. In the project folder:
   ```bash
   npm ci
   ```
   ```bash
   node scripts/setup.mjs --env=production --db-password=a-strong-password --app-url=http://YOUR-HOST:4000
   ```
   ```bash
   npm run build
   ```
   ```bash
   npm start
   ```
4. Keep it running:
   - **Linux:** copy the project to `/opt/docspace`, create a `docspace` user, then install [deploy/docspace.service](../deploy/docspace.service) with systemd.
   - **Windows:** create a Task Scheduler task "At startup" running `node apps\server\dist\index.js` with the project folder as *Start in*, and "Restart on failure" enabled.

Uploads are stored in `data/uploads` (configurable with `STORAGE_DIR`). Back up that folder and the database.

## 2. Docker Compose

```bash
cp .env.example .env
```

Edit `.env`: set `APP_SECRET` (any long random string), `APP_URL=https://docs.example.com`, `DB_PASSWORD`, and export `APP_DOMAIN=docs.example.com` for Caddy. Then:

```bash
docker compose up -d --build
```

Caddy obtains HTTPS certificates automatically for `APP_DOMAIN`. For a LAN-only install without TLS, set `APP_DOMAIN=:80` and `APP_URL=http://<server-ip>`.

Optional profiles: `--profile s3` (MinIO; set `STORAGE_DRIVER=s3`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`) and `--profile ai` (Ollama; set `AI_PROVIDER=ollama`, then `docker compose exec ollama ollama pull llama3.2`).

## 3. Custom domains for published docs

1. In a space: **Settings → Custom domain**, enter e.g. `docs.example.com`.
2. Create a DNS `CNAME` from that domain to your DocSpace host (or an `A` record to its IP). If you use an `A` record, also add the shown `TXT` record at `_docspace.docs.example.com`.
3. Click **Check DNS**. For internal domains without public DNS, an instance admin can use **Mark verified**.
4. With the bundled Caddyfile, the certificate is issued on first request; Caddy asks `GET /internal/tls-check?domain=…` and DocSpace only approves verified domains.

## 4. Scaling out

- Set `REDIS_URL` on every instance: Redis shares the page cache and rate limits and relays real-time collaboration updates between instances (each instance may hold the same document; updates are CRDT-merged).
- Use `STORAGE_DRIVER=s3` (MinIO, SeaweedFS, Garage, Ceph RGW) so every instance sees the same uploads.
- Put instances behind Caddy or Nginx ([deploy/nginx.conf](../deploy/nginx.conf)) with WebSocket upgrade enabled and buffering off (for streamed AI answers). Sticky sessions are not required.
- Background work (webhook delivery, search index reconciliation) is safe to run on all instances; set `DISABLE_WORKERS=true` on some instances if you prefer dedicated workers.
- MySQL is the system of record: use a managed backup schedule (`mysqldump` or `mariadb-backup`) and consider a replica for reporting.

## 5. Security checklist

- Strong `APP_SECRET`; `NODE_ENV=production` (startup refuses the default secret).
- Serve over HTTPS (`APP_URL=https://…`) so session cookies are marked `Secure`.
- `TRUST_PROXY=true` only when running behind your own proxy.
- `ALLOW_REGISTRATION=false` for private instances; invite people from **Organization settings → Members**.
- Enforce 2FA and an IP allowlist per organization under **Organization settings → Security**.
- Keep `PLAYGROUND_PROXY_ALLOW_PRIVATE=false` unless documented APIs live on your private network.
- Review **Audit log** (organization) and **Instance admin → Audit log** regularly; export as CSV for archiving.

## 6. Upgrades

```bash
git pull
```

```bash
npm ci
```

```bash
npm run build
```

Restart the service. Database migrations apply automatically at startup.
