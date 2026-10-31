# Bunny Manager

A single Docker image that bundles the official [bunny.net CLI](https://docs.bunny.net/cli) (`@bunny.net/cli`) with a lightweight web UI for managing your bunny.net account using an API key. Runs locally, on any Docker host, or as a ZimaOS / CasaOS app. Images are built for `amd64` and `arm64`.

> **Disclaimer:** Bunny Manager is an unofficial, independent project. It is not affiliated with, endorsed by, or sponsored by bunny.net. I do not own bunny.net or any of its services. The bunny.net name, logos, trademarks, the bunny.net CLI, and all related rights belong to bunny.net; all rights reserved.

## Features

- **Dashboard**: balance, monthly charges, 30-day bandwidth and requests, cache hit rate, and resource counts.
- **Pull Zones**: create (from an origin URL or a storage zone), delete, and purge the whole zone or a single URL. Add and remove hostnames, issue free SSL certificates, toggle Force SSL, and edit cache settings.
- **Storage**: create and delete zones, browse folders, drag-and-drop upload, download, delete, and copy a file's CDN URL.
- **DNS**: create and delete zones, and add, edit, and delete records (A, AAAA, CNAME, TXT, MX, SRV, CAA, and more).
- **Stream**: list, create, and delete video libraries.
- **CLI Console**: run any `bunny` command (for example `dns zones list -o table` or `api GET /pullzone`) from the browser.

## Quick start (local)

```sh
cp .env.example .env        # optionally set BUNNYNET_API_KEY and APP_PASSWORD
docker compose up -d --build
```

Open http://localhost:8080. If you didn't set `BUNNYNET_API_KEY`, the UI asks for your key, which you can find at [dash.bunny.net → Account → API key](https://dash.bunny.net/account/api-key).

Without compose:

```sh
docker build -t bunny-manager .
docker run -d -p 8080:8080 -e APP_PASSWORD=secret -v bunny-data:/data bunny-manager
```

Using the CLI directly from the container:

```sh
docker exec -it bunny-manager bunny storage zones list -o table
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `BUNNYNET_API_KEY` | – | Account API key. Optional; if you leave it empty, each browser enters its own key (kept in that browser's storage). |
| `APP_PASSWORD` | – | Password for the UI. **Set this whenever anyone else can reach the port.** |
| `ALLOW_CLI` | `true` | Enables the in-browser CLI console. |
| `CLI_TIMEOUT` | `120` | Seconds before a CLI command is killed. |
| `PORT` | `8080` | Listen port. |
| `PUID` / `PGID` | `1000` | User and group the app runs as. `/data` is chowned to them on start. |
| `BUNNYNET_API_URL` | `https://api.bunny.net` | API base URL. |

`/data` holds the CLI's home directory (config and the working directory used for CLI commands).

## ZimaOS / CasaOS

ZimaOS installs from a registry image.

1. In `zimaos/docker-compose.yml`.
2. In ZimaOS, open App Store -> My Apps -> *Install a customized app* -> **Import** -> SElect Import YAML
3. Paste the file, set `APP_PASSWORD` (and optionally your API key), then install.

The UI is served on port **8095** by default, and data lives in `/DATA/AppData/bunny-manager`.

## Security notes

- Anyone who can open the UI can control your bunny.net account, including deleting zones. Set `APP_PASSWORD`, and don't expose the port to the internet without HTTPS (put it behind a reverse proxy such as Caddy, Traefik, or Nginx Proxy Manager).
- API keys entered in the browser are sent only to this server, which forwards them to bunny.net. They are never written to disk on the server.
- Every API call requires an `X-Requested-With` header that browsers won't send cross-origin, so other websites can't use the UI through your browser (CSRF).
- The CLI runs without a shell (arguments are passed as an argv array). `login`, `logout`, `open`, `docs`, and `completion` are blocked because they need a browser or TTY.

## Development

```sh
cd server
npm install -g @bunny.net/cli   # optional, for the console
BUNNYNET_API_KEY=... node server.js
```
There are no npm dependencies; the server uses only Node built-ins (Node 20+).

## Screens
<img width="500" height="200" alt="Screenshot 2026-10-31 012357" src="https://github.com/user-attachments/assets/fbc8e5e8-c9fa-4866-b5f6-d9dc93fd55d8" />
<img width="500" height="200" alt="Screenshot 2026-10-31 012332" src="https://github.com/user-attachments/assets/cf05949e-4311-46d5-adb3-ad7b427360b8" />
<img width="500" height="200" alt="Screenshot 2026-10-31 012300" src="https://github.com/user-attachments/assets/a5f5f028-b876-4da8-b786-92ea067006a8" />
<img width="500" height="200" alt="Screenshot 2026-10-31 012012" src="https://github.com/user-attachments/assets/9c3a2d3b-1e25-4b98-9f83-5b4713f91387" />
<img width="500" height="200" alt="Screenshot 2026-10-31 011942" src="https://github.com/user-attachments/assets/da6a8a58-de09-48e0-8f22-4a386c748aca" />
<img width="500" height="200" alt="image" src="https://github.com/user-attachments/assets/cea54b66-2418-441f-9ead-52a6fb84e2ae" />
