const API = "https://public.api.bsky.app/xrpc";
const WINDOW_DAYS = 90;
const CONCURRENCY = 6;

const form = document.getElementById("form");
const handleInput = document.getElementById("handle");
const goBtn = document.getElementById("go");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const rowsEl = document.getElementById("rows");
const summaryEl = document.getElementById("summary");

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

  const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const counts = new Array(follows.length).fill(0);
  let completed = 0;
  setStatus(
    `Counting posts in the last ${WINDOW_DAYS} days for ${follows.length} accounts…`,
    { progress: 0 },
  );

  await pool(follows, CONCURRENCY, async (f, i) => {
    counts[i] = await countPostsSince(f.did, cutoff);
    completed += 1;
    setStatus(
      `Counting posts in the last ${WINDOW_DAYS} days… ${completed} / ${follows.length}`,
      { progress: completed / follows.length },
    );
  });

  const ranked = follows
    .map((f, i) => ({ ...f, posts: counts[i], perDay: counts[i] / WINDOW_DAYS }))
    .sort((a, b) => b.perDay - a.perDay);

  render(ranked, profile);
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

async function countPostsSince(did, cutoffMs) {
  let count = 0;
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const data = await api("app.bsky.feed.getAuthorFeed", {
      actor: did,
      limit: 100,
      filter: "posts_with_replies",
      ...(cursor ? { cursor } : {}),
    });
    const items = data.feed || [];
    if (items.length === 0) break;
    let stop = false;
    for (const item of items) {
      const ts = postTimestamp(item);
      if (ts == null) continue;
      if (ts < cutoffMs) { stop = true; break; }
      // Only count original posts by this author (skip reposts).
      if (item.reason) continue;
      if (item.post && item.post.author && item.post.author.did === did) {
        count += 1;
      }
    }
    if (stop) break;
    cursor = data.cursor;
    if (!cursor) break;
  }
  return count;
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
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        await worker(items[i], i);
      } catch (_) {
        // Leave count at 0 on per-account failure; keep going.
      }
    }
  });
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

function render(rows, profile) {
  resultsEl.hidden = false;
  summaryEl.textContent =
    `${rows.length} follows · last ${WINDOW_DAYS} days · viewing @${profile.handle}`;
  const frag = document.createDocumentFragment();
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="num">${i + 1}</td>
      <td>
        <div class="account">
          ${r.avatar
            ? `<img class="avatar" src="${escapeAttr(r.avatar)}" alt="" loading="lazy" />`
            : `<div class="avatar"></div>`}
          <div class="account-name">
            <a href="https://bsky.app/profile/${escapeAttr(r.handle)}" target="_blank" rel="noopener">
              ${escapeHtml(r.displayName || r.handle)}
            </a>
            <span class="account-handle">@${escapeHtml(r.handle)}</span>
          </div>
        </div>
      </td>
      <td class="num">${r.posts}</td>
      <td class="num">${r.perDay.toFixed(2)}</td>
    `;
    frag.appendChild(tr);
  });
  rowsEl.appendChild(frag);
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

function hideStatus() { statusEl.hidden = true; }

function showError(msg) {
  statusEl.hidden = false;
  statusEl.classList.add("error");
  statusEl.textContent = `Error: ${msg}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
