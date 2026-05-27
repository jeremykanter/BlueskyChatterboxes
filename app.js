const API = "https://public.api.bsky.app/xrpc";
const WINDOW_DAYS = 90;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const CONCURRENCY = 6;
const SPARK_BINS = 30;

const form = document.getElementById("form");
const handleInput = document.getElementById("handle");
const goBtn = document.getElementById("go");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const rowsEl = document.getElementById("rows");
const headEl = document.getElementById("head");
const sortSelectEl = document.getElementById("sort-select");

const state = {
  rows: [],
  profile: null,
  cutoff: 0,
  sortKey: "total",
  sortDir: "desc",
};

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = handleInput.value.trim().replace(/^@/, "");
  if (!raw) return;
  goBtn.disabled = true;
  resultsEl.hidden = true;
  rowsEl.innerHTML = "";
  try {
    await run(raw);
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    goBtn.disabled = false;
  }
});

rowsEl.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-handle]");
  if (!tr) return;
  const url = `https://bsky.app/profile/${tr.dataset.handle}`;
  window.open(url, "_blank", "noopener");
});

headEl.addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sort-key]");
  if (!th) return;
  const key = th.dataset.sortKey;
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
  } else {
    state.sortKey = key;
    state.sortDir = "desc";
  }
  renderRows();
  updateHeaderSortIndicators();
  sortSelectEl.value = state.sortKey;
});

sortSelectEl.addEventListener("change", () => {
  state.sortKey = sortSelectEl.value;
  state.sortDir = "desc";
  renderRows();
  updateHeaderSortIndicators();
});

async function run(handle) {
  setStatus(`Resolving @${handle}…`);
  const profile = await api("app.bsky.actor.getProfile", { actor: handle });
  const did = profile.did;

  setStatus(`Fetching follows for @${profile.handle}…`);
  const follows = await getAllFollows(did);
  if (follows.length === 0) {
    setStatus(`@${profile.handle} doesn't follow anyone.`);
    return;
  }

  const cutoff = Date.now() - WINDOW_MS;
  const activity = new Array(follows.length).fill(null);
  let completed = 0;
  setStatus(`Counting posts for ${follows.length} accounts…`, { progress: 0 });

  await pool(follows, CONCURRENCY, async (f, i) => {
    activity[i] = await gatherActivity(f.did, cutoff);
    completed += 1;
    setStatus(`Counting posts for ${completed} / ${follows.length} accounts…`, {
      progress: completed / follows.length,
    });
  });

  state.profile = profile;
  state.cutoff = cutoff;
  state.rows = follows.map((f, i) => {
    const a = activity[i] || { originals: 0, reposts: 0, timestamps: [] };
    const total = a.originals + a.reposts;
    return {
      ...f,
      originals: a.originals,
      reposts: a.reposts,
      total,
      perDay: total / WINDOW_DAYS,
      timestamps: a.timestamps,
    };
  });

  resultsEl.hidden = false;
  sortSelectEl.value = state.sortKey;
  updateHeaderSortIndicators();
  renderRows();
  hideStatus();
}

async function getAllFollows(did) {
  const out = [];
  let cursor;
  do {
    const data = await api("app.bsky.graph.getFollows", {
      actor: did,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...data.follows);
    cursor = data.cursor;
  } while (cursor);
  return out;
}

async function gatherActivity(did, cutoffMs) {
  let originals = 0;
  let reposts = 0;
  const timestamps = [];
  let cursor;
  // Safety bound — termination is normally driven by the cutoff or an empty
  // cursor. 500 pages = 50k posts, enough for ~555 posts/day over 90 days.
  for (let page = 0; page < 500; page += 1) {
    const data = await api("app.bsky.feed.getAuthorFeed", {
      actor: did,
      limit: 100,
      filter: "posts_no_replies",
      ...(cursor ? { cursor } : {}),
    });
    const items = data.feed || [];
    if (items.length === 0) break;
    let stop = false;
    for (const item of items) {
      const ts = postTimestamp(item);
      if (ts == null) continue;
      if (ts < cutoffMs) {
        stop = true;
        break;
      }
      if (item.reason) {
        reposts += 1;
        timestamps.push(ts);
      } else if (
        item.post &&
        item.post.author &&
        item.post.author.did === did
      ) {
        originals += 1;
        timestamps.push(ts);
      }
    }
    if (stop) break;
    cursor = data.cursor;
    if (!cursor) break;
  }
  return { originals, reposts, timestamps };
}

function postTimestamp(item) {
  const iso =
    (item.reason && item.reason.indexedAt) ||
    (item.post && item.post.record && item.post.record.createdAt) ||
    (item.post && item.post.indexedAt);
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

async function pool(items, size, worker) {
  let idx = 0;
  const runners = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        try {
          await worker(items[i], i);
        } catch (_) {
          // Leave count at 0 on per-account failure; keep going.
        }
      }
    },
  );
  await Promise.all(runners);
}

async function api(method, params, attempt = 0) {
  const url = `${API}/${method}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  if (res.status === 429 && attempt < 4) {
    await sleep(2 ** attempt * 1000);
    return api(method, params, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${method} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function renderRows() {
  const sorted = state.rows.slice().sort(compareRows);
  const max = (key) => Math.max(0, ...state.rows.map((r) => r[key]));
  const maxTotal = max("total");
  const maxOriginals = max("originals");
  const maxReposts = max("reposts");
  const frac = (value, m) => (m > 0 ? value / m : 0);
  const frag = document.createDocumentFragment();
  for (const r of sorted) {
    const tr = document.createElement("tr");
    tr.dataset.handle = r.handle;
    tr.innerHTML = `
      <td>
        <div class="account">
          ${
            r.avatar
              ? `<img class="avatar" src="${escapeAttr(r.avatar)}" alt="" loading="lazy" />`
              : `<div class="avatar"></div>`
          }
          <div class="account-name">
            ${escapeHtml(r.displayName || r.handle)}
            <span class="account-handle">@${escapeHtml(r.handle)}</span>
          </div>
          ${renderSparkline(r.timestamps, state.cutoff)}
          <div class="account-stat">
            <span class="account-stat-label">Posts/Day</span>
            <span class="account-stat-value">${r.perDay.toFixed(2)}</span>
          </div>
        </div>
      </td>
      <td class="num posts-per-day" data-label="Posts/Day">${r.perDay.toFixed(2)}</td>
      <td class="num tint" data-label="Total" style="--tint:${frac(r.total, maxTotal)}">${r.total}</td>
      <td class="num tint" data-label="Originals" style="--tint:${frac(r.originals, maxOriginals)}">${r.originals}</td>
      <td class="num tint" data-label="Reposts" style="--tint:${frac(r.reposts, maxReposts)}">${r.reposts}</td>
    `;
    frag.appendChild(tr);
  }
  rowsEl.innerHTML = "";
  rowsEl.appendChild(frag);
}

function compareRows(a, b) {
  const k = state.sortKey;
  const dir = state.sortDir === "asc" ? 1 : -1;
  const av = a[k];
  const bv = b[k];
  if (av < bv) return -1 * dir;
  if (av > bv) return 1 * dir;
  return 0;
}

function updateHeaderSortIndicators() {
  const ths = headEl.querySelectorAll("th[data-sort-key]");
  ths.forEach((th) => {
    if (th.dataset.sortKey === state.sortKey) {
      th.setAttribute(
        "aria-sort",
        state.sortDir === "asc" ? "ascending" : "descending",
      );
    } else {
      th.removeAttribute("aria-sort");
    }
  });
}

function renderSparkline(timestamps, cutoffMs) {
  const W = 80;
  const H = 20;
  const bins = new Array(SPARK_BINS).fill(0);
  const span = Date.now() - cutoffMs;
  for (const t of timestamps) {
    const rel = (t - cutoffMs) / span;
    let idx = Math.floor(rel * SPARK_BINS);
    if (idx < 0) idx = 0;
    if (idx >= SPARK_BINS) idx = SPARK_BINS - 1;
    bins[idx] += 1;
  }
  const max = Math.max(...bins, 1);
  const stepX = W / (SPARK_BINS - 1);
  const points = bins
    .map((v, i) => {
      const x = (i * stepX).toFixed(2);
      const y = (H - (v / max) * (H - 2) - 1).toFixed(2);
      return `${x},${y}`;
    })
    .join(" ");
  return `<svg class="sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" /></svg>`;
}

function setStatus(msg, opts = {}) {
  statusEl.hidden = false;
  statusEl.classList.remove("error");
  let html = escapeHtml(msg);
  if (typeof opts.progress === "number") {
    const pct = Math.round(opts.progress * 100);
    html += `<div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>`;
  }
  statusEl.innerHTML = html;
}

function hideStatus() {
  statusEl.hidden = true;
}

function showError(msg) {
  statusEl.hidden = false;
  statusEl.classList.add("error");
  statusEl.textContent = `Error: ${msg}`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}
function escapeAttr(s) {
  return escapeHtml(s);
}
