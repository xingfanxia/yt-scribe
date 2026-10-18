// Service worker: page-world helpers for the content script, side panel toggling,
// keyboard commands, and tab opening.
const CONTENT_FILES = [
  "src/shared/core.js",
  "src/shared/dom.js",
  "src/shared/store.js",
  "src/content/extract.js",
  "src/content/extract-bilibili.js",
  "src/content/content.js",
];

// windowId -> Port of an open side panel in that window
const panels = new Map();

chrome.runtime.onConnect.addListener((port) => {
  const m = port.name.match(/^sidepanel:(\d+)$/);
  if (!m) return;
  const windowId = Number(m[1]);
  panels.set(windowId, port);
  port.onDisconnect.addListener(() => {
    if (panels.get(windowId) === port) panels.delete(windowId);
  });
});

// Must run synchronously inside the user-gesture turn, so no awaits before open().
function togglePanel(windowId) {
  const port = panels.get(windowId);
  if (port) {
    port.postMessage({ type: "close" });
    return;
  }
  chrome.sidePanel.open({ windowId }).catch(() => {});
}

// MAIN world: the live player response (follows SPA navigation) and ytcfg values.
function readPageContext(videoId) {
  const players = [...document.querySelectorAll("#movie_player, #shorts-player, .html5-video-player")];
  let player = null;
  for (const el of players) {
    try {
      const pr = el.getPlayerResponse && el.getPlayerResponse();
      if (pr && pr.videoDetails && pr.videoDetails.videoId === videoId) {
        player = pr;
        break;
      }
    } catch (_) {}
  }
  const initial = window.ytInitialPlayerResponse;
  if (!player && initial && initial.videoDetails && initial.videoDetails.videoId === videoId) player = initial;
  const cfg = (window.ytcfg && window.ytcfg.data_) || {};
  return {
    player: player && {
      videoDetails: player.videoDetails,
      captions: player.captions,
      playabilityStatus: player.playabilityStatus,
    },
    cfg: {
      apiKey: cfg.INNERTUBE_API_KEY || "",
      clientVersion: cfg.INNERTUBE_CLIENT_VERSION || "",
      visitorData: cfg.VISITOR_DATA || "",
      hl: cfg.HL || "en",
    },
  };
}

// MAIN world: YouTube's player attaches a PoToken (`pot`) to caption requests it makes itself.
// Toggling captions makes the player issue one, which we read back from resource timings.
async function capturePoToken(videoId) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findPot = () => {
    const entries = performance.getEntriesByType("resource");
    for (let i = entries.length - 1; i >= 0; i--) {
      const name = entries[i].name;
      if (!name.includes("/api/timedtext")) continue;
      try {
        const u = new URL(name);
        if (u.searchParams.get("v") === videoId && u.searchParams.get("pot")) return u.searchParams.get("pot");
      } catch (_) {}
    }
    return "";
  };
  let pot = findPot();
  if (pot) return pot;
  const button = document.querySelector(
    "ytd-reel-video-renderer[is-active] .ytp-subtitles-button, #movie_player .ytp-subtitles-button, .ytp-subtitles-button",
  );
  if (!button) return "";
  const wasOn = button.getAttribute("aria-pressed") === "true";
  button.click();
  if (wasOn) {
    await sleep(150);
    button.click();
  }
  for (let i = 0; i < 30 && !pot; i++) {
    await sleep(80);
    pot = findPot();
  }
  if (!wasOn && button.getAttribute("aria-pressed") === "true") button.click();
  return pot;
}

async function runInPage(tabId, func, args) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args });
  return result ? result.result : null;
}

async function ensureContent(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "yts:ping" });
    if (res && res.ok) return;
  } catch (_) {
    /* not injected yet (tab opened before install/update) */
  }
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content/content.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab && sender.tab.id;
  switch (msg && msg.type) {
    case "yts:pageContext":
      runInPage(tabId, readPageContext, [msg.videoId])
        .then((context) => reply({ ok: true, context }))
        .catch((e) => reply({ ok: false, error: e.message }));
      return true;
    case "yts:poToken":
      runInPage(tabId, capturePoToken, [msg.videoId])
        .then((pot) => reply({ pot: pot || "" }))
        .catch(() => reply({ pot: "" }));
      return true;
    case "yts:togglePanel":
      if (sender.tab) togglePanel(sender.tab.windowId);
      reply({ ok: true });
      return false;
    case "yts:openTab":
      if (/^https?:\/\//i.test(msg.url)) chrome.tabs.create({ url: msg.url });
      reply({ ok: true });
      return false;
    case "yts:ensureContent":
      ensureContent(msg.tabId)
        .then(() => reply({ ok: true }))
        .catch((e) => reply({ ok: false, error: e.message }));
      return true;
    default:
      return false;
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-chat" && tab) {
    togglePanel(tab.windowId);
    return;
  }
  if (command === "copy-transcript" && tab && tab.id) {
    ensureContent(tab.id)
      .then(() => chrome.tabs.sendMessage(tab.id, { type: "yts:copy" }))
      .catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});
