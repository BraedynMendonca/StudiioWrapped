function msToH(ms) {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h > 0) return `${h}h ${mm}m`;
  return `${m}m`;
}

async function openAppTab() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "SR_GET_DATA" });
  if (!res?.ok) return;

  const { sessions, streak } = res;
  const status = document.getElementById("miniStatus");
  const sRunning = (await chrome.runtime.sendMessage({ type: "SR_GET_STATUS" }))?.state?.running;

  status.textContent = sRunning ? "Session running" : "Ready";

  document.getElementById("miniStreak").textContent = `${streak || 0}d`;

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const week = (sessions || []).filter(s => (s.startTime || 0) >= cutoff);
  const weekMs = week.reduce((acc, s) => acc + (s.totals?.totalMs || 0), 0);
  document.getElementById("miniWeek").textContent = msToH(weekMs);
}

document.getElementById("openApp").addEventListener("click", openAppTab);

document.getElementById("startSession").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "SR_START_SESSION", meta: {} });
  await refresh();
});

document.getElementById("stopSession").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "SR_STOP_SESSION" });
  if (res?.ok && res.sessionId) {
    await chrome.tabs.create({ url: chrome.runtime.getURL("replay.html") + `?id=${encodeURIComponent(res.sessionId)}` });
  }
  await refresh();
});

document.getElementById("startFocus").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "SR_TIMER_START", mode: "focus" });
  await openAppTab();
});

document.getElementById("stopTimer").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "SR_TIMER_STOP" });
  await refresh();
});

document.getElementById("clearAll").addEventListener("click", async () => {
  if (!confirm("Clear ALL local StudiioWrapped data?")) return;
  await chrome.runtime.sendMessage({ type: "SR_CLEAR_ALL" });
  await refresh();
});

refresh().catch(() => {});
