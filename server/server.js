// Bunny Manager: a small zero-dependency server that serves the web UI,
// proxies the bunny.net API (keeping keys off third-party origins) and runs
// the official bunny CLI on request.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const API_URL = (process.env.BUNNYNET_API_URL || "https://api.bunny.net").replace(/\/+$/, "");
const SERVER_API_KEY = (process.env.BUNNYNET_API_KEY || "").trim();
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const ALLOW_CLI = !/^(0|false|no|off)$/i.test(process.env.ALLOW_CLI || "true");
const CLI_BIN = process.env.BUNNY_CLI_BIN || "bunny";
const CLI_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT || 120) * 1000;
const CLI_WORKDIR = process.env.CLI_WORKDIR || path.join(process.env.DATA_DIR || "/data", "workspace");
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_JSON_BODY = 2 * 1024 * 1024;
const MAX_CLI_OUTPUT = 2 * 1024 * 1024;

// CLI commands that need a browser or a TTY and make no sense from the web console.
const BLOCKED_CLI = {
  login: "Browser login is not available here. Set BUNNYNET_API_KEY or enter your API key in Settings.",
  logout: "There is no stored login to remove; the API key comes from the container or your browser.",
  open: "Opening the dashboard is not supported in the web console.",
  docs: "Opening docs is not supported in the web console. See https://docs.bunny.net/cli",
  completion: "Shell completion is not useful in the web console.",
};

const sessions = new Map(); // token -> expiry
let cliVersion = null;

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest();
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthenticated(req) {
  if (!APP_PASSWORD) return true;
  const token = parseCookies(req).bm_session;
  const exp = token && sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
}

function readBody(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
}

function apiKeyFor(req) {
  const fromBrowser = String(req.headers["x-bunny-api-key"] || "").trim();
  return fromBrowser || SERVER_API_KEY;
}

function requireKey(req) {
  const key = apiKeyFor(req);
  if (!key) {
    throw Object.assign(new Error("No bunny.net API key configured. Add one in Settings."), { status: 401 });
  }
  return key;
}

// bunny.net API proxy

async function bunnyFetch(key, method, pathAndQuery, body) {
  const headers = { AccessKey: key, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(API_URL + pathAndQuery, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function relay(res, upstream) {
  const text = await upstream.text();
  const type = upstream.headers.get("content-type") || "application/json";
  res.writeHead(upstream.status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(text);
}

async function handleProxy(req, res, url) {
  const key = requireKey(req);
  const sub = url.pathname.slice("/api/bunny".length) || "/";
  const hasBody = !["GET", "HEAD", "DELETE"].includes(req.method) || Number(req.headers["content-length"] || 0) > 0;
  const body = hasBody ? (await readBody(req)).toString("utf8") : undefined;
  const upstream = await bunnyFetch(key, req.method, sub + url.search, body || undefined);
  await relay(res, upstream);
}

// Storage (Edge Storage API needs the zone password + regional host)

const zoneCache = new Map(); // `${keyHash}:${id}` -> { zone, exp }

async function getStorageZone(key, id) {
  if (!/^\d+$/.test(id)) throw Object.assign(new Error("Invalid storage zone id"), { status: 400 });
  const cacheKey = sha256(key).toString("hex") + ":" + id;
  const hit = zoneCache.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.zone;
  const r = await bunnyFetch(key, "GET", `/storagezone/${id}`);
  if (!r.ok) {
    throw Object.assign(new Error(`Could not load storage zone ${id} (HTTP ${r.status})`), { status: r.status });
  }
  const z = await r.json();
  const region = String(z.Region || "DE").toUpperCase();
  const host = z.StorageHostname || (region === "DE" ? "storage.bunnycdn.com" : `${region.toLowerCase()}.storage.bunnycdn.com`);
  const zone = { name: z.Name, password: z.Password, host };
  zoneCache.set(cacheKey, { zone, exp: Date.now() + 5 * 60 * 1000 });
  return zone;
}

function storageUrl(zone, filePath) {
  const clean = String(filePath || "")
    .split("/")
    .filter((p) => p && p !== "." && p !== "..")
    .map(encodeURIComponent)
    .join("/");
  const trailing = clean && String(filePath).endsWith("/") ? "/" : "";
  return `https://${zone.host}/${encodeURIComponent(zone.name)}/${clean}${trailing}`;
}

async function handleStorage(req, res, url) {
  // /api/storage/:zoneId/(list|file)
  const [, , , zoneId, action] = url.pathname.split("/");
  const key = requireKey(req);
  const zone = await getStorageZone(key, zoneId);
  const p = url.searchParams.get("path") || "";

  if (action === "list" && req.method === "GET") {
    const dir = p.endsWith("/") || !p ? p : p + "/";
    const r = await fetch(storageUrl(zone, dir), { headers: { AccessKey: zone.password, Accept: "application/json" } });
    return relay(res, r);
  }

  if (action === "file") {
    if (req.method === "GET") {
      const r = await fetch(storageUrl(zone, p), { headers: { AccessKey: zone.password } });
      if (!r.ok) return relay(res, r);
      const name = p.split("/").filter(Boolean).pop() || "download";
      res.writeHead(200, {
        "Content-Type": r.headers.get("content-type") || "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        ...(r.headers.get("content-length") ? { "Content-Length": r.headers.get("content-length") } : {}),
      });
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) await new Promise((ok) => res.once("drain", ok));
      }
      return res.end();
    }
    if (req.method === "PUT") {
      if (!p || p.endsWith("/")) throw Object.assign(new Error("A file path is required"), { status: 400 });
      const headers = { AccessKey: zone.password, "Content-Type": "application/octet-stream" };
      if (req.headers["content-length"]) headers["Content-Length"] = req.headers["content-length"];
      const r = await fetch(storageUrl(zone, p), { method: "PUT", headers, body: req, duplex: "half" });
      return relay(res, r);
    }
    if (req.method === "DELETE") {
      if (!p) throw Object.assign(new Error("Refusing to delete the zone root"), { status: 400 });
      const r = await fetch(storageUrl(zone, p), { method: "DELETE", headers: { AccessKey: zone.password } });
      return relay(res, r);
    }
  }
  sendJson(res, 404, { error: "Unknown storage action" });
}

// CLI

// Split a command line into argv, honouring single/double quotes and backslash escapes.
function tokenize(line) {
  const args = [];
  let cur = "";
  let quote = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) throw Object.assign(new Error("Unterminated quote in command"), { status: 400 });
  if (started) args.push(cur);
  return args;
}

function runCli(args, key) {
  return new Promise((resolve) => {
    fs.mkdirSync(CLI_WORKDIR, { recursive: true });
    const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };
    if (key) env.BUNNYNET_API_KEY = key;
    else delete env.BUNNYNET_API_KEY;
    const started = Date.now();
    // detached gives the CLI its own process group so a timeout can kill the npm
    // launcher and the native binary it spawns together.
    const detached = process.platform !== "win32";
    const child = spawn(CLI_BIN, args, { cwd: CLI_WORKDIR, env, stdio: ["ignore", "pipe", "pipe"], detached });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const take = (which) => (chunk) => {
      const s = chunk.toString("utf8");
      if (stdout.length + stderr.length + s.length > MAX_CLI_OUTPUT) {
        truncated = true;
        return;
      }
      if (which === "out") stdout += s;
      else stderr += s;
    };
    child.stdout.on("data", take("out"));
    child.stderr.on("data", take("err"));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (detached) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }, CLI_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + `Failed to start ${CLI_BIN}: ${err.message}\n`, ms: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) stderr += `\n[timed out after ${CLI_TIMEOUT_MS / 1000}s; interactive commands are not supported]\n`;
      if (truncated) stderr += "\n[output truncated]\n";
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr, ms: Date.now() - started });
    });
  });
}

async function handleCli(req, res) {
  if (!ALLOW_CLI) return sendJson(res, 403, { error: "The CLI console is disabled (ALLOW_CLI=false)." });
  const { command } = await readJson(req);
  if (typeof command !== "string" || !command.trim()) return sendJson(res, 400, { error: "command is required" });
  let args = tokenize(command.trim());
  if (args[0] === "bunny") args = args.slice(1);
  const first = args.find((a) => !a.startsWith("-"));
  if (first && BLOCKED_CLI[first]) return sendJson(res, 200, { code: 1, stdout: "", stderr: BLOCKED_CLI[first] + "\n", ms: 0 });
  if (args.some((a) => a === "--api-key" || a.startsWith("--api-key="))) {
    return sendJson(res, 400, { error: "Do not pass --api-key here; the console uses your configured key." });
  }
  const result = await runCli(args, apiKeyFor(req));
  sendJson(res, 200, result);
}

// static files

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || !path.extname(rel)) rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": rel === "/index.html" ? "no-cache" : "public, max-age=300",
    });
    res.end(data);
  });
}

// routing

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'",
};

async function route(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p === "/healthz") return sendJson(res, 200, { ok: true });

  if (!p.startsWith("/api/")) return serveStatic(req, res, url);

  if (p === "/api/status" && req.method === "GET") {
    return sendJson(res, 200, {
      passwordRequired: Boolean(APP_PASSWORD),
      authenticated: isAuthenticated(req),
      hasServerKey: Boolean(SERVER_API_KEY),
      allowCli: ALLOW_CLI,
      cliVersion,
      apiUrl: API_URL,
    });
  }

  // Every state-changing or data-reading API call must carry this header. Browsers
  // will not send a custom header cross-origin without a CORS preflight (which we
  // never approve), so other sites cannot drive this API through the user's browser.
  if (req.headers["x-requested-with"] !== "bunny-manager") {
    return sendJson(res, 403, { error: "Missing X-Requested-With header" });
  }

  if (p === "/api/login" && req.method === "POST") {
    const { password } = await readJson(req);
    if (!APP_PASSWORD) return sendJson(res, 200, { ok: true });
    const ok = typeof password === "string" && crypto.timingSafeEqual(sha256(password), sha256(APP_PASSWORD));
    if (!ok) {
      await new Promise((r) => setTimeout(r, 700));
      return sendJson(res, 401, { error: "Wrong password" });
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    return sendJson(res, 200, { ok: true }, {
      "Set-Cookie": `bm_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
    });
  }

  if (p === "/api/logout" && req.method === "POST") {
    sessions.delete(parseCookies(req).bm_session);
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": "bm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }

  if (!isAuthenticated(req)) return sendJson(res, 401, { error: "Login required", loginRequired: true });

  if (p === "/api/bunny" || p.startsWith("/api/bunny/")) return handleProxy(req, res, url);
  if (p.startsWith("/api/storage/")) return handleStorage(req, res, url);
  if (p === "/api/cli" && req.method === "POST") return handleCli(req, res);

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = err.status || 502;
    if (status >= 500) console.error(`[${req.method} ${req.url}]`, err);
    if (res.headersSent) return res.end();
    sendJson(res, status, { error: err.message || "Internal error" });
  });
});

execFile(CLI_BIN, ["--version"], { timeout: 15000, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout) => {
  cliVersion = err ? null : stdout.trim();
  console.log(cliVersion ? `bunny CLI ${cliVersion}` : `bunny CLI not found (${CLI_BIN}); the console will be unavailable`);
});

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}, 3600 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Bunny Manager listening on http://${HOST}:${PORT}`);
  if (!APP_PASSWORD) console.warn("APP_PASSWORD is not set: anyone who can reach this port can use the UI.");
  if (SERVER_API_KEY) console.log("Using BUNNYNET_API_KEY from the environment.");
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
