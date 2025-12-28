// StudiioWrapped — Main App
// Professional-feeling UI with smooth transitions and local state.

const $ = (q) => document.querySelector(q);
const $$ = (q) => Array.from(document.querySelectorAll(q));

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
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

function fmtMMSS(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const DEFAULT_MINUTES = { focus: 25, short: 5, long: 15 };

function getModeMinutes(mode, settings) {
  const s = settings || {};
  const raw = mode === "short" ? s.shortMin : mode === "long" ? s.longMin : s.focusMin;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MINUTES[mode] || DEFAULT_MINUTES.focus;
}

function fmtTimeOfDay(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[c]));
}

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return "unknown"; }
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 1700);
}

async function api(msg) {
  return await chrome.runtime.sendMessage(msg);
}

let DATA = {
  sessions: [],
  tasks: [],
  tags: [],
  settings: null,
  timer: null,
  streak: 0,
  state: null
};

let UI = {
  activeView: "timer",
  selectedTagId: null,
  activeTaskId: null,
  activeTagId: null,
  timerMode: "focus",
  timerTick: null,
  timerRefreshTimer: null
};

// ---------- View switching (smooth) ----------
function setView(view) {
  UI.activeView = view;

  $$(".navBtn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === `view-${view}`));

  const titles = {
    timer: ["Timer", "Lock in. Track. Wrap."],
    tasks: ["Tasks", "One active task. Everything wraps around it."],
    stats: ["Stats", "Weekly signals + session replays"],
    achievements: ["Achievements", "Consistency, not cringe."],
    settings: ["Settings", "Tune flow + your experience"]
  };
  $("#pageTitle").textContent = titles[view][0];
  $("#pageSub").textContent = titles[view][1];

  // subtle entrance animation
  const el = $(`#view-${view}`);
  el.classList.remove("enter");
  void el.offsetWidth;
  el.classList.add("enter");
}

$$(".navBtn").forEach(btn => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

// ---------- Session controls ----------
async function refreshStatusText() {
  const res = await api({ type: "SR_GET_STATUS" });
  if (!res?.ok) return;
  DATA.state = res.state;
  DATA.timer = res.timer;
  DATA.settings = res.settings;
  DATA.streak = res.streak;

  const running = !!DATA.state?.running;
  $("#navSub").textContent = running ? "Session running" : "Ready";
  $("#sessionBtn").textContent = running ? "Session Running" : "Start Session";
  $("#sessionBtn").disabled = running;
  $("#wrapBtn").disabled = !running;

  applyTheme(DATA.settings?.theme || "dark");
  hydrateSettingsUI();
}

$("#sessionBtn").addEventListener("click", async () => {
  const meta = { activeTaskId: UI.activeTaskId || null, activeTagId: UI.activeTagId || null };
  const res = await api({ type: "SR_START_SESSION", meta });
  if (res?.ok) toast("Session started");
  await loadAll();
});

$("#wrapBtn").addEventListener("click", async () => {
  const res = await api({ type: "SR_STOP_SESSION" });
  if (res?.ok && res.sessionId) {
    toast("Wrapped generated");
    await chrome.tabs.create({ url: chrome.runtime.getURL("replay.html") + `?id=${encodeURIComponent(res.sessionId)}` });
  }
  await loadAll();
});

// ---------- Timer ----------
function setTimerMode(mode) {
  UI.timerMode = mode;
  $$(".segBtn").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  updateTimerUI();
}

$$(".segBtn").forEach(b => b.addEventListener("click", () => setTimerMode(b.dataset.mode)));

$("#timerStart").addEventListener("click", async () => {
  const res = await api({ type: "SR_TIMER_START", mode: UI.timerMode, activeTaskId: UI.activeTaskId || null });
  if (res?.ok) toast("Timer started");
  await loadAll();
});

$("#timerStop").addEventListener("click", async () => {
  const res = await api({ type: "SR_TIMER_STOP" });
  if (res?.ok) toast("Timer stopped");
  await loadAll();
});

$("#timerLinkTask").addEventListener("click", () => {
  setView("tasks");
  toast("Pick an active task + tag");
});

function stopLocalTimerTick() {
  if (UI.timerTick) clearInterval(UI.timerTick);
  UI.timerTick = null;
}

function startLocalTimerTick() {
  if (UI.timerTick) return;
  UI.timerTick = setInterval(() => updateTimerUI(), 200);
}

function queueTimerRefresh() {
  if (UI.timerRefreshTimer) return;
  UI.timerRefreshTimer = setTimeout(async () => {
    UI.timerRefreshTimer = null;
    await loadAll();
  }, 350);
}

function ringProgress(p) {
  // SVG circle stroke
  const fg = $(".ringFg");
  const r = 46;
  const c = 2 * Math.PI * r;
  fg.style.strokeDasharray = `${c}`;
  fg.style.strokeDashoffset = `${c * (1 - p)}`;
}

function updateTimerUI() {
  const settings = DATA.settings || {};
  const t = DATA.timer || {};

  const mode = t.running && t.mode ? t.mode : UI.timerMode;
  const modeLabel =
    mode === "focus" ? "Focus" :
    mode === "short" ? "Short break" :
    "Long break";

  const minutesPlanned = getModeMinutes(mode, settings);
  const plannedMs = minutesPlanned * 60 * 1000;
  const totalPlanned = Number.isFinite(plannedMs) && plannedMs > 0 ? plannedMs : DEFAULT_MINUTES.focus * 60 * 1000;

  let remaining = totalPlanned;
  let duration = totalPlanned;
  let meta = "Ready";
  const running = !!(t.running && t.endsAt);

  if (running) {
    const startedAt = Number.isFinite(t.startedAt) ? t.startedAt : Date.now();
    duration = Math.max(1000, t.endsAt - startedAt); // avoid divide-by-zero
    remaining = Math.max(0, t.endsAt - Date.now());
    meta = t.mode === "focus" ? "Focusing" : "On break";

    if (remaining <= 0) {
      queueTimerRefresh();
    }
  }

  $("#timerBig").textContent = fmtMMSS(remaining);
  const endLabel = running && t.endsAt ? ` · ends ${fmtTimeOfDay(t.endsAt)}` : "";
  $("#timerMeta").textContent = running ? `${meta}${endLabel}` : `Ready • ${modeLabel.toLowerCase()}`;

  const progress = clamp(1 - remaining / duration, 0, 1);
  ringProgress(progress);

  $("#timerModeChip").textContent = `${modeLabel} · ${minutesPlanned}m`;
  $("#timerEndChip").textContent = running
    ? (remaining <= 0 ? "Finishing up…" : `Ends at ${fmtTimeOfDay(t.endsAt)}`)
    : `Ready for ${modeLabel.toLowerCase()}`;

  $$(".segBtn").forEach(btn => {
    const isActive = btn.dataset.mode === mode;
    btn.classList.toggle("active", isActive);
    btn.disabled = running;
  });

  if (running) startLocalTimerTick();
  else stopLocalTimerTick();

  // Buttons
  $("#timerStart").disabled = running;
  $("#timerStop").disabled = !running;
}

// ---------- Tasks + Tags ----------
function seedDefaultsIfEmpty() {
  if (!DATA.tags?.length) {
    DATA.tags = [
      { id: "tag_study", name: "Study", color: "#1A9BBB" },
      { id: "tag_build", name: "Build", color: "#7AC45C" },
      { id: "tag_research", name: "Research", color: "#2BB8A7" }
    ];
  }
}

function pickNiceColor(i) {
  const palette = ["#1A9BBB", "#7AC45C", "#3BC7D4", "#4BBF8A", "#2A8FC2", "#6BD06B"];
  return palette[i % palette.length];
}

async function saveTasks() { await api({ type: "SR_SAVE_TASKS", tasks: DATA.tasks }); }
async function saveTags() { await api({ type: "SR_SAVE_TAGS", tags: DATA.tags }); }

function renderTags() {
  const wrap = $("#tagList");
  wrap.innerHTML = "";

  DATA.tags.forEach((tag) => {
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div class="rowLeft">
        <span class="tagDot" style="background:${escapeHtml(tag.color)}"></span>
        <div class="rowTitle">${escapeHtml(tag.name)}</div>
      </div>
      <div class="rowRight">
        <button class="btn tiny soft" data-pick="${escapeHtml(tag.id)}">Pick</button>
        <button class="btn tiny ghost danger" data-del="${escapeHtml(tag.id)}">Delete</button>
      </div>
    `;
    wrap.appendChild(el);
  });

  wrap.querySelectorAll("[data-pick]").forEach(b => {
    b.addEventListener("click", () => {
      UI.selectedTagId = b.dataset.pick;
      const tag = DATA.tags.find(t => t.id === UI.selectedTagId);
      $("#tagPreview").innerHTML = tag
        ? `<span class="tagDot" style="background:${tag.color}"></span> ${escapeHtml(tag.name)}`
        : "No tag selected";
      toast("Tag selected");
    });
  });

  wrap.querySelectorAll("[data-del]").forEach(b => {
    b.addEventListener("click", async () => {
      const id = b.dataset.del;
      DATA.tags = DATA.tags.filter(t => t.id !== id);
      if (UI.selectedTagId === id) UI.selectedTagId = null;
      if (UI.activeTagId === id) UI.activeTagId = null;
      await saveTags();
      renderTags();
      renderActiveSelection();
      toast("Tag deleted");
    });
  });
}

function renderTasks() {
  const wrap = $("#taskList");
  wrap.innerHTML = "";

  const byId = new Map(DATA.tags.map(t => [t.id, t]));
  DATA.tasks.forEach((task) => {
    const tag = task.tagId ? byId.get(task.tagId) : null;
    const isActive = UI.activeTaskId === task.id;

    const el = document.createElement("div");
    el.className = "taskRow";
    el.innerHTML = `
      <button class="taskCheck ${task.done ? "done" : ""}" data-toggle="${escapeHtml(task.id)}">
        ${task.done ? "✓" : ""}
      </button>

      <div class="taskMain">
        <div class="taskTitle ${task.done ? "mutedStrike" : ""}">${escapeHtml(task.title)}</div>
        <div class="taskMeta">
          ${tag ? `<span class="tagPill" style="border-color:${tag.color}; color:${tag.color};">
            <span class="tagDot" style="background:${tag.color}"></span>${escapeHtml(tag.name)}
          </span>` : `<span class="tagPill neutral">No tag</span>`}
          ${isActive ? `<span class="tagPill active">Active</span>` : ""}
        </div>
      </div>

      <div class="taskRight">
        <button class="btn tiny soft" data-active="${escapeHtml(task.id)}">${isActive ? "Active" : "Set active"}</button>
        <button class="btn tiny ghost danger" data-del="${escapeHtml(task.id)}">Delete</button>
      </div>
    `;
    wrap.appendChild(el);
  });

  wrap.querySelectorAll("[data-toggle]").forEach(b => {
    b.addEventListener("click", async () => {
      const id = b.dataset.toggle;
      const t = DATA.tasks.find(x => x.id === id);
      if (!t) return;
      t.done = !t.done;
      await saveTasks();
      renderTasks();
      toast(t.done ? "Completed" : "Reopened");
    });
  });

  wrap.querySelectorAll("[data-active]").forEach(b => {
    b.addEventListener("click", async () => {
      UI.activeTaskId = b.dataset.active;
      const task = DATA.tasks.find(t => t.id === UI.activeTaskId);
      UI.activeTagId = task?.tagId || UI.activeTagId || null;

      renderTasks();
      renderActiveSelection();
      updateActiveChips();
      toast("Active task set");
    });
  });

  wrap.querySelectorAll("[data-del]").forEach(b => {
    b.addEventListener("click", async () => {
      const id = b.dataset.del;
      DATA.tasks = DATA.tasks.filter(t => t.id !== id);
      if (UI.activeTaskId === id) UI.activeTaskId = null;
      await saveTasks();
      renderTasks();
      renderActiveSelection();
      updateActiveChips();
      toast("Task deleted");
    });
  });
}

function renderActiveSelection() {
  const task = DATA.tasks.find(t => t.id === UI.activeTaskId);
  const tag = DATA.tags.find(t => t.id === (task?.tagId || UI.activeTagId));

  $("#activeTaskLine").textContent = `Task: ${task ? task.title : "—"}`;
  $("#activeTagLine").textContent = `Tag: ${tag ? tag.name : "—"}`;
}

function updateActiveChips() {
  const task = DATA.tasks.find(t => t.id === UI.activeTaskId);
  const tag = DATA.tags.find(t => t.id === (task?.tagId || UI.activeTagId));

  $("#activeTaskChip").textContent = task ? task.title : "No active task";
  if (tag) {
    $("#activeTagChip").innerHTML = `<span class="tagDot" style="background:${tag.color}"></span>${escapeHtml(tag.name)}`;
  } else {
    $("#activeTagChip").textContent = "No tag";
  }
}

$("#addTaskBtn").addEventListener("click", async () => {
  const title = ($("#taskInput").value || "").trim();
  if (!title) return toast("Type a task first");
  const id = "task_" + Math.random().toString(16).slice(2);
  const task = { id, title, done: false, tagId: UI.selectedTagId || null, createdAt: Date.now() };
  DATA.tasks.unshift(task);
  $("#taskInput").value = "";
  await saveTasks();
  renderTasks();
  toast("Task added");
});

$("#addTagBtn").addEventListener("click", async () => {
  const name = ($("#tagInput").value || "").trim();
  if (!name) return toast("Type a tag name");
  const id = "tag_" + Math.random().toString(16).slice(2);
  const color = pickNiceColor(DATA.tags.length);
  DATA.tags.unshift({ id, name, color });
  $("#tagInput").value = "";
  await saveTags();
  renderTags();
  toast("Tag added");
});

$("#tagPickerBtn").addEventListener("click", () => {
  toast("Pick a tag from the list →");
});

// ---------- Stats ----------
function sessionsLast7d() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return (DATA.sessions || []).filter(s => (s.startTime || 0) >= cutoff);
}

function calcWeeklyAgg() {
  const week = sessionsLast7d();
  const totalMs = week.reduce((a, s) => a + (s.totals?.totalMs || 0), 0);
  const avg = week.length ? Math.round(totalMs / week.length) : 0;

  const byHost = new Map();
  for (const s of week) {
    const pages = s.pages ? Object.values(s.pages) : [];
    for (const p of pages) {
      const h = hostOf(p.url);
      byHost.set(h, (byHost.get(h) || 0) + (p.totalDwellMs || 0));
    }
  }
  const topSites = [...byHost.entries()].sort((a,b) => b[1]-a[1]).slice(0, 8);
  const topSite = topSites[0]?.[0] || "—";

  return { week, totalMs, avg, topSites, topSite };
}

function renderStats() {
  const { week, totalMs, avg, topSites, topSite } = calcWeeklyAgg();

  $("#wkTotal").textContent = fmtMs(totalMs);
  $("#wkSessions").textContent = String(week.length);
  $("#wkTopSite").textContent = topSite;
  $("#wkAvg").textContent = week.length ? fmtMs(avg) : "—";

  // top sites
  const sitesEl = $("#topSitesList");
  sitesEl.innerHTML = topSites.length
    ? topSites.map(([h, ms]) => `
      <div class="item">
        <div class="itemTop">
          <div class="itemTitle">${escapeHtml(h)}</div>
          <span class="badge neutral">${escapeHtml(fmtMs(ms))}</span>
        </div>
      </div>
    `).join("")
    : `<div class="empty">No sessions this week yet.</div>`;

  // session list
  const list = $("#sessionList");
  list.innerHTML = (week.length ? week.slice(0, 18) : DATA.sessions.slice(0, 18)).map(s => {
    const when = new Date(s.startTime).toLocaleString();
    const t = fmtMs(s.totals?.totalMs || 0);
    const url = chrome.runtime.getURL("replay.html") + `?id=${encodeURIComponent(s.id)}`;
    return `
      <a class="sessionLink" href="${url}">
        <div class="itemTop">
          <div class="itemTitle">${escapeHtml(when)}</div>
          <span class="badge neutral">${escapeHtml(t)}</span>
        </div>
        <div class="itemSub">Switches: ${s.totals?.tabSwitches || 0}</div>
      </a>
    `;
  }).join("") || `<div class="empty">No sessions saved yet.</div>`;

  // mini weak list for timer panel
  const weakMini = $("#weakMiniList");
  const weak = [];
  for (const s of week) {
    (s.confusionSummary || []).slice(0, 2).forEach(x => weak.push(x));
  }
  weak.sort((a,b) => (b.score||0)-(a.score||0));
  const topWeak = weak.slice(0, 5);

  weakMini.innerHTML = topWeak.length
    ? topWeak.map(w => `
      <div class="item compact">
        <div class="itemTop">
          <div class="itemTitle">${escapeHtml((w.title || w.url).slice(0, 52))}</div>
          <span class="badge ${w.score >= 75 ? "bad" : w.score >= 45 ? "warn" : "good"}">${w.score}</span>
        </div>
        <div class="itemSub">${escapeHtml((w.reasons || []).slice(0, 2).join(" • ") || "—")}</div>
      </div>
    `).join("")
    : `<div class="empty">No weak-spot data yet.</div>`;
}

function updateMiniKpis() {
  $("#kpiStreak").textContent = `${DATA.streak || 0}d`;

  const { totalMs } = calcWeeklyAgg();
  $("#kpiWeek").textContent = fmtMs(totalMs);

  // Timer kpis (last 7 days)
  const week = sessionsLast7d();
  const total = week.reduce((a, s) => a + (s.totals?.totalMs || 0), 0);
  const avg = week.length ? total / week.length : 0;
  const switches = week.reduce((a, s) => a + (s.totals?.tabSwitches || 0), 0);

  $("#kpiSessions").textContent = String(week.length);
  $("#kpiStudy").textContent = fmtMs(total);
  $("#kpiAvg").textContent = week.length ? fmtMs(avg) : "—";
  $("#kpiSwitches").textContent = String(switches);
}

$("#openWeekly").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.tabs.create({ url: chrome.runtime.getURL("weekly.html") });
});
$("#openSessions").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.tabs.create({ url: chrome.runtime.getURL("replay.html") });
});

$("#downloadWeeklyCard").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("weekly.html") });
  toast("Weekly view opened (download there)");
});

$("#downloadLatestCard").addEventListener("click", async () => {
  const latest = DATA.sessions?.[0];
  if (!latest) return toast("No sessions yet");
  await chrome.tabs.create({ url: chrome.runtime.getURL("replay.html") + `?id=${encodeURIComponent(latest.id)}` });
  toast("Opened latest session");
});

// ---------- Achievements ----------
function buildAchievements() {
  const sessions = DATA.sessions || [];
  const totalSessions = sessions.length;
  const totalMs = sessions.reduce((a, s) => a + (s.totals?.totalMs || 0), 0);

  const streak = DATA.streak || 0;
  const { week } = calcWeeklyAgg();
  const weekCount = week.length;

  const thresholds = [
    { id:"a1", title:"First Wrap", desc:"Complete your first session", done: totalSessions >= 1 },
    { id:"a2", title:"Routine", desc:"Hit 10 sessions", done: totalSessions >= 10 },
    { id:"a3", title:"Habitual", desc:"Hit 50 sessions", done: totalSessions >= 50 },
    { id:"a4", title:"Century Club", desc:"Hit 100 sessions", done: totalSessions >= 100 },
    { id:"a5", title:"Momentum", desc:"3-day streak", done: streak >= 3 },
    { id:"a6", title:"Week Warrior", desc:"7-day streak", done: streak >= 7 },
    { id:"a7", title:"Deep Work", desc:"Study 10 hours total", done: totalMs >= 10 * 60 * 60 * 1000 },
    { id:"a8", title:"Laser Week", desc:"5 sessions in 7 days", done: weekCount >= 5 }
  ];

  return thresholds;
}

function renderAchievements() {
  const grid = $("#achGrid");
  const items = buildAchievements();

  grid.innerHTML = items.map(a => `
    <div class="achCard ${a.done ? "done" : ""}">
      <div class="achTop">
        <div class="achTitle">${escapeHtml(a.title)}</div>
        <div class="achBadge ${a.done ? "on" : ""}">${a.done ? "Unlocked" : "Locked"}</div>
      </div>
      <div class="achDesc">${escapeHtml(a.desc)}</div>
      <div class="achBar">
        <div class="achFill" style="width:${a.done ? "100" : "35"}%"></div>
      </div>
    </div>
  `).join("");
}

// ---------- Settings ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function hydrateSettingsUI() {
  const s = DATA.settings || {};
  if (!s) return;
  $("#setFocus").value = s.focusMin ?? 25;
  $("#setShort").value = s.shortMin ?? 5;
  $("#setLong").value = s.longMin ?? 15;
  $("#setRounds").value = s.roundsPerSet ?? 4;
}

$("#saveSettings").addEventListener("click", async () => {
  const next = {
    focusMin: clamp(parseInt($("#setFocus").value || "25", 10), 1, 180),
    shortMin: clamp(parseInt($("#setShort").value || "5", 10), 1, 60),
    longMin: clamp(parseInt($("#setLong").value || "15", 10), 1, 90),
    roundsPerSet: clamp(parseInt($("#setRounds").value || "4", 10), 1, 10)
  };
  const res = await api({ type: "SR_SET_SETTINGS", settings: next });
  if (res?.ok) toast("Saved");
  await loadAll();
});

$("#resetSettings").addEventListener("click", async () => {
  const res = await api({ type: "SR_SET_SETTINGS", settings: {
    theme: "dark",
    focusMin: 25,
    shortMin: 5,
    longMin: 15,
    roundsPerSet: 4,
    openFullOnClick: true,
    notifyOnTimerEnd: true
  }});
  if (res?.ok) toast("Reset");
  await loadAll();
});

$("#toggleTheme").addEventListener("click", async () => {
  const cur = DATA.settings?.theme || "dark";
  const next = cur === "dark" ? "light" : "dark";
  await api({ type: "SR_SET_SETTINGS", settings: { theme: next } });
  toast(`Theme: ${next}`);
  await loadAll();
});

$("#toggleNotify").addEventListener("click", async () => {
  const cur = !!DATA.settings?.notifyOnTimerEnd;
  await api({ type: "SR_SET_SETTINGS", settings: { notifyOnTimerEnd: !cur } });
  toast(`Notifications: ${!cur ? "On" : "Off"}`);
  await loadAll();
});

$("#toggleOpenFull").addEventListener("click", async () => {
  const cur = !!DATA.settings?.openFullOnClick;
  await api({ type: "SR_SET_SETTINGS", settings: { openFullOnClick: !cur } });
  toast(`Open full app: ${!cur ? "On" : "Off"}`);
  await loadAll();
});

$("#clearAllBtn").addEventListener("click", async () => {
  if (!confirm("Clear ALL local data?")) return;
  await api({ type: "SR_CLEAR_ALL" });
  toast("Cleared");
  await loadAll();
});

// ---------- Load / Render ----------
async function loadAll() {
  const res = await api({ type: "SR_GET_DATA" });
  if (!res?.ok) return;

  DATA.sessions = res.sessions || [];
  DATA.tasks = res.tasks || [];
  DATA.tags = res.tags || [];
  DATA.timer = res.timer || {};
  DATA.settings = res.settings || {};
  DATA.streak = res.streak || 0;

  seedDefaultsIfEmpty();
  await saveTags(); // persist defaults if they were missing

  // restore active selection from latest session meta if empty
  if (!UI.activeTaskId) {
    // prefer last session’s meta
    const last = DATA.sessions?.[0];
    if (last?.meta?.activeTaskId) UI.activeTaskId = last.meta.activeTaskId;
    if (last?.meta?.activeTagId) UI.activeTagId = last.meta.activeTagId;
  }

  // If activeTaskId exists, sync activeTag from task
  const task = DATA.tasks.find(t => t.id === UI.activeTaskId);
  if (task?.tagId) UI.activeTagId = task.tagId;

  // nav + kpis + views
  await refreshStatusText();
  updateMiniKpis();

  // render each view
  renderTags();
  renderTasks();
  renderActiveSelection();
  updateActiveChips();

  renderStats();
  renderAchievements();

  // timer mode sync (if running, reflect running mode)
  if (DATA.timer?.running && DATA.timer?.mode) setTimerMode(DATA.timer.mode);
  updateTimerUI();
}

loadAll().catch(() => {});
