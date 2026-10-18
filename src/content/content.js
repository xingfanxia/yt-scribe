// Content-script entry: message API for the popup/side panel/background,
// plus the optional Copy and Chat buttons injected into the video's action bar (YouTube and Bilibili).
(function () {
  "use strict";
  if (globalThis.__ytsContentLoaded) return;
  globalThis.__ytsContentLoaded = true;

  const Y = globalThis.YTS;
  const { getTranscript, listTracks } = Y.extract;

  function publicTrack(track) {
    return track ? { languageCode: track.languageCode, name: track.name, auto: track.auto } : null;
  }

  function errorPayload(err) {
    const code = err && err.code ? err.code : "network";
    return { ok: false, code, detail: err?.detail || err?.message || "" };
  }

  function fetchTranscript(ref, language) {
    if (ref.site === "bilibili") return Y.extractBilibili.getTranscript(ref, language);
    return getTranscript(ref.id, language);
  }

  function fetchTracks(ref) {
    if (ref.site === "bilibili") return Y.extractBilibili.listTracks(ref);
    return listTracks(ref.id);
  }

  async function transcriptFor(language) {
    const ref = Y.videoRef(location.href);
    if (!ref) return { ok: false, code: "wrong_page" };
    try {
      const data = await fetchTranscript(ref, language);
      return {
        ok: true,
        data: {
          videoId: ref.key,
          site: ref.site,
          url: location.href,
          title: data.title || Y.cleanTabTitle(document.title),
          segments: data.segments,
          source: data.source,
          track: publicTrack(data.track),
        },
      };
    } catch (err) {
      return errorPayload(err);
    }
  }

  // Formats with saved settings, copies, records history, optionally opens an AI site.
  async function copyWithSettings() {
    const settings = await Y.store.getSettings();
    const res = await transcriptFor(settings.language);
    if (!res.ok) return res;
    const { data } = res;
    const text = Y.formatTranscript(data.segments, data, settings.format, settings.promptText);
    await Y.copyText(text);
    if (settings.history) await Y.store.recordTranscript(data, data.url);
    let opened = "";
    if (settings.platform.autoOpen) {
      const url = Y.platformUrl(settings.platform, text);
      if (url) {
        await chrome.runtime.sendMessage({ type: "yts:openTab", url });
        opened = settings.platform.id === "custom" ? "AI" : Y.PLATFORMS[settings.platform.id]?.name || "AI";
      }
    }
    return { ok: true, words: Y.countWords(data.segments), language: data.track?.name || "", opened };
  }

  function copiedLabel(res) {
    const words = res.words.toLocaleString();
    return res.opened ? Y.t("copiedWordsOpened", [words, res.opened]) : Y.t("copiedWords", [words]);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg && msg.type) {
      case "yts:transcript":
        transcriptFor(msg.language || "").then(reply);
        return true;
      case "yts:tracks": {
        const ref = Y.videoRef(location.href);
        if (!ref) {
          reply({ ok: false, code: "wrong_page" });
          return false;
        }
        fetchTracks(ref)
          .then((tracks) => reply({ ok: true, tracks: tracks.map(publicTrack) }))
          .catch((err) => reply(errorPayload(err)));
        return true;
      }
      case "yts:copy":
        copyWithSettings()
          .then((res) => {
            toast(res.ok ? copiedLabel(res) : Y.errorMessage(res.code), res.ok ? "ok" : "error");
            reply(res);
          })
          .catch((err) => {
            toast(Y.errorMessage(err.code || "clipboard"), "error");
            reply(errorPayload(err));
          });
        return true;
      case "yts:seek": {
        const video = document.querySelector("video");
        if (video && Number.isFinite(msg.seconds)) {
          video.currentTime = msg.seconds;
          video.play().catch(() => {});
        }
        reply({ ok: Boolean(video) });
        return false;
      }
      case "yts:ping":
        reply({ ok: true, videoId: Y.videoRef(location.href)?.key || "" });
        return false;
      default:
        return false;
    }
  });

  // ---------- toast ----------
  let toastTimer = 0;
  function toast(text, tone) {
    let el = document.getElementById("yts-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "yts-toast";
      el.setAttribute("role", "status");
      document.documentElement.append(el);
    }
    el.textContent = text;
    el.dataset.tone = tone;
    el.dataset.show = "true";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.dataset.show = "false"), 3500);
  }

  // ---------- in-page buttons ----------
  // [selector, where to place our buttons]
  const ACTION_BARS = [
    ["ytd-watch-metadata #top-level-buttons-computed", "start"],
    ["#above-the-fold #top-level-buttons-computed", "start"],
    ["ytd-reel-video-renderer[is-active] #actions", "start"],
    ["ytd-shorts reel-action-bar-view-model", "start"],
    [".video-toolbar-left-main", "end"],
    [".video-toolbar-left", "end"],
    ["[class*='toolbar'] [class*='toolbar-left']", "end"],
  ];
  const ICON_COPY =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
  const ICON_CHAT =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/></svg>';

  let ui = { pageCopyButton: false, pageChatButton: false };

  function actionBar() {
    for (const [sel, place] of ACTION_BARS) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return { el, place };
    }
    return null;
  }

  function makeButton(id, icon, label, onClick) {
    const wrap = document.createElement("div");
    wrap.id = id;
    wrap.className = `yts-page-btn yts-${location.hostname.includes("bilibili") ? "bilibili" : "youtube"}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = icon;
    const span = document.createElement("span");
    span.textContent = label;
    span.setAttribute("aria-live", "polite");
    btn.append(span);
    btn.addEventListener("click", onClick);
    wrap.append(btn);
    return wrap;
  }

  let copyBusy = false;
  async function onPageCopy(event) {
    if (copyBusy) return;
    copyBusy = true;
    const wrap = event.currentTarget.parentElement;
    const label = wrap.querySelector("span");
    const steps = [
      [0, "stepFinding"],
      [800, "stepFetching"],
      [3000, "stepFallback"],
    ].map(([ms, key]) => setTimeout(() => (label.textContent = Y.t(key)), ms));
    wrap.dataset.state = "busy";
    let res;
    try {
      res = await copyWithSettings();
    } catch (err) {
      res = errorPayload(err);
    }
    steps.forEach(clearTimeout);
    wrap.dataset.state = res.ok ? "ok" : "error";
    label.textContent = res.ok ? copiedLabel(res) : Y.t(res.code === "clipboard" ? "copyBlocked" : "copyFailed");
    if (!res.ok) toast(Y.errorMessage(res.code), "error");
    setTimeout(() => {
      label.textContent = Y.t("copyTranscript");
      delete wrap.dataset.state;
    }, 3000);
    copyBusy = false;
  }

  function onPageChat() {
    chrome.runtime.sendMessage({ type: "yts:togglePanel" }).catch(() => {});
  }

  function syncButtons() {
    const onVideo = Boolean(Y.videoRef(location.href));
    const found = onVideo ? actionBar() : null;
    const bar = found && found.el;
    const wanted = [
      ["yts-copy-btn", ui.pageCopyButton, ICON_COPY, "copyTranscript", onPageCopy],
      ["yts-chat-btn", ui.pageChatButton, ICON_CHAT, "chatButton", onPageChat],
    ];
    let anchor = null;
    for (const [id, enabled, icon, key, handler] of wanted) {
      let el = document.getElementById(id);
      if (!enabled || !bar) {
        if (el) el.remove();
        continue;
      }
      if (!el || el.parentElement !== bar) {
        if (el) el.remove();
        el = makeButton(id, icon, Y.t(key), handler);
        if (anchor) anchor.after(el);
        else if (found.place === "end") bar.append(el);
        else bar.prepend(el);
      }
      anchor = el;
    }
  }

  let scheduled = false;
  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      syncButtons();
    }, 400);
  }

  async function initButtons() {
    ui = (await Y.store.getSettings()).ui;
    syncButtons();
    new MutationObserver(scheduleSync).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("yt-navigate-finish", scheduleSync);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.settings) {
        ui = Y.mergeSettings(changes.settings.newValue).ui;
        syncButtons();
      }
    });
  }

  initButtons().catch(() => {});
})();
