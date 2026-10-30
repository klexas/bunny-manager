// Bunny Manager web UI. No framework: hash routing, template strings escaped
// through esc(), and event delegation via data-action (CSP forbids inline handlers).

const KEY_STORAGE = "bm_api_key";
const HISTORY_STORAGE = "bm_cli_history";

const state = {
  status: null,
  apiKey: loadKey(),
};

// ---------- utilities ----------

function loadKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || sessionStorage.getItem(KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

function saveKey(key, remember) {
  try {
    localStorage.removeItem(KEY_STORAGE);
    sessionStorage.removeItem(KEY_STORAGE);
    if (key) (remember ? localStorage : sessionStorage).setItem(KEY_STORAGE, key);
  } catch {}
  state.apiKey = key;
}

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const $ = (sel, root = document) => root.querySelector(sel);

function fmtBytes(n) {
  n = Number(n) || 0;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const fmtNum = (n) => (Number(n) || 0).toLocaleString();
const fmtMoney = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function fmtDate(s) {
  if (!s) return "";
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
  return isNaN(d) ? s : d.toLocaleString();
}

function toast(msg, isError = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), isError ? 7000 : 3500);
}

// ---------- API ----------

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function headers(extra = {}) {
  const h = { "X-Requested-With": "bunny-manager", ...extra };
  if (state.apiKey) h["X-Bunny-Api-Key"] = state.apiKey;
  return h;
}

async function request(method, url, body, extraHeaders) {
  const opts = { method, headers: headers(extraHeaders), credentials: "same-origin" };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      opts.body = body;
    } else {
      opts.body = JSON.stringify(body);
      opts.headers["Content-Type"] = "application/json";
    }
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && data && data.loginRequired) {
      state.status.authenticated = false;
      render();
    }
    const msg =
      (data && (data.Message || data.message || data.error || data.title)) ||
      (typeof data === "string" && data.slice(0, 200)) ||
      `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

const bunny = (method, path, body) => request(method, "/api/bunny" + path, body);

// Endpoints return either a plain array or a page object ({ Items, HasMoreItems }).
async function listAll(path) {
  const out = [];
  for (let page = 1; page < 100; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await bunny("GET", `${path}${sep}page=${page}&perPage=1000`);
    if (Array.isArray(data)) return data;
    out.push(...(data.Items || []));
    if (!data.HasMoreItems) break;
  }
  return out;
}

// ---------- dialogs ----------

function openDialog(title, bodyHtml, onSubmit) {
  const dlg = $("#dialog");
  dlg.innerHTML = `<div class="dlg-head">${esc(title)}</div><div class="dlg-body">${bodyHtml}</div>`;
  const form = dlg.querySelector("form");
  dlg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dlg.close()));
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submit = form.querySelector("[type=submit]");
      submit.disabled = true;
      try {
        const ok = await onSubmit(Object.fromEntries(new FormData(form)), form);
        if (ok !== false) dlg.close();
      } catch (err) {
        toast(err.message, true);
      } finally {
        submit.disabled = false;
      }
    });
  }
  dlg.showModal();
  dlg.querySelector("input, select, textarea")?.focus();
  return dlg;
}

function confirmDialog(title, message, { danger = true, confirmText = "Delete", typeToConfirm } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const dlg = openDialog(
      title,
      `<form class="stack">
        <p>${message}</p>
        ${typeToConfirm ? `<label class="field">Type <code>${esc(typeToConfirm)}</code> to confirm<input name="confirm" autocomplete="off" required></label>` : ""}
        <div class="form-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn ${danger ? "solid-danger" : "primary"}">${esc(confirmText)}</button>
        </div>
      </form>`,
      (v) => {
        if (typeToConfirm && v.confirm !== typeToConfirm) {
          toast("Confirmation text does not match", true);
          return false;
        }
        finish(true);
      },
    );
    dlg.addEventListener("close", () => finish(false), { once: true });
  });
}

function showJson(title, obj) {
  openDialog(
    title,
    `<pre class="json">${esc(JSON.stringify(obj, null, 2))}</pre>
     <div class="form-actions" style="margin-top:14px"><button class="btn" data-close>Close</button></div>`,
  );
}

// ---------- layout ----------

function setPage(title, actionsHtml = "") {
  document.title = `${title} · Bunny Manager`;
  $("#page-title").textContent = title;
  $("#topbar-actions").innerHTML = actionsHtml;
}

function setView(html) {
  $("#view").innerHTML = html;
}

function loading() {
  setView(`<div class="loading"><span class="spinner"></span> Loading…</div>`);
}

function errorView(err) {
  const keyHint =
    err.status === 401 || err.status === 403
      ? `<p>Check that your API key is correct in <a href="#/settings">Settings</a>.</p>`
      : "";
  setView(`<div class="card"><div class="card-body"><div class="notice danger"><strong>Request failed:</strong> ${esc(err.message)}</div>${keyHint}
    <button class="btn" data-action="reload">Retry</button></div></div>`);
}

function table(columns, rows, emptyText = "Nothing here yet.") {
  if (!rows.length) return `<div class="empty">${esc(emptyText)}</div>`;
  return `<div class="table-wrap"><table>
    <thead><tr>${columns.map((c) => `<th class="${c.cls || ""}">${esc(c.label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td class="${c.cls || ""}">${c.render(r)}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

// ---------- views ----------

async function viewDashboard() {
  setPage("Dashboard", `<button class="btn" data-action="reload">Refresh</button>`);
  loading();
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86400000);
  const q = `dateFrom=${from.toISOString().slice(0, 10)}&dateTo=${to.toISOString().slice(0, 10)}`;
  const [billing, stats, pullzones, storage, dns, libs] = await Promise.allSettled([
    bunny("GET", "/billing"),
    bunny("GET", `/statistics?${q}`),
    listAll("/pullzone"),
    listAll("/storagezone"),
    listAll("/dnszone"),
    listAll("/videolibrary"),
  ]);
  const core = [billing, stats, pullzones, storage, dns];
  if (core.every((r) => r.status === "rejected")) throw core[0].reason;
  const v = (r) => (r.status === "fulfilled" ? r.value : null);
  const b = v(billing) || {};
  const s = v(stats) || {};
  const count = (r) => (r.status === "fulfilled" ? fmtNum(r.value.length) : "—");
  const storageUsed = v(storage) ? v(storage).reduce((a, z) => a + (z.StorageUsed || 0), 0) : null;

  setView(`
    <div class="stats">
      <div class="stat"><div class="label">Balance</div><div class="value">${v(billing) ? fmtMoney(b.Balance) : "—"}</div>
        <div class="sub">${v(billing) ? `This month: ${fmtMoney(b.ThisMonthCharges)}` : "Billing unavailable"}</div></div>
      <div class="stat"><div class="label">Bandwidth (30d)</div><div class="value">${v(stats) ? fmtBytes(s.TotalBandwidthUsed) : "—"}</div>
        <div class="sub">${v(stats) ? `Origin: ${fmtBytes(s.TotalOriginTraffic)}` : ""}</div></div>
      <div class="stat"><div class="label">Requests (30d)</div><div class="value">${v(stats) ? fmtNum(s.TotalRequestsServed) : "—"}</div>
        <div class="sub">${v(stats) ? `Cache hit rate: ${(Number(s.CacheHitRate) || 0).toFixed(1)}%` : ""}</div></div>
      <div class="stat"><div class="label">Storage used</div><div class="value">${storageUsed == null ? "—" : fmtBytes(storageUsed)}</div>
        <div class="sub">Across all storage zones</div></div>
    </div>
    <div class="stats">
      <a class="stat" href="#/pullzones"><div class="label">Pull zones</div><div class="value">${count(pullzones)}</div></a>
      <a class="stat" href="#/storage"><div class="label">Storage zones</div><div class="value">${count(storage)}</div></a>
      <a class="stat" href="#/dns"><div class="label">DNS zones</div><div class="value">${count(dns)}</div></a>
      <a class="stat" href="#/stream"><div class="label">Stream libraries</div><div class="value">${count(libs)}</div></a>
    </div>
    ${v(pullzones) && v(pullzones).length ? `<div class="card"><div class="card-head"><h2>Top pull zones by bandwidth this month</h2></div>
      ${table(
        [
          { label: "Name", render: (z) => `<a href="#/pullzones/${z.Id}">${esc(z.Name)}</a>` },
          { label: "Bandwidth", cls: "num", render: (z) => fmtBytes(z.MonthlyBandwidthUsed) },
          { label: "Charges", cls: "num", render: (z) => fmtMoney(z.MonthlyCharges) },
        ],
        [...v(pullzones)].sort((a, b) => (b.MonthlyBandwidthUsed || 0) - (a.MonthlyBandwidthUsed || 0)).slice(0, 8),
      )}</div>` : ""}
  `);
}

// ----- Pull zones -----

async function viewPullZones() {
  setPage("Pull Zones", `<button class="btn" data-action="reload">Refresh</button><button class="btn primary" data-action="pz-create">New pull zone</button>`);
  loading();
  const zones = await listAll("/pullzone");
  setView(`<div class="card">${table(
    [
      { label: "Name", render: (z) => `<a href="#/pullzones/${z.Id}"><strong>${esc(z.Name)}</strong></a>` },
      {
        label: "Hostnames",
        cls: "hide-sm",
        render: (z) => (z.Hostnames || []).map((h) => `<div class="mono wrap-anywhere">${esc(h.Value)}</div>`).join(""),
      },
      { label: "Origin", cls: "hide-sm", render: (z) => `<span class="muted wrap-anywhere">${esc(z.OriginUrl || (z.StorageZoneId ? "Storage zone" : ""))}</span>` },
      { label: "Status", render: (z) => (z.Enabled === false || z.Suspended ? `<span class="badge warn">${z.Suspended ? "Suspended" : "Disabled"}</span>` : `<span class="badge ok">Active</span>`) },
      { label: "Bandwidth (month)", cls: "num", render: (z) => fmtBytes(z.MonthlyBandwidthUsed) },
      {
        label: "",
        cls: "actions",
        render: (z) => `<button class="btn sm" data-action="pz-purge" data-id="${z.Id}" data-name="${esc(z.Name)}">Purge</button>
          <button class="btn sm danger" data-action="pz-delete" data-id="${z.Id}" data-name="${esc(z.Name)}">Delete</button>`,
      },
    ],
    zones,
    "No pull zones yet. Create one to start serving content through the CDN.",
  )}</div>`);
}

async function createPullZone() {
  let storageZones = [];
  try {
    storageZones = await listAll("/storagezone");
  } catch {}
  const dlg = openDialog(
    "New pull zone",
    `<form class="stack">
      <label class="field">Name<small>Becomes &lt;name&gt;.b-cdn.net</small><input name="Name" required pattern="[a-zA-Z0-9\\-]+" placeholder="my-site"></label>
      <label class="field">Origin type
        <select name="originType"><option value="url">Origin URL</option>${storageZones.length ? `<option value="storage">Storage zone</option>` : ""}</select></label>
      <label class="field" data-origin="url">Origin URL<input name="OriginUrl" type="url" placeholder="https://example.com"></label>
      <label class="field" data-origin="storage" hidden>Storage zone
        <select name="StorageZoneId">${storageZones.map((z) => `<option value="${z.Id}">${esc(z.Name)}</option>`).join("")}</select></label>
      <label class="field">Tier
        <select name="Type"><option value="0">Standard</option><option value="1">Volume</option></select></label>
      <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Create</button></div>
    </form>`,
    async (v) => {
      const body = { Name: v.Name, Type: Number(v.Type) };
      if (v.originType === "storage") {
        body.StorageZoneId = Number(v.StorageZoneId);
        body.OriginType = 2;
      } else {
        if (!v.OriginUrl) throw new Error("Origin URL is required");
        body.OriginUrl = v.OriginUrl;
      }
      const z = await bunny("POST", "/pullzone", body);
      toast(`Pull zone ${z.Name} created`);
      location.hash = `#/pullzones/${z.Id}`;
    },
  );
  const sel = dlg.querySelector("[name=originType]");
  sel.addEventListener("change", () => {
    dlg.querySelectorAll("[data-origin]").forEach((el) => (el.hidden = el.dataset.origin !== sel.value));
  });
}

async function viewPullZone(id) {
  setPage("Pull Zone", `<a class="btn" href="#/pullzones">← All pull zones</a><button class="btn" data-action="reload">Refresh</button>`);
  loading();
  const z = await bunny("GET", `/pullzone/${id}`);
  state.current = z;
  setPage(z.Name, `<a class="btn" href="#/pullzones">← All pull zones</a>
    <button class="btn" data-action="pz-purge" data-id="${z.Id}" data-name="${esc(z.Name)}">Purge cache</button>
    <button class="btn danger" data-action="pz-delete" data-id="${z.Id}" data-name="${esc(z.Name)}" data-back="1">Delete</button>`);
  setView(`
    <div class="stats">
      <div class="stat"><div class="label">Bandwidth (month)</div><div class="value">${fmtBytes(z.MonthlyBandwidthUsed)}</div></div>
      <div class="stat"><div class="label">Charges (month)</div><div class="value">${fmtMoney(z.MonthlyCharges)}</div></div>
      <div class="stat"><div class="label">Status</div><div class="value" style="font-size:18px">${z.Enabled === false ? "Disabled" : z.Suspended ? "Suspended" : "Active"}</div></div>
      <div class="stat"><div class="label">Zone ID</div><div class="value mono" style="font-size:18px">${z.Id}</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Hostnames</h2></div>
      ${table(
        [
          { label: "Hostname", render: (h) => `<span class="mono wrap-anywhere">${esc(h.Value)}</span> ${h.IsSystemHostname ? `<span class="badge">system</span>` : ""}` },
          { label: "SSL", render: (h) => (h.HasCertificate || h.IsSystemHostname ? `<span class="badge ok">Certificate</span>` : `<span class="badge">None</span>`) },
          { label: "Force SSL", render: (h) => `<label class="check"><input type="checkbox" data-action="pz-forcessl" data-host="${esc(h.Value)}" ${h.ForceSSL ? "checked" : ""}></label>` },
          {
            label: "",
            cls: "actions",
            render: (h) =>
              (h.IsSystemHostname ? "" : `${h.HasCertificate ? "" : `<button class="btn sm" data-action="pz-ssl" data-host="${esc(h.Value)}">Get free SSL</button>`}
              <button class="btn sm danger" data-action="pz-host-remove" data-host="${esc(h.Value)}">Remove</button>`),
          },
        ],
        z.Hostnames || [],
      )}
      <div class="card-body">
        <form class="inline-form" data-form="pz-host-add">
          <input name="hostname" placeholder="cdn.example.com" required>
          <button class="btn primary">Add hostname</button>
        </form>
        <p class="muted" style="margin-bottom:0">Point a CNAME for your hostname to <code>${esc(z.Name)}.b-cdn.net</code> before requesting a certificate.</p>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Settings</h2></div>
      <div class="card-body">
        <form class="stack" data-form="pz-settings">
          ${z.StorageZoneId ? `<p class="muted">Origin: storage zone <a href="#/storage/${z.StorageZoneId}">#${z.StorageZoneId}</a></p>` : `<label class="field">Origin URL<input name="OriginUrl" type="url" value="${esc(z.OriginUrl)}"></label>`}
          <div class="row">
            <label class="field">Cache expiration (seconds)<small>-1 respects origin Cache-Control</small>
              <input name="CacheControlMaxAgeOverride" type="number" min="-1" value="${esc(z.CacheControlMaxAgeOverride)}"></label>
            <label class="field">Browser cache (seconds)<small>-1 matches server cache</small>
              <input name="CacheControlPublicMaxAgeOverride" type="number" min="-1" value="${esc(z.CacheControlPublicMaxAgeOverride)}"></label>
          </div>
          <label class="check"><input type="checkbox" name="EnableLogging" ${z.EnableLogging ? "checked" : ""}> Enable logging</label>
          <label class="check"><input type="checkbox" name="IgnoreQueryStrings" ${z.IgnoreQueryStrings ? "checked" : ""}> Ignore query strings when caching</label>
          <label class="check"><input type="checkbox" name="EnableCacheSlice" ${z.EnableCacheSlice ? "checked" : ""}> Optimize for large files (cache slicing)</label>
          <div class="form-actions"><button class="btn primary">Save settings</button></div>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Purge a URL</h2></div>
      <div class="card-body">
        <form class="inline-form" data-form="purge-url">
          <input name="url" type="url" placeholder="https://${esc(z.Name)}.b-cdn.net/path/file.css  (wildcard * allowed)" required>
          <button class="btn primary">Purge</button>
        </form>
      </div>
    </div>

    <div class="card"><details><summary>Raw JSON</summary><div class="card-body"><pre class="json">${esc(JSON.stringify(z, null, 2))}</pre></div></details></div>
  `);
}

// ----- Storage -----

const REGIONS = { DE: "Falkenstein (DE)", UK: "London (UK)", SE: "Stockholm (SE)", NY: "New York (US)", LA: "Los Angeles (US)", SG: "Singapore (SG)", SYD: "Sydney (AU)", BR: "São Paulo (BR)", JH: "Johannesburg (ZA)" };

async function viewStorageZones() {
  setPage("Storage", `<button class="btn" data-action="reload">Refresh</button><button class="btn primary" data-action="sz-create">New storage zone</button>`);
  loading();
  const zones = (await listAll("/storagezone")).filter((z) => !z.Deleted);
  setView(`<div class="card">${table(
    [
      { label: "Name", render: (z) => `<a href="#/storage/${z.Id}"><strong>${esc(z.Name)}</strong></a>` },
      { label: "Region", render: (z) => esc(REGIONS[z.Region] || z.Region) + ((z.ReplicationRegions || []).length ? ` <span class="badge">+${z.ReplicationRegions.length} replicas</span>` : "") },
      { label: "Tier", cls: "hide-sm", render: (z) => (z.ZoneTier === 1 ? `<span class="badge accent">Edge SSD</span>` : `<span class="badge">Standard</span>`) },
      { label: "Files", cls: "num", render: (z) => fmtNum(z.FilesStored) },
      { label: "Used", cls: "num", render: (z) => fmtBytes(z.StorageUsed) },
      {
        label: "",
        cls: "actions",
        render: (z) => `<a class="btn sm" href="#/storage/${z.Id}">Browse</a>
          <button class="btn sm danger" data-action="sz-delete" data-id="${z.Id}" data-name="${esc(z.Name)}">Delete</button>`,
      },
    ],
    zones,
    "No storage zones yet.",
  )}</div>`);
}

function createStorageZone() {
  openDialog(
    "New storage zone",
    `<form class="stack">
      <label class="field">Name<small>Lowercase letters, numbers and dashes; globally unique</small><input name="Name" required pattern="[a-z0-9\\-]+" placeholder="my-files"></label>
      <label class="field">Main region<select name="Region">${Object.entries(REGIONS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></label>
      <label class="field">Tier<select name="ZoneTier"><option value="0">Standard (HDD)</option><option value="1">Edge (SSD)</option></select></label>
      <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Create</button></div>
    </form>`,
    async (v) => {
      const z = await bunny("POST", "/storagezone", { Name: v.Name, Region: v.Region, ZoneTier: Number(v.ZoneTier) });
      toast(`Storage zone ${z.Name} created`);
      location.hash = `#/storage/${z.Id}`;
    },
  );
}

async function viewStorageBrowser(id, dir) {
  dir = dir ? dir.replace(/^\/+/, "").replace(/\/?$/, "/") : "";
  if (dir === "/") dir = "";
  setPage("Storage", `<a class="btn" href="#/storage">← All storage zones</a>`);
  loading();
  const [zone, files] = await Promise.all([
    bunny("GET", `/storagezone/${id}`),
    request("GET", `/api/storage/${id}/list?path=${encodeURIComponent(dir)}`),
  ]);
  state.current = { zone, dir };
  const parts = dir.split("/").filter(Boolean);
  const crumbs = [`<a href="#/storage/${id}">${esc(zone.Name)}</a>`]
    .concat(parts.map((p, i) => `<a href="#/storage/${id}/${parts.slice(0, i + 1).map(encodeURIComponent).join("/")}">${esc(p)}</a>`))
    .join(` <span class="sep">/</span> `);
  const sorted = [...(files || [])].sort((a, b) => b.IsDirectory - a.IsDirectory || a.ObjectName.localeCompare(b.ObjectName));
  const cdn = (zone.PullZones || [])[0];
  setPage(zone.Name, `<a class="btn" href="#/storage">← All storage zones</a>
    <button class="btn" data-action="sz-mkdir">New folder</button>
    <button class="btn primary" data-action="sz-upload">Upload files</button>
    <input type="file" id="upload-input" multiple hidden>`);
  setView(`
    <div class="card dropzone" id="dropzone">
      <div class="card-head"><div class="breadcrumbs">${crumbs}</div><span class="muted">${fmtNum(zone.FilesStored)} files · ${fmtBytes(zone.StorageUsed)}</span></div>
      ${table(
        [
          {
            label: "Name",
            render: (f) =>
              f.IsDirectory
                ? `📁 <a href="#/storage/${id}/${(dir + f.ObjectName).split("/").map(encodeURIComponent).join("/")}">${esc(f.ObjectName)}</a>`
                : `📄 <span class="wrap-anywhere">${esc(f.ObjectName)}</span>`,
          },
          { label: "Size", cls: "num", render: (f) => (f.IsDirectory ? "" : fmtBytes(f.Length)) },
          { label: "Modified", cls: "hide-sm", render: (f) => `<span class="muted">${esc(fmtDate(f.LastChanged))}</span>` },
          {
            label: "",
            cls: "actions",
            render: (f) => `${f.IsDirectory ? "" : `<button class="btn sm" data-action="sz-download" data-name="${esc(f.ObjectName)}">Download</button>`}
              ${!f.IsDirectory && cdn ? `<button class="btn sm" data-action="copy" data-text="${esc(`https://${cdn.Name}.b-cdn.net/${dir}${f.ObjectName}`)}">Copy URL</button>` : ""}
              <button class="btn sm danger" data-action="sz-delete-file" data-name="${esc(f.ObjectName)}" data-dir="${f.IsDirectory ? 1 : ""}">Delete</button>`,
          },
        ],
        sorted,
        "This folder is empty. Drop files here or use Upload.",
      )}
      <div class="card-body muted" id="upload-status">Tip: drag and drop files onto this panel to upload them to <code>/${esc(dir)}</code>.</div>
    </div>
    ${cdn ? "" : `<div class="notice">No pull zone is connected to this storage zone. <a href="#/pullzones" data-action="pz-create">Create one</a> to serve these files over the CDN.</div>`}
  `);

  const dz = $("#dropzone");
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
    uploadFiles([...e.dataTransfer.files]);
  });
  $("#upload-input").addEventListener("change", (e) => uploadFiles([...e.target.files]));
}

async function uploadFiles(files) {
  if (!files.length) return;
  const { zone, dir } = state.current;
  const status = $("#upload-status");
  let done = 0;
  for (const f of files) {
    status.innerHTML = `<span class="spinner"></span> Uploading ${esc(f.name)} (${done + 1}/${files.length}, ${fmtBytes(f.size)})…`;
    try {
      await request("PUT", `/api/storage/${zone.Id}/file?path=${encodeURIComponent(dir + f.name)}`, f, { "Content-Type": "application/octet-stream" });
      done++;
    } catch (err) {
      toast(`Upload of ${f.name} failed: ${err.message}`, true);
    }
  }
  toast(`Uploaded ${done} of ${files.length} file(s)`, done !== files.length);
  render();
}

async function downloadFile(name) {
  const { zone, dir } = state.current;
  const res = await fetch(`/api/storage/${zone.Id}/file?path=${encodeURIComponent(dir + name)}`, { headers: headers() });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ----- DNS -----

const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "Redirect", "Flatten", "PullZone", "SRV", "CAA", "PTR", "Script", "NS"];
const EDITABLE_TYPES = [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 12];

async function viewDnsZones() {
  setPage("DNS", `<button class="btn" data-action="reload">Refresh</button><button class="btn primary" data-action="dns-create">Add DNS zone</button>`);
  loading();
  const zones = await listAll("/dnszone");
  setView(`<div class="card">${table(
    [
      { label: "Domain", render: (z) => `<a href="#/dns/${z.Id}"><strong>${esc(z.Domain)}</strong></a>` },
      { label: "Records", cls: "num", render: (z) => fmtNum((z.Records || []).length) },
      {
        label: "Nameservers",
        cls: "hide-sm",
        render: (z) => (z.NameserversDetected ? `<span class="badge ok">Detected</span>` : `<span class="badge warn">Not pointed to bunny</span>`),
      },
      { label: "", cls: "actions", render: (z) => `<a class="btn sm" href="#/dns/${z.Id}">Records</a> <button class="btn sm danger" data-action="dns-delete" data-id="${z.Id}" data-name="${esc(z.Domain)}">Delete</button>` },
    ],
    zones,
    "No DNS zones yet.",
  )}</div>`);
}

function createDnsZone() {
  openDialog(
    "Add DNS zone",
    `<form class="stack">
      <label class="field">Domain<input name="Domain" required placeholder="example.com"></label>
      <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Add</button></div>
    </form>`,
    async (v) => {
      const z = await bunny("POST", "/dnszone", { Domain: v.Domain.trim() });
      toast(`DNS zone ${z.Domain} added`);
      location.hash = `#/dns/${z.Id}`;
    },
  );
}

async function viewDnsZone(id) {
  setPage("DNS", `<a class="btn" href="#/dns">← All DNS zones</a>`);
  loading();
  const z = await bunny("GET", `/dnszone/${id}`);
  state.current = z;
  const records = [...(z.Records || [])].sort((a, b) => a.Type - b.Type || (a.Name || "").localeCompare(b.Name || ""));
  setPage(z.Domain, `<a class="btn" href="#/dns">← All DNS zones</a><button class="btn" data-action="reload">Refresh</button><button class="btn primary" data-action="dns-record-edit">Add record</button>`);
  setView(`
    ${z.NameserversDetected ? "" : `<div class="notice">Point your domain's nameservers to <code>${esc(z.Nameserver1 || "kiki.bunny.net")}</code> and <code>${esc(z.Nameserver2 || "coco.bunny.net")}</code> at your registrar to activate this zone.</div>`}
    <div class="card">${table(
      [
        { label: "Type", render: (r) => `<span class="badge accent">${esc(RECORD_TYPES[r.Type] || r.Type)}</span>` },
        { label: "Name", render: (r) => `<span class="mono">${esc(r.Name || "@")}</span>` },
        {
          label: "Value",
          render: (r) =>
            `<span class="mono wrap-anywhere">${r.Type === 7 ? `Pull zone #${esc(r.LinkName || r.PullZoneId || r.Value)}` : esc(r.Value)}</span>${r.Priority && (r.Type === 4 || r.Type === 8) ? ` <span class="muted">prio ${r.Priority}</span>` : ""}`,
        },
        { label: "TTL", cls: "num hide-sm", render: (r) => esc(r.Ttl) },
        {
          label: "",
          cls: "actions",
          render: (r) => `${EDITABLE_TYPES.includes(r.Type) ? `<button class="btn sm" data-action="dns-record-edit" data-id="${r.Id}">Edit</button>` : ""}
            <button class="btn sm danger" data-action="dns-record-delete" data-id="${r.Id}">Delete</button>`,
        },
      ],
      records,
      "No records yet.",
    )}</div>
    <div class="card"><details><summary>Raw JSON</summary><div class="card-body"><pre class="json">${esc(JSON.stringify(z, null, 2))}</pre></div></details></div>
  `);
}

function editDnsRecord(recordId) {
  const z = state.current;
  const r = recordId ? z.Records.find((x) => String(x.Id) === String(recordId)) : { Type: 0, Name: "", Value: "", Ttl: 300 };
  const dlg = openDialog(
    recordId ? "Edit record" : "Add record",
    `<form class="stack">
      <div class="row">
        <label class="field">Type<select name="Type">${EDITABLE_TYPES.map((t) => `<option value="${t}" ${t === r.Type ? "selected" : ""}>${RECORD_TYPES[t]}</option>`).join("")}</select></label>
        <label class="field">TTL (seconds)<input name="Ttl" type="number" min="15" value="${esc(r.Ttl || 300)}"></label>
      </div>
      <label class="field">Name<small>Leave empty for the root (@) of ${esc(z.Domain)}</small><input name="Name" value="${esc(r.Name)}" placeholder="www"></label>
      <label class="field">Value<textarea name="Value" required style="min-height:70px">${esc(r.Value)}</textarea></label>
      <div class="row" data-extra>
        <label class="field" data-for="4 8">Priority<input name="Priority" type="number" min="0" value="${esc(r.Priority || 0)}"></label>
        <label class="field" data-for="8">Weight<input name="Weight" type="number" min="0" value="${esc(r.Weight || 0)}"></label>
        <label class="field" data-for="8">Port<input name="Port" type="number" min="0" value="${esc(r.Port || 0)}"></label>
        <label class="field" data-for="9">Flags<input name="Flags" type="number" min="0" max="255" value="${esc(r.Flags || 0)}"></label>
        <label class="field" data-for="9">Tag<input name="Tag" value="${esc(r.Tag || "issue")}"></label>
      </div>
      <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">${recordId ? "Save" : "Add"}</button></div>
    </form>`,
    async (v) => {
      const type = Number(v.Type);
      const body = { Type: type, Name: v.Name.trim() === "@" ? "" : v.Name.trim(), Value: v.Value.trim(), Ttl: Number(v.Ttl) || 300 };
      if (type === 4 || type === 8) body.Priority = Number(v.Priority) || 0;
      if (type === 8) Object.assign(body, { Weight: Number(v.Weight) || 0, Port: Number(v.Port) || 0 });
      if (type === 9) Object.assign(body, { Flags: Number(v.Flags) || 0, Tag: v.Tag });
      if (recordId) {
        await bunny("POST", `/dnszone/${z.Id}/records/${recordId}`, { ...body, Id: Number(recordId) });
        toast("Record updated");
      } else {
        await bunny("PUT", `/dnszone/${z.Id}/records`, body);
        toast("Record added");
      }
      render();
    },
  );
  const typeSel = dlg.querySelector("[name=Type]");
  const sync = () =>
    dlg.querySelectorAll("[data-for]").forEach((el) => (el.hidden = !el.dataset.for.split(" ").includes(typeSel.value)));
  typeSel.addEventListener("change", sync);
  sync();
}

// ----- Stream -----

async function viewStream() {
  setPage("Stream", `<button class="btn" data-action="reload">Refresh</button><button class="btn primary" data-action="stream-create">New library</button>`);
  loading();
  const libs = await listAll("/videolibrary");
  setView(`<div class="card">${table(
    [
      { label: "Name", render: (l) => `<strong>${esc(l.Name)}</strong>` },
      { label: "Library ID", cls: "hide-sm", render: (l) => `<span class="mono">${esc(l.Id)}</span>` },
      { label: "Videos", cls: "num", render: (l) => fmtNum(l.VideoCount) },
      { label: "Storage", cls: "num", render: (l) => fmtBytes(l.StorageUsage) },
      { label: "Traffic", cls: "num hide-sm", render: (l) => fmtBytes(l.TrafficUsage) },
      {
        label: "",
        cls: "actions",
        render: (l) => `<button class="btn sm" data-action="stream-json" data-id="${l.Id}">Details</button>
          <button class="btn sm danger" data-action="stream-delete" data-id="${l.Id}" data-name="${esc(l.Name)}">Delete</button>`,
      },
    ],
    libs,
    "No video libraries yet.",
  )}</div>`);
}

// ----- CLI console -----

const CLI_EXAMPLES = ["whoami", "--help", "storage zones list", "dns zones list", "scripts list", "db list", "sites list", "stream libraries list", "api GET /pullzone", "storage regions"];

function cliHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_STORAGE) || "[]");
  } catch {
    return [];
  }
}

function viewCli() {
  setPage("CLI Console", `<button class="btn" data-action="cli-clear">Clear</button>`);
  if (!state.status.allowCli) {
    setView(`<div class="card"><div class="card-body">The CLI console is disabled on this server (<code>ALLOW_CLI=false</code>).</div></div>`);
    return;
  }
  setView(`
    <div class="console">
      <div class="muted">Runs the official <a href="https://docs.bunny.net/cli" target="_blank" rel="noopener">bunny CLI</a>
        ${state.status.cliVersion ? `<code>${esc(state.status.cliVersion)}</code>` : `<span class="badge warn">not detected</span>`}
        inside the container with your API key. Interactive commands (prompts, shells) are not supported, so pass all values as flags.</div>
      <div class="chips">${CLI_EXAMPLES.map((c) => `<button class="chip" data-action="cli-example" data-cmd="${esc(c)}">${esc(c)}</button>`).join("")}</div>
      <pre class="console-out" id="console-out"><span class="meta">Type a command below, e.g. "storage zones list -o table". The leading "bunny" is optional.</span>\n</pre>
      <form class="console-in" data-form="cli">
        <span class="prompt">$ bunny</span>
        <input name="command" id="cli-input" autocomplete="off" spellcheck="false" placeholder="dns zones list -o table">
        <select name="output" style="width:auto" title="Output format">
          <option value="">default</option><option value="table">table</option><option value="json">json</option><option value="text">text</option><option value="csv">csv</option><option value="markdown">markdown</option>
        </select>
        <button class="btn primary">Run</button>
      </form>
    </div>`);
  const input = $("#cli-input");
  let idx = -1;
  input.addEventListener("keydown", (e) => {
    const hist = cliHistory();
    if (e.key === "ArrowUp" && idx < hist.length - 1) input.value = hist[++idx];
    else if (e.key === "ArrowDown" && idx > 0) input.value = hist[--idx];
    else if (e.key === "ArrowDown") {
      idx = -1;
      input.value = "";
    } else return;
    e.preventDefault();
  });
  input.focus();
}

async function runCli(form) {
  const input = form.command;
  let cmd = input.value.trim().replace(/^bunny\s+/, "");
  if (!cmd) return;
  if (form.output.value && !/(^|\s)(-o|--output)(\s|=|$)/.test(cmd)) cmd += ` -o ${form.output.value}`;
  const hist = cliHistory().filter((h) => h !== input.value.trim());
  hist.unshift(input.value.trim());
  try {
    localStorage.setItem(HISTORY_STORAGE, JSON.stringify(hist.slice(0, 50)));
  } catch {}
  input.value = "";
  const out = $("#console-out");
  const block = document.createElement("div");
  block.innerHTML = `<span class="cmd">$ bunny ${esc(cmd)}</span>\n<span class="meta"><span class="spinner"></span> running…</span>\n`;
  out.appendChild(block);
  out.scrollTop = out.scrollHeight;
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    const r = await request("POST", "/api/cli", { command: cmd });
    block.innerHTML = `<span class="cmd">$ bunny ${esc(cmd)}</span>\n${esc(r.stdout)}${r.stderr ? `<span class="err">${esc(r.stderr)}</span>` : ""}<span class="meta">[exit ${r.code} · ${(r.ms / 1000).toFixed(1)}s]</span>\n\n`;
  } catch (err) {
    block.innerHTML = `<span class="cmd">$ bunny ${esc(cmd)}</span>\n<span class="err">${esc(err.message)}</span>\n\n`;
  } finally {
    btn.disabled = false;
    out.scrollTop = out.scrollHeight;
    input.focus();
  }
}

// ----- Settings / auth -----

function viewSettings() {
  setPage("Settings");
  const s = state.status;
  const masked = state.apiKey ? state.apiKey.slice(0, 4) + "…" + state.apiKey.slice(-4) : "";
  setView(`
    <div class="card">
      <div class="card-head"><h2>bunny.net API key</h2></div>
      <div class="card-body">
        ${s.hasServerKey ? `<div class="notice">This server has an API key configured (<code>BUNNYNET_API_KEY</code>). A key entered below overrides it for this browser only.</div>` : ""}
        <p class="muted" style="margin-top:0">Find your key in the bunny.net dashboard under <a href="https://dash.bunny.net/account/api-key" target="_blank" rel="noopener">Account → API key</a>.
          A key entered here is kept in this browser and sent only to this server, which forwards it to bunny.net.</p>
        <form class="stack" data-form="settings-key">
          <label class="field">API key<input name="key" type="password" autocomplete="off" placeholder="${masked ? esc(masked) + " (saved)" : "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxxxxxxxxxx-xxxx-xxxx"}"></label>
          <label class="check"><input type="checkbox" name="remember" checked> Remember on this device</label>
          <div class="form-actions">
            ${state.apiKey ? `<button type="button" class="btn danger" data-action="key-forget">Forget saved key</button>` : ""}
            <button type="button" class="btn" data-action="key-test">Test connection</button>
            <button class="btn primary">Save key</button>
          </div>
        </form>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Server</h2></div>
      <div class="card-body">
        <dl class="kv">
          <dt>bunny CLI</dt><dd>${s.cliVersion ? esc(s.cliVersion) : "not detected"}${s.allowCli ? "" : " (console disabled)"}</dd>
          <dt>API endpoint</dt><dd class="mono">${esc(s.apiUrl)}</dd>
          <dt>Server API key</dt><dd>${s.hasServerKey ? "configured" : "not set"}</dd>
          <dt>Password protection</dt><dd>${s.passwordRequired ? "enabled" : `<span class="badge warn">off</span> set <code>APP_PASSWORD</code> to protect this UI`}</dd>
        </dl>
        ${s.passwordRequired ? `<div class="form-actions" style="margin-top:14px"><button class="btn" data-action="logout">Sign out</button></div>` : ""}
      </div>
    </div>`);
}

function viewLogin() {
  $("#app").classList.add("locked");
  setPage("Sign in");
  setView(`<div class="center-screen"><div class="card auth-card"><div class="card-head"><h2>Bunny Manager</h2></div><div class="card-body">
    <form class="stack" data-form="login">
      <label class="field">Password<input name="password" type="password" autocomplete="current-password" required autofocus></label>
      <div class="form-actions"><button class="btn primary">Sign in</button></div>
    </form></div></div></div>`);
}

function viewWelcome() {
  setPage("Welcome");
  setView(`<div class="center-screen"><div class="card auth-card"><div class="card-head"><h2>Connect your bunny.net account</h2></div><div class="card-body">
    <p>Paste your account API key from <a href="https://dash.bunny.net/account/api-key" target="_blank" rel="noopener">dash.bunny.net → Account → API key</a>.
      You can also set <code>BUNNYNET_API_KEY</code> on the container instead.</p>
    <form class="stack" data-form="settings-key">
      <label class="field">API key<input name="key" type="password" autocomplete="off" required autofocus></label>
      <label class="check"><input type="checkbox" name="remember" checked> Remember on this device</label>
      <div class="form-actions"><button class="btn primary">Connect</button></div>
    </form></div></div></div>`);
}

// ---------- router ----------

async function render() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [section, ...rest] = hash.split("/");
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === (section || "dashboard")));
  $("#sidebar").classList.remove("open");
  $("#nav-cli").hidden = !state.status.allowCli;
  $("#sidebar-foot").innerHTML = state.status.cliVersion ? `bunny CLI ${esc(state.status.cliVersion)}` : "";

  if (state.status.passwordRequired && !state.status.authenticated) return viewLogin();
  if (!state.apiKey && !state.status.hasServerKey && section !== "settings") return viewWelcome();

  try {
    switch (section) {
      case "":
      case "dashboard":
        return await viewDashboard();
      case "pullzones":
        return rest[0] ? await viewPullZone(rest[0]) : await viewPullZones();
      case "storage":
        return rest[0] ? await viewStorageBrowser(rest[0], rest.slice(1).map(decodeURIComponent).join("/")) : await viewStorageZones();
      case "dns":
        return rest[0] ? await viewDnsZone(rest[0]) : await viewDnsZones();
      case "stream":
        return await viewStream();
      case "cli":
        return viewCli();
      case "settings":
        return viewSettings();
      default:
        setPage("Not found");
        setView(`<div class="empty">Page not found. <a href="#/">Go to dashboard</a></div>`);
    }
  } catch (err) {
    console.error(err);
    errorView(err);
  }
}

// ---------- actions ----------

const actions = {
  reload: () => render(),
  "toggle-menu": () => $("#sidebar").classList.toggle("open"),
  copy: async (el) => {
    await navigator.clipboard.writeText(el.dataset.text);
    toast("Copied to clipboard");
  },

  "pz-create": () => createPullZone(),
  "pz-purge": async (el) => {
    if (!(await confirmDialog("Purge cache", `Purge the entire cache of <strong>${esc(el.dataset.name)}</strong>?`, { danger: false, confirmText: "Purge" }))) return;
    await bunny("POST", `/pullzone/${el.dataset.id}/purgeCache`);
    toast(`Cache purged for ${el.dataset.name}`);
  },
  "pz-delete": async (el) => {
    const name = el.dataset.name;
    if (!(await confirmDialog("Delete pull zone", `This permanently deletes <strong>${esc(name)}</strong> and stops serving its traffic.`, { typeToConfirm: name }))) return;
    await bunny("DELETE", `/pullzone/${el.dataset.id}`);
    toast(`Pull zone ${name} deleted`);
    if (el.dataset.back) location.hash = "#/pullzones";
    else render();
  },
  "pz-host-remove": async (el) => {
    const host = el.dataset.host;
    if (!(await confirmDialog("Remove hostname", `Remove <code>${esc(host)}</code> from this pull zone?`, { confirmText: "Remove" }))) return;
    await bunny("DELETE", `/pullzone/${state.current.Id}/removeHostname`, { Hostname: host });
    toast(`Removed ${host}`);
    render();
  },
  "pz-ssl": async (el) => {
    el.disabled = true;
    el.textContent = "Requesting…";
    try {
      await bunny("GET", `/pullzone/loadFreeCertificate?hostname=${encodeURIComponent(el.dataset.host)}`);
      toast(`Certificate issued for ${el.dataset.host}`);
      render();
    } finally {
      el.disabled = false;
      el.textContent = "Get free SSL";
    }
  },
  "pz-forcessl": async (el) => {
    try {
      await bunny("POST", `/pullzone/${state.current.Id}/setForceSSL`, { Hostname: el.dataset.host, ForceSSL: el.checked });
      toast(`Force SSL ${el.checked ? "enabled" : "disabled"} for ${el.dataset.host}`);
    } catch (err) {
      el.checked = !el.checked;
      throw err;
    }
  },

  "sz-create": () => createStorageZone(),
  "sz-delete": async (el) => {
    const name = el.dataset.name;
    if (!(await confirmDialog("Delete storage zone", `This permanently deletes <strong>${esc(name)}</strong> and <strong>all of its files</strong>.`, { typeToConfirm: name }))) return;
    await bunny("DELETE", `/storagezone/${el.dataset.id}`);
    toast(`Storage zone ${name} deleted`);
    render();
  },
  "sz-upload": () => $("#upload-input").click(),
  "sz-mkdir": () => {
    const { zone, dir } = state.current;
    openDialog(
      "New folder",
      `<form class="stack"><label class="field">Folder name<small>Folders are created when the first file is uploaded into them.</small><input name="name" required pattern="[^/]+"></label>
        <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Open folder</button></div></form>`,
      (v) => {
        location.hash = `#/storage/${zone.Id}/${(dir + v.name).split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
      },
    );
  },
  "sz-download": (el) => downloadFile(el.dataset.name),
  "sz-delete-file": async (el) => {
    const { zone, dir } = state.current;
    const name = el.dataset.name;
    const isDir = Boolean(el.dataset.dir);
    if (!(await confirmDialog(isDir ? "Delete folder" : "Delete file", isDir ? `Delete the folder <code>${esc(name)}</code> and everything inside it?` : `Delete <code>${esc(name)}</code>?`))) return;
    await request("DELETE", `/api/storage/${zone.Id}/file?path=${encodeURIComponent(dir + name + (isDir ? "/" : ""))}`);
    toast(`Deleted ${name}`);
    render();
  },

  "dns-create": () => createDnsZone(),
  "dns-delete": async (el) => {
    const name = el.dataset.name;
    if (!(await confirmDialog("Delete DNS zone", `This deletes <strong>${esc(name)}</strong> and all of its records.`, { typeToConfirm: name }))) return;
    await bunny("DELETE", `/dnszone/${el.dataset.id}`);
    toast(`DNS zone ${name} deleted`);
    render();
  },
  "dns-record-edit": (el) => editDnsRecord(el.dataset.id),
  "dns-record-delete": async (el) => {
    const r = state.current.Records.find((x) => String(x.Id) === el.dataset.id);
    if (!(await confirmDialog("Delete record", `Delete the <strong>${esc(RECORD_TYPES[r.Type])}</strong> record <code>${esc(r.Name || "@")}</code> → <code>${esc(r.Value)}</code>?`))) return;
    await bunny("DELETE", `/dnszone/${state.current.Id}/records/${r.Id}`);
    toast("Record deleted");
    render();
  },

  "stream-create": () =>
    openDialog(
      "New video library",
      `<form class="stack"><label class="field">Name<input name="Name" required></label>
        <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Create</button></div></form>`,
      async (v) => {
        await bunny("POST", "/videolibrary", { Name: v.Name });
        toast(`Library ${v.Name} created`);
        render();
      },
    ),
  "stream-json": async (el) => showJson("Video library", await bunny("GET", `/videolibrary/${el.dataset.id}`)),
  "stream-delete": async (el) => {
    const name = el.dataset.name;
    if (!(await confirmDialog("Delete video library", `This permanently deletes <strong>${esc(name)}</strong> and all of its videos.`, { typeToConfirm: name }))) return;
    await bunny("DELETE", `/videolibrary/${el.dataset.id}`);
    toast(`Library ${name} deleted`);
    render();
  },

  "cli-example": (el) => {
    const input = $("#cli-input");
    input.value = el.dataset.cmd;
    input.form.requestSubmit();
  },
  "cli-clear": () => {
    const out = $("#console-out");
    if (out) out.innerHTML = "";
  },

  "key-forget": () => {
    saveKey("", false);
    toast("Saved key removed from this browser");
    render();
  },
  "key-test": async (el) => {
    const input = el.form.key;
    const prev = state.apiKey;
    if (input.value.trim()) state.apiKey = input.value.trim();
    try {
      const b = await bunny("GET", "/billing");
      toast(`Connected. Account balance: ${fmtMoney(b.Balance)}`);
    } catch (err) {
      toast(`Connection failed: ${err.message}`, true);
    } finally {
      state.apiKey = prev;
    }
  },
  logout: async () => {
    await request("POST", "/api/logout");
    state.status.authenticated = false;
    render();
  },
};

const forms = {
  login: async (form) => {
    await request("POST", "/api/login", { password: form.password.value });
    state.status = await request("GET", "/api/status");
    $("#app").classList.remove("locked");
    render();
  },
  "settings-key": async (form) => {
    const key = form.key.value.trim();
    if (!key) return toast("Enter an API key first", true);
    const prev = state.apiKey;
    state.apiKey = key;
    try {
      await bunny("GET", "/billing");
    } catch (err) {
      state.apiKey = prev;
      throw new Error(`That key did not work: ${err.message}`);
    }
    saveKey(key, form.remember.checked);
    toast("API key saved");
    render();
  },
  "pz-host-add": async (form) => {
    const host = form.hostname.value.trim();
    await bunny("POST", `/pullzone/${state.current.Id}/addHostname`, { Hostname: host });
    toast(`Added ${host}`);
    render();
  },
  "pz-settings": async (form) => {
    const z = state.current;
    const body = {
      CacheControlMaxAgeOverride: Number(form.CacheControlMaxAgeOverride.value),
      CacheControlPublicMaxAgeOverride: Number(form.CacheControlPublicMaxAgeOverride.value),
      EnableLogging: form.EnableLogging.checked,
      IgnoreQueryStrings: form.IgnoreQueryStrings.checked,
      EnableCacheSlice: form.EnableCacheSlice.checked,
    };
    if (form.OriginUrl) body.OriginUrl = form.OriginUrl.value.trim();
    await bunny("POST", `/pullzone/${z.Id}`, body);
    toast("Settings saved");
    render();
  },
  "purge-url": async (form) => {
    const url = form.url.value.trim();
    await bunny("POST", `/purge?url=${encodeURIComponent(url)}&async=false`);
    toast(`Purged ${url}`);
    form.reset();
  },
  cli: (form) => runCli(form),
};

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || !actions[el.dataset.action] || el.tagName === "INPUT") return;
  e.preventDefault();
  try {
    await actions[el.dataset.action](el);
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.tagName !== "INPUT" || el.type !== "checkbox" || !actions[el.dataset.action]) return;
  try {
    await actions[el.dataset.action](el);
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-form]");
  if (!form || !forms[form.dataset.form]) return;
  e.preventDefault();
  const btn = form.querySelector("button:not([type=button])");
  if (btn) btn.disabled = true;
  try {
    await forms[form.dataset.form](form);
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
});

window.addEventListener("hashchange", render);

(async function init() {
  try {
    state.status = await request("GET", "/api/status");
  } catch (err) {
    setView(`<div class="notice danger">Cannot reach the Bunny Manager server: ${esc(err.message)}</div>`);
    return;
  }
  render();
})();
