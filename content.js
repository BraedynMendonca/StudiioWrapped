// StudiioWrapped — Content script: captures scroll behavior while a session is running.

let running = false;
let sampler = null;

let lastY = null;
let lastDir = 0;
let reversalsSinceSend = 0;
let thrashSinceSend = 0;

let lastSendTs = 0;
let maxScrollY = 0;

function getDocScrollY() {
  return Math.max(window.scrollY || 0, document.documentElement.scrollTop || 0);
}

function startSampling() {
  if (sampler) return;

  lastY = getDocScrollY();
  lastDir = 0;
  reversalsSinceSend = 0;
  thrashSinceSend = 0;
  lastSendTs = 0;
  maxScrollY = lastY;

  sampler = setInterval(() => {
    const y = getDocScrollY();
    maxScrollY = Math.max(maxScrollY, y);

    const dy = y - (lastY ?? y);

    let dir = 0;
    if (Math.abs(dy) > 8) dir = dy > 0 ? 1 : -1;

    if (dir !== 0 && lastDir !== 0 && dir !== lastDir) reversalsSinceSend += 1;
    if (dir !== 0 && lastDir !== 0 && dir !== lastDir && Math.abs(dy) > 200) thrashSinceSend += 1;

    if (dir !== 0) lastDir = dir;
    lastY = y;

    const t = Date.now();
    if (t - lastSendTs > 2000) {
      lastSendTs = t;

      const sendReversals = reversalsSinceSend;
      const sendThrash = thrashSinceSend;
      reversalsSinceSend = 0;
      thrashSinceSend = 0;

      chrome.runtime.sendMessage({
        type: "SR_SCROLL_SAMPLE",
        url: location.href,
        title: document.title || "",
        maxScrollY,
        reversalsDelta: sendReversals,
        thrashDelta: sendThrash
      });
    }
  }, 500);
}

function stopSampling() {
  if (sampler) clearInterval(sampler);
  sampler = null;
}

async function refreshRunningState() {
  const res = await chrome.runtime.sendMessage({ type: "SR_GET_STATUS" });
  running = !!(res && res.ok && res.state && res.state.running);
  if (running) startSampling();
  else stopSampling();
}

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== "local") return;
  refreshRunningState().catch(() => {});
});

refreshRunningState().catch(() => {});
