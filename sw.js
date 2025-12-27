// StudiioWrapped — MV3 Service Worker
// - session tracking (time/tab switches)
// - scroll signals via content script messages
// - timer end via chrome.alarms (MV3 safe)
// - streak + achievements derived from sessions/timer completions

const K = {
  STATE: "sr_state",
  SESSIONS: "sr_sessions",
  TASKS: "sr_tasks",
  TAGS: "sr_tags",
  SETTINGS: "sr_settings",
  TIMER: "sr_timer"
};

const ALARM_TICK = "sr_tick_alarm";         // tracking tick
const ALARM_TIMER_END = "sr_timer_end";     // timer end notification
const TICK_MINUTES = 1;

const DEFAULT_STATE = {
  running: false,
  currentSessionId: null,
  sessionStartTime: null,
  activeTabId: null,
  activeUrl: null,
  activeTitle: null,
  lastActiveTs: null
};

const DEFAULT_SETTINGS = {
  theme: "dark", // "dark" | "light"
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  roundsPerSet: 4,
  openFullOnClick: true,
  notifyOnTimerEnd: true
};

const DEFAULT_TIMER = {
  running: false,
  mode: "focus", // "focus"|"short"|"long"
  startedAt: null,
  endsAt: null,
  activeTaskId: null,
  completedCount: 0 // focus rounds completed lifetime
};

function now() { return Date.now(); }
function newId() { return "sr_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16); }

function urlKey(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url || "unknown";
  }
}

function safeTitle(title) { return (title || "").slice(0, 200); }

async function get(key, fallback) {
  const obj = await chrome.storage.local.get(key);
  return obj[key] ?? fallback;
}

async function set(key, val) {
  await chrome.storage.local.set({ [key]: val });
}

async function ensureAlarmTick() {
  const alarms = await chrome.alarms.getAll();
  if (!alarms.some(a => a.name === ALARM_TICK)) {
    chrome.alarms.create(ALARM_TICK, { periodInMinutes: TICK_MINUTES });
  }
}

async function clearTimerAlarm() {
  await chrome.alarms.clear(ALARM_TIMER_END);
}

async function getActiveTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return null;
  return { tabId: tab.id, url: tab.url || "", title: tab.title || "" };
}

function initSessionRecord(id, startTime, meta = {}) {
  return {
    id,
    startTime,
    endTime: null,
    meta: {
      activeTaskId: meta.activeTaskId || null,
      activeTagId: meta.activeTagId || null
    },
    totals: { totalMs: 0, tabSwitches: 0 },
    visits: [],
    pages: {},
    switches: [],
    confusionSummary: []
  };
}

function ensurePage(session, url, title) {
  const key = urlKey(url);
  if (!session.pages[key]) {
    session.pages[key] = {
      url: key,
      title: safeTitle(title),
      totalDwellMs: 0,
      maxScrollY: 0,
      reversals: 0,
      thrash: 0,
      scrollSamples: 0
    };
  } else if (title && !session.pages[key].title) {
    session.pages[key].title = safeTitle(title);
  }
  return session.pages[key];
}

function startNewVisit(session, url, title, startTs) {
  session.visits.unshift({
    url: urlKey(url),
    title: safeTitle(title),
    start: startTs,
    end: null,
    dwellMs: 0
  });
}

function closeLastVisit(session, endTs) {
  const last = session.visits[0];
  if (!last || last.end != null) return;

  last.end = endTs;
  last.dwellMs = Math.max(0, last.end - last.start);

  const page = ensurePage(session, last.url, last.title);
  page.totalDwellMs += last.dwellMs;
  session.totals.totalMs += last.dwellMs;
}

async function getSessions() {
  return await get(K.SESSIONS, []);
}

async function saveSession(updated) {
  const sessions = await getSessions();
  const idx = sessions.findIndex(s => s.id === updated.id);
  if (idx >= 0) sessions[idx] = updated;
  else sessions.unshift(updated);

  // keep last 80
  const trimmed = sessions.slice(0, 80);
  await set(K.SESSIONS, trimmed);
}

async function loadSessionById(id) {
  const sessions = await getSessions();
  return sessions.find(s => s.id === id) || null;
}

function computeConfusionSummary(session) {
  const pages = Object.values(session.pages || {});
  if (!pages.length) return [];

  const tabSwitches = session.totals.tabSwitches || 0;
  const maxDwell = Math.max(1, ...pages.map(p => p.totalDwellMs || 0));
  const maxRev   = Math.max(1, ...pages.map(p => p.reversals || 0));
  const maxThr   = Math.max(1, ...pages.map(p => p.thrash || 0));
  const maxScr   = Math.max(1, ...pages.map(p => p.maxScrollY || 0));

  const summary = pages.map(p => {
    const dwellN = (p.totalDwellMs || 0) / maxDwell;
    const revN   = (p.reversals || 0) / maxRev;
    const thrN   = (p.thrash || 0) / maxThr;
    const scrN   = (p.maxScrollY || 0) / maxScr;

    let score = 0;
    const reasons = [];

    score += 44 * revN;     if ((p.reversals || 0) >= 3) reasons.push("rereading loops");
    score += 34 * thrN;     if ((p.thrash || 0) >= 3) reasons.push("scroll thrash");
    const stuck = dwellN > 0.5 && scrN < 0.25;
    if (stuck) { score += 24; reasons.push("stuck (time w/ low progress)"); }
    else score += 16 * dwellN;

    if (tabSwitches >= 10) { score += 10; reasons.push("high context switching"); }

    score = Math.max(0, Math.min(100, Math.round(score)));
    return { url: p.url, title: p.title || p.url, score, reasons };
  });

  summary.sort((a, b) => b.score - a.score);
  return summary;
}

async function updateActiveContextFromChrome(state, session) {
  const info = await getActiveTabInfo();
  if (!info) return;

  const url = info.url || "";
  if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return;

  const ts = now();
  if (state.lastActiveTs == null) state.lastActiveTs = ts;

  const tabChanged = state.activeTabId !== info.tabId;
  const urlChanged = state.activeUrl && urlKey(state.activeUrl) !== urlKey(url);

  if (tabChanged || urlChanged) {
    closeLastVisit(session, ts);

    if (state.activeUrl) {
      session.totals.tabSwitches += 1;
      session.switches.unshift({ time: ts, fromUrl: urlKey(state.activeUrl), toUrl: urlKey(url) });
    }

    startNewVisit(session, url, info.title, ts);

    state.activeTabId = info.tabId;
    state.activeUrl = url;
    state.activeTitle = info.title;
    state.lastActiveTs = ts;
  } else {
    state.activeTitle = info.title;
  }
}

// --------------------- Timer (MV3-safe) ---------------------

async function getSettings() {
  return await get(K.SETTINGS, structuredClone(DEFAULT_SETTINGS));
}

async function getTimer() {
  return await get(K.TIMER, structuredClone(DEFAULT_TIMER));
}

async function setTimer(t) {
  await set(K.TIMER, t);
}

async function notify(title, message) {
  const settings = await getSettings();
  if (!settings.notifyOnTimerEnd) return;

  await chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon.png",
    title,
    message
  });
}

function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function computeStreakDays() {
  // streak based on sessions OR completed focus rounds (both count as “study activity”)
  const sessions = await getSessions();
  const timer = await getTimer();

  const days = new Set();
  for (const s of sessions) days.add(startOfLocalDay(s.startTime || 0));

  // timer completions log lives in sessions meta via "focusRounds" events? keep simple:
  // We count days with any session; timer just helps user, not needed for streak.
  // If you want timer-only streak later, we’ll store a log.
  const dayList = [...days].sort((a, b) => b - a);
  if (!dayList.length) return 0;

  let streak = 1;
  for (let i = 0; i < dayList.length - 1; i++) {
    const diff = (dayList[i] - dayList[i + 1]) / (24 * 60 * 60 * 1000);
    if (diff === 1) streak++;
    else break;
  }
  return streak;
}

async function scheduleTimerEndAlarm(endsAt) {
  await clearTimerAlarm();
  chrome.alarms.create(ALARM_TIMER_END, { when: endsAt });
}

// --------------------- Install / Alarms ---------------------

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarmTick();
  const settings = await getSettings();
  await set(K.SETTINGS, settings);
  const timer = await getTimer();
  await setTimer(timer);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_TICK) {
    const state = await get(K.STATE, structuredClone(DEFAULT_STATE));
    if (!state.running || !state.currentSessionId) return;
    const session = await loadSessionById(state.currentSessionId);
    if (!session) return;
    await updateActiveContextFromChrome(state, session);
    await saveSession(session);
    await set(K.STATE, state);
    return;
  }

  if (alarm.name === ALARM_TIMER_END) {
    const timer = await getTimer();
    if (!timer.running) return;

    timer.running = false;
    const completedMode = timer.mode;
    timer.mode = timer.mode; // keep
    await setTimer(timer);

    if (completedMode === "focus") {
      timer.completedCount = (timer.completedCount || 0) + 1;
      await setTimer(timer);
      await notify("Focus complete", "Nice. Take a break or run it back.");
    } else {
      await notify("Break complete", "Back to focus when you’re ready.");
    }

    return;
  }
});

// Keep session tracking reactive
chrome.tabs.onActivated.addListener(async () => {
  const state = await get(K.STATE, structuredClone(DEFAULT_STATE));
  if (!state.running || !state.currentSessionId) return;
  const session = await loadSessionById(state.currentSessionId);
  if (!session) return;
  await updateActiveContextFromChrome(state, session);
  await saveSession(session);
  await set(K.STATE, state);
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.title) return;
  const state = await get(K.STATE, structuredClone(DEFAULT_STATE));
  if (!state.running || !state.currentSessionId) return;
  if (state.activeTabId != null && tab.id !== state.activeTabId) return;
  const session = await loadSessionById(state.currentSessionId);
  if (!session) return;
  await updateActiveContextFromChrome(state, session);
  await saveSession(session);
  await set(K.STATE, state);
});

// --------------------- Messages ---------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg.type !== "string") return;

    // Status
    if (msg.type === "SR_GET_STATUS") {
      const state = await get(K.STATE, structuredClone(DEFAULT_STATE));
      const timer = await getTimer();
      const settings = await getSettings();
      const streak = await computeStreakDays();
      sendResponse({ ok: true, state, timer, settings, streak });
      return;
    }

    // Settings
    if (msg.type === "SR_SET_SETTINGS") {
      const s = await getSettings();
      const next = { ...s, ...(msg.settings || {}) };
      await set(K.SETTINGS, next);
      sendResponse({ ok: true, settings: next });
      return;
    }

    // Session Start
    if (msg.type === "SR_START_SESSION") {
      const state = await get(K.STATE, structuredClone(DEFAULT_STATE));
      if (state.running) {
        sendResponse({ ok: true, alreadyRunning: true, sessionId: state.currentSessionId });
        return;
      }

      const id = newId();
      const startTime = now();
      const meta = msg.meta || {};
      const session = initSessionRecord(id, startTime, meta);

      const info = await getActiveTabInfo();
      if (info && info.url && !info.url.startsWith("chrome://") && !info.url.startsWith("chrome-extension://")) {
        startNewVisit(session, info.url, info.title, startTime);
        state.activeTabId = info.tabId;
        state.activeUrl = info.url;
        state.activeTitle = info.title;
        state.lastActiveTs = startTime;
      } else {
        state.activeTabId = null;
        state.activeUrl = null;
        state.activeTitle = null;
        state.lastActiveTs = startTime;
      }

      state.running = true;
      state.currentSessionId = id;
      state.sessionStartTime = startTime;

      await ensureAlarmTick();
      await saveSession(session);
      await set(K.STATE, state);

      sendResponse({ ok: true, sessionId: id });
      return;
    }

    // Session Stop
    if (msg.type === "SR_STOP_SESSION") {
      const state = await get(K.STATE, structuredClone(DEFAULT_STATE));
      if (!state.running || !state.currentSessionId) {
        sendResponse({ ok: true, notRunning: true });
        return;
      }

      const session = await loadSessionById(state.currentSessionId);
      if (!session) {
        state.running = false;
        state.currentSessionId = null;
        await set(K.STATE, state);
        sendResponse({ ok: false, error: "Session not found." });
        return;
      }

      const endTime = now();
      closeLastVisit(session, endTime);
      session.endTime = endTime;
      session.confusionSummary = computeConfusionSummary(session);

      state.running = false;
      state.currentSessionId = null;
      state.sessionStartTime = null;
      state.activeTabId = null;
      state.activeUrl = null;
      state.activeTitle = null;
      state.lastActiveTs = null;

      await saveSession(session);
      await set(K.STATE, state);

      sendResponse({ ok: true, sessionId: session.id });
      return;
    }

    // Scroll samples
    if (msg.type === "SR_SCROLL_SAMPLE") {
      const state = await get(K.STATE, structuredClone(DEFAULT_STATE));
      if (!state.running || !state.currentSessionId) {
        sendResponse({ ok: true, ignored: true });
        return;
      }

      const session = await loadSessionById(state.currentSessionId);
      if (!session) {
        sendResponse({ ok: false, error: "No active session." });
        return;
      }

      const url = msg.url || "";
      if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
        sendResponse({ ok: true, ignored: true });
        return;
      }

      const page = ensurePage(session, url, msg.title || "");
      page.maxScrollY = Math.max(page.maxScrollY, Number(msg.maxScrollY || 0));
      page.reversals += Number(msg.reversalsDelta || 0);
      page.thrash += Number(msg.thrashDelta || 0);
      page.scrollSamples += 1;

      await saveSession(session);
      sendResponse({ ok: true });
      return;
    }

    // Timer control
    if (msg.type === "SR_TIMER_START") {
      const settings = await getSettings();
      const timer = await getTimer();

      const mode = msg.mode || "focus";
      const minutes =
        mode === "focus" ? settings.focusMin :
        mode === "short" ? settings.shortMin :
        settings.longMin;

      const startsAt = now();
      const endsAt = startsAt + minutes * 60 * 1000;

      timer.running = true;
      timer.mode = mode;
      timer.startedAt = startsAt;
      timer.endsAt = endsAt;
      timer.activeTaskId = msg.activeTaskId ?? timer.activeTaskId ?? null;

      await setTimer(timer);
      await scheduleTimerEndAlarm(endsAt);

      sendResponse({ ok: true, timer });
      return;
    }

    if (msg.type === "SR_TIMER_STOP") {
      const timer = await getTimer();
      timer.running = false;
      timer.startedAt = null;
      timer.endsAt = null;
      await setTimer(timer);
      await clearTimerAlarm();
      sendResponse({ ok: true, timer });
      return;
    }

    // Data (tasks/tags/sessions)
    if (msg.type === "SR_GET_DATA") {
      const sessions = await getSessions();
      const tasks = await get(K.TASKS, []);
      const tags = await get(K.TAGS, []);
      const timer = await getTimer();
      const settings = await getSettings();
      const streak = await computeStreakDays();
      sendResponse({ ok: true, sessions, tasks, tags, timer, settings, streak });
      return;
    }

    if (msg.type === "SR_SAVE_TASKS") {
      const tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
      await set(K.TASKS, tasks);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "SR_SAVE_TAGS") {
      const tags = Array.isArray(msg.tags) ? msg.tags : [];
      await set(K.TAGS, tags);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "SR_CLEAR_ALL") {
      await chrome.storage.local.clear();
      await ensureAlarmTick();
      sendResponse({ ok: true });
      return;
    }
  })();

  return true;
});
