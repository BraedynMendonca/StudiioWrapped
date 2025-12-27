function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const ss = s % 60;
  if (h > 0) return `${h}h ${mm}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${s}s`;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[c]));
}

function parseId() {
  const url = new URL(location.href);
  return url.searchParams.get("id");
}

async function getSessions() {
  const { sr_sessions } = await chrome.storage.local.get("sr_sessions");
  return sr_sessions || [];
}

async function loadSession(id) {
  const sessions = await getSessions();
  return sessions.find(s => s.id === id) || null;
}

function badge(score) {
  const cls = score >= 75 ? "bad" : score >= 45 ? "warn" : "good";
  return `<span class="badge ${cls}">${score}</span>`;
}

function downloadDataUrl(filename, dataUrl) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawKpi(ctx, x, y, label, value, accentA, accentB) {
  ctx.fillStyle = "rgba(255,255,255,0.60)";
  ctx.font = "800 18px ui-sans-serif, system-ui";
  ctx.fillText(label, x, y);

  const g = ctx.createLinearGradient(x, y + 10, x + 240, y + 10);
  g.addColorStop(0, accentA);
  g.addColorStop(1, accentB);
  ctx.fillStyle = g;
  ctx.font = "950 38px ui-sans-serif, system-ui";
  ctx.fillText(value, x, y + 52);
}

function makeSessionShareCard(session) {
  const w = 1200, h = 630;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");

  const accentA = "#1A9BBB";
  const accentB = "#7AC45C";

  // background
  ctx.fillStyle = "#071018";
  ctx.fillRect(0, 0, w, h);

  const g1 = ctx.createRadialGradient(220, 140, 10, 220, 140, 560);
  g1.addColorStop(0, "rgba(26,155,187,0.55)");
  g1.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, w, h);

  const g2 = ctx.createRadialGradient(980, 160, 10, 980, 160, 520);
  g2.addColorStop(0, "rgba(122,196,92,0.45)");
  g2.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, w, h);

  // main card
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  roundRect(ctx, 60, 60, w - 120, h - 120, 28);
  ctx.fill();

  // top accent
  const bar = ctx.createLinearGradient(60, 60, w - 60, 60);
  bar.addColorStop(0, accentA);
  bar.addColorStop(1, accentB);
  ctx.fillStyle = bar;
  roundRect(ctx, 60, 60, w - 120, 12, 10);
  ctx.fill();

  // title
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.font = "950 48px ui-sans-serif, system-ui";
  ctx.fillText("StudiioWrapped", 100, 160);

  ctx.fillStyle = "rgba(255,255,255,0.62)";
  ctx.font = "800 22px ui-sans-serif, system-ui";
  ctx.fillText("Session recap", 100, 200);

  const total = fmtMs(session.totals?.totalMs || 0);
  const switches = String(session.totals?.tabSwitches || 0);
  const topWeak = String((session.confusionSummary || [])[0]?.score ?? 0);

  drawKpi(ctx, 100, 265, "Study time", total, accentA, accentB);
  drawKpi(ctx, 430, 265, "Tab switches", switches, accentA, accentB);
  drawKpi(ctx, 760, 265, "Top weak score", topWeak, accentA, accentB);

  const weak = (session.confusionSummary || []).slice(0, 3);

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "900 26px ui-sans-serif, system-ui";
  ctx.fillText("Top weak spots", 100, 430);

  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "800 20px ui-sans-serif, system-ui";
  weak.forEach((witem, i) => {
    const t = (witem.title || witem.url || "").slice(0, 58);
    ctx.fillText(`${i + 1}. ${t}`, 120, 470 + i * 34);
  });

  ctx.fillStyle = "rgba(255,255,255,0.46)";
  ctx.font = "800 16px ui-sans-serif, system-ui";
  ctx.fillText(new Date(session.startTime).toLocaleString(), 100, 540);

  return canvas.toDataURL("image/png");
}

async function openWeakSpots(session) {
  const weak = (session.confusionSummary || []).slice(0, 3);
  if (!weak.length) return alert("No weak spots yet.");
  for (const w of weak) await chrome.tabs.create({ url: w.url });
}

(async () => {
  const id = parseId();
  const session = await loadSession(id);
  if (!session) {
    document.getElementById("meta").textContent = "Session not found.";
    return;
  }

  document.getElementById("meta").textContent =
    `${new Date(session.startTime).toLocaleString()} → ${session.endTime ? new Date(session.endTime).toLocaleString() : "—"}`;

  document.getElementById("kpiTime").textContent = fmtMs(session.totals?.totalMs || 0);
  document.getElementById("kpiSwitch").textContent = String(session.totals?.tabSwitches || 0);

  const top = (session.confusionSummary || [])[0];
  document.getElementById("kpiWeak").textContent = top ? String(top.score) : "—";

  const pageCount = Object.keys(session.pages || {}).length;
  document.getElementById("kpiPages").textContent = String(pageCount);

  // weak list
  const weakList = document.getElementById("weakList");
  const items = session.confusionSummary || [];
  weakList.innerHTML = items.length ? items.slice(0, 10).map(item => {
    const reasons = (item.reasons || []).slice(0, 3).join(" • ");
    return `
      <div class="item">
        <div class="itemTop">
          <div class="itemTitle">${escapeHtml(item.title || item.url)}</div>
          ${badge(item.score)}
        </div>
        <div class="itemSub">${escapeHtml(reasons || "—")}</div>
        <div class="itemMono">${escapeHtml(item.url)}</div>
      </div>
    `;
  }).join("") : `<div class="empty">No weak spots detected.</div>`;

  // timeline
  const tl = document.getElementById("timeline");
  const visits = (session.visits || []).filter(v => v.end != null);
  tl.innerHTML = visits.length ? visits.slice(0, 18).map(v => `
    <div class="item">
      <div class="itemTop">
        <div class="itemTitle">${escapeHtml(v.title || v.url)}</div>
        <span class="badge neutral">${escapeHtml(fmtMs(v.dwellMs || 0))}</span>
      </div>
      <div class="itemSub">${escapeHtml(v.url)}</div>
    </div>
  `).join("") : `<div class="empty">No timeline.</div>`;

  // pages stats
  const pagesEl = document.getElementById("pages");
  const pages = Object.values(session.pages || {});
  pages.sort((a,b) => (b.totalDwellMs||0)-(a.totalDwellMs||0));
  const scoreByUrl = new Map(items.map(x => [x.url, x.score]));
  pagesEl.innerHTML = pages.length ? pages.slice(0, 40).map(p => {
    const score = scoreByUrl.get(p.url) ?? 0;
    return `
      <div class="item">
        <div class="itemTop">
          <div class="itemTitle">${escapeHtml(p.title || p.url)}</div>
          <span class="badge neutral">${escapeHtml(fmtMs(p.totalDwellMs || 0))}</span>
        </div>
        <div class="itemSub">rereads: ${p.reversals || 0} • thrash: ${p.thrash || 0} • depth: ${Math.round(p.maxScrollY || 0)}px • score: ${score}</div>
        <div class="itemMono">${escapeHtml(p.url)}</div>
      </div>
    `;
  }).join("") : `<div class="empty">No page stats.</div>`;

  document.getElementById("openWeakBtn").addEventListener("click", () => openWeakSpots(session));
  document.getElementById("shareBtn").addEventListener("click", () => {
    const dataUrl = makeSessionShareCard(session);
    downloadDataUrl(`studiio-wrapped-session-${session.id}.png`, dataUrl);
  });
})();
