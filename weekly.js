function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h > 0) return `${h}h ${mm}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[c]));
}

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return "unknown"; }
}

async function getSessions() {
  const { sr_sessions } = await chrome.storage.local.get("sr_sessions");
  return sr_sessions || [];
}

function lastNDaysSessions(sessions, days = 7) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return sessions.filter(s => (s.startTime || 0) >= cutoff);
}

function aggregateWeekly(sessions) {
  let totalMs = 0;
  const byHostMs = new Map();
  const weakCounts = new Map();

  for (const s of sessions) {
    totalMs += s.totals?.totalMs || 0;

    const pages = s.pages ? Object.values(s.pages) : [];
    for (const p of pages) {
      const h = hostOf(p.url);
      byHostMs.set(h, (byHostMs.get(h) || 0) + (p.totalDwellMs || 0));
    }

    const weak = (s.confusionSummary || []).slice(0, 3);
    for (const w of weak) {
      const key = (w.title || w.url || "").slice(0, 90);
      weakCounts.set(key, (weakCounts.get(key) || 0) + 1);
    }
  }

  const topSites = [...byHostMs.entries()].sort((a,b) => b[1]-a[1]).slice(0, 8);
  const topWeak = [...weakCounts.entries()].sort((a,b) => b[1]-a[1]).slice(0, 8);
  const topSiteName = topSites[0]?.[0] || "—";

  return { totalMs, topSites, topWeak, topSiteName };
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

function makeWeeklyShareCard(totalMs, sessionsCount, topSite, topWeak) {
  const w = 1200, h = 630;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");

  const accentA = "#1A9BBB";
  const accentB = "#7AC45C";

  ctx.fillStyle = "#071018";
  ctx.fillRect(0, 0, w, h);

  const g1 = ctx.createRadialGradient(220, 140, 10, 220, 140, 560);
  g1.addColorStop(0, "rgba(26,155,187,0.55)");
  g1.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g1; ctx.fillRect(0, 0, w, h);

  const g2 = ctx.createRadialGradient(980, 160, 10, 980, 160, 520);
  g2.addColorStop(0, "rgba(122,196,92,0.45)");
  g2.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g2; ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  roundRect(ctx, 60, 60, w - 120, h - 120, 28);
  ctx.fill();

  const bar = ctx.createLinearGradient(60, 60, w - 60, 60);
  bar.addColorStop(0, accentA);
  bar.addColorStop(1, accentB);
  ctx.fillStyle = bar;
  roundRect(ctx, 60, 60, w - 120, 12, 10);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.font = "950 48px ui-sans-serif, system-ui";
  ctx.fillText("StudiioWrapped", 100, 160);

  ctx.fillStyle = "rgba(255,255,255,0.62)";
  ctx.font = "800 22px ui-sans-serif, system-ui";
  ctx.fillText("Weekly recap (last 7 days)", 100, 200);

  drawKpi(ctx, 100, 265, "Total time", fmtMs(totalMs), accentA, accentB);
  drawKpi(ctx, 430, 265, "Sessions", String(sessionsCount), accentA, accentB);
  drawKpi(ctx, 760, 265, "Top site", topSite || "—", accentA, accentB);

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "900 26px ui-sans-serif, system-ui";
  ctx.fillText("Recurring weak spots", 100, 430);

  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "800 20px ui-sans-serif, system-ui";
  topWeak.slice(0, 3).forEach((x, i) => {
    const title = (x?.[0] || "—").slice(0, 58);
    const count = x?.[1] || 0;
    ctx.fillText(`${i + 1}. ${title}  (${count}x)`, 120, 470 + i * 34);
  });

  ctx.fillStyle = "rgba(255,255,255,0.46)";
  ctx.font = "800 16px ui-sans-serif, system-ui";
  ctx.fillText(new Date().toLocaleDateString(), 100, 540);

  return canvas.toDataURL("image/png");
}

(async () => {
  const all = await getSessions();
  const week = lastNDaysSessions(all, 7);
  const agg = aggregateWeekly(week);

  const totalMs = agg.totalMs;
  const avg = week.length ? Math.round(totalMs / week.length) : 0;

  document.getElementById("wkTotal").textContent = fmtMs(totalMs);
  document.getElementById("wkSessions").textContent = String(week.length);
  document.getElementById("wkAvg").textContent = week.length ? fmtMs(avg) : "—";
  document.getElementById("wkTopSite").textContent = agg.topSiteName;

  const topSitesEl = document.getElementById("topSites");
  topSitesEl.innerHTML = agg.topSites.length ? agg.topSites.map(([host, ms]) => `
    <div class="item">
      <div class="itemTop">
        <div class="itemTitle">${escapeHtml(host)}</div>
        <span class="badge neutral">${escapeHtml(fmtMs(ms))}</span>
      </div>
    </div>
  `).join("") : `<div class="empty">No sessions this week yet.</div>`;

  const weakEl = document.getElementById("weakSpots");
  weakEl.innerHTML = agg.topWeak.length ? agg.topWeak.map(([title, count]) => `
    <div class="item">
      <div class="itemTop">
        <div class="itemTitle">${escapeHtml(title)}</div>
        <span class="badge neutral">${escapeHtml(String(count) + "x")}</span>
      </div>
    </div>
  `).join("") : `<div class="empty">No weak-spot data yet.</div>`;

  const sessionList = document.getElementById("sessionList");
  sessionList.innerHTML = week.length ? week.slice(0, 20).map(s => {
    const url = chrome.runtime.getURL("replay.html") + `?id=${encodeURIComponent(s.id)}`;
    const when = new Date(s.startTime).toLocaleString();
    const t = fmtMs(s.totals?.totalMs || 0);
    return `
      <a class="sessionLink" href="${url}">
        <div class="itemTop">
          <div class="itemTitle">${escapeHtml(when)}</div>
          <span class="badge neutral">${escapeHtml(t)}</span>
        </div>
        <div class="itemSub">Switches: ${s.totals?.tabSwitches || 0}</div>
      </a>
    `;
  }).join("") : `<div class="empty">No sessions this week yet.</div>`;

  document.getElementById("shareBtn").addEventListener("click", () => {
    const dataUrl = makeWeeklyShareCard(totalMs, week.length, agg.topSiteName, agg.topWeak);
    downloadDataUrl("studiio-wrapped-weekly.png", dataUrl);
  });
})();
