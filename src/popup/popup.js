(async function () {
  "use strict";
  const Y = globalThis.YTS;
  const $ = (id) => document.getElementById(id);
  Y.localize();

  const state = {
    tab: null,
    settings: await Y.store.getSettings(),
    presets: [],
    activePreset: "",
    data: null, // transcript payload from the content script
    lastAction: null,
    historyExpanded: false,
  };

  // ---------- status ----------
  let stepTimers = [];
  function status(text, tone, retry = false) {
    stepTimers.forEach(clearTimeout);
    stepTimers = [];
    $("status").hidden = !text;
    $("status").dataset.tone = tone || "";
    $("statusText").textContent = text || "";
    $("retryBtn").hidden = !retry;
  }
  function progress(keys) {
    status(Y.t(keys[0][1]), "busy");
    stepTimers = keys.slice(1).map(([ms, key]) => setTimeout(() => ($("statusText").textContent = Y.t(key)), ms));
  }

  // ---------- settings form ----------
  const formatBoxes = [...document.querySelectorAll("[data-format]")];

  function renderForm() {
    const s = state.settings;
    for (const box of formatBoxes) box.checked = Boolean(s.format[box.dataset.format]);
    $("promptText").value = s.promptText;
    $("promptBox").hidden = !s.format.prompt;
    $("exportBtn").hidden = !s.ui.exportButton;
    document.querySelector(".actions").classList.toggle("no-export", !s.ui.exportButton);
    if (!s.ui.exportButton) $("exportRow").hidden = true;
  }

  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => Y.store.saveSettings(state.settings), 250);
  }

  function onFormatChange(event) {
    const key = event.target.dataset.format;
    const f = state.settings.format;
    f[key] = event.target.checked;
    // Paragraph style is one block of text: it excludes timestamps and line spacing.
    if (key === "paragraph" && f.paragraph) f.timestamps = f.spacing = false;
    if ((key === "timestamps" || key === "spacing") && f[key]) f.paragraph = false;
    renderForm();
    afterSettingsEdit();
  }

  function afterSettingsEdit() {
    persist();
    renderPreview();
    syncPresetSelection();
  }

  // ---------- presets ----------
  function presetSnapshot() {
    return { format: { ...state.settings.format }, promptText: state.settings.promptText };
  }
  const sameSnapshot = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function renderPresets() {
    const select = $("presetSelect");
    select.replaceChildren(new Option(Y.t("currentSettings"), ""));
    for (const p of state.presets) select.add(new Option(p.name, p.id));
    select.value = state.activePreset;
    const list = $("presetList");
    list.replaceChildren();
    if (!state.presets.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = Y.t("noPresets");
      list.append(li);
    }
    for (const p of state.presets) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = p.name;
      const del = document.createElement("button");
      del.className = "btn small ghost";
      del.textContent = Y.t("delete");
      del.addEventListener("click", async () => {
        state.presets = state.presets.filter((x) => x.id !== p.id);
        if (state.activePreset === p.id) state.activePreset = "";
        await Y.store.savePresets(state.presets, state.activePreset);
        renderPresets();
      });
      li.append(name, del);
      list.append(li);
    }
  }

  function syncPresetSelection() {
    const active = state.presets.find((p) => p.id === state.activePreset);
    if (active && !sameSnapshot(active.settings, presetSnapshot())) {
      state.activePreset = "";
      Y.store.savePresets(state.presets, "");
      $("presetSelect").value = "";
    }
  }

  async function applyPreset(id) {
    state.activePreset = id;
    const preset = state.presets.find((p) => p.id === id);
    if (preset) {
      state.settings.format = { ...state.settings.format, ...preset.settings.format };
      state.settings.promptText = preset.settings.promptText;
      renderForm();
      persist();
      renderPreview();
      status(Y.t("presetApplied", [preset.name]), "ok");
    }
    await Y.store.savePresets(state.presets, state.activePreset);
  }

  // ---------- transcript ----------
  function onVideoPage() {
    return Boolean(state.tab && Y.videoRef(state.tab.url || ""));
  }

  async function ask(message) {
    const res = await chrome.runtime.sendMessage({ type: "yts:ensureContent", tabId: state.tab.id });
    if (!res || !res.ok) return { ok: false, code: "refresh" };
    try {
      return await chrome.tabs.sendMessage(state.tab.id, message);
    } catch {
      return { ok: false, code: "refresh" };
    }
  }

  async function loadTranscript() {
    state.data = null;
    $("copyBtn").disabled = $("exportBtn").disabled = true;
    progress([
      [0, "stepFinding"],
      [700, "stepCaptions"],
      [1800, "stepFetching"],
      [3600, "stepFallback"],
      [7000, "stepSlow"],
    ]);
    const res = await ask({ type: "yts:transcript", language: state.settings.language });
    if (!res || !res.ok) {
      status(Y.errorMessage(res?.code || "network"), "error", true);
      state.lastAction = loadTranscript;
      $("copyBtn").disabled = false;
      return false;
    }
    state.data = res.data;
    $("videoLine").textContent = res.data.title;
    $("copyBtn").disabled = $("exportBtn").disabled = false;
    status(Y.t("transcriptReady"), "ok");
    renderPreview();
    return true;
  }

  function formatted() {
    return Y.formatTranscript(state.data.segments, state.data, state.settings.format, state.settings.promptText);
  }

  function renderPreview() {
    const show = state.settings.ui.livePreview && state.data;
    $("previewSection").hidden = !show;
    if (!show) return;
    $("preview").value = formatted();
    const words = Y.countWords(state.data.segments).toLocaleString();
    const lang = state.data.track ? ` · ${state.data.track.name}` : "";
    $("previewMeta").textContent = `${Y.t("wordCount", [words])}${lang}`;
  }

  async function copy() {
    if (!state.data && !(await loadTranscript())) return;
    const text = formatted();
    try {
      await Y.copyText(text);
    } catch {
      status(Y.t("copyBlocked"), "error", true);
      state.lastAction = copy;
      return;
    }
    const words = Y.countWords(state.data.segments).toLocaleString();
    status(Y.t("copiedWords", [words]), "ok");
    if (state.settings.history) {
      await Y.store.recordTranscript(state.data, state.data.url);
      renderHistory();
    }
    const platform = state.settings.platform;
    if (platform.autoOpen) {
      const url = Y.platformUrl(platform, text);
      if (url) chrome.tabs.create({ url });
    }
  }

  async function exportAs(kind) {
    if (!state.data) return;
    const { segments } = state.data;
    const name = Y.sanitizeFilename(state.data.title);
    const s = state.settings;
    if (kind === "txt") Y.download(`${name}.txt`, formatted(), "text/plain;charset=utf-8");
    if (kind === "md") Y.download(`${name}.md`, Y.formatMarkdown(segments, state.data, s.format, s.promptText), "text/markdown;charset=utf-8");
    let done = "downloadStarted";
    if (kind === "pdf") {
      status(Y.t("pdfBuilding"), "busy");
      const job = { kind: "transcript", title: state.data.title, url: state.data.url, format: s.format, promptText: s.promptText, segments };
      try {
        done = (await Y.pdf.exportPdf(job, name)) === "print" ? "pdfFallback" : "downloadStarted";
      } catch {
        return status(Y.t("pdfFailed"), "error");
      }
    }
    status(Y.t(done), "ok");
    if (s.history) {
      await Y.store.recordTranscript(state.data, state.data.url);
      renderHistory();
    }
  }

  async function loadLanguages() {
    const select = $("languageSelect");
    select.replaceChildren(new Option(Y.t("languageAuto"), ""));
    const saved = state.settings.language;
    if (onVideoPage()) {
      const res = await ask({ type: "yts:tracks" });
      const seen = new Set();
      for (const t of res?.tracks || []) {
        if (seen.has(t.languageCode)) continue;
        seen.add(t.languageCode);
        select.add(new Option(t.auto ? `${t.name} (${Y.t("autoGenerated")})` : t.name, t.languageCode));
      }
    }
    if (saved && ![...select.options].some((o) => o.value === saved)) select.add(new Option(`${saved} (${Y.t("saved")})`, saved));
    select.value = saved;
  }

  // ---------- history ----------
  function timeAgo(ts) {
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return Y.t("justNow");
    if (min < 60) return Y.t("minutesAgo", [String(min)]);
    if (min < 1440) return Y.t("hoursAgo", [String(Math.round(min / 60))]);
    return new Date(ts).toLocaleDateString();
  }

  async function renderHistory() {
    const section = $("historySection");
    section.hidden = !state.settings.history;
    if (section.hidden) return;
    const all = await Y.store.getHistory();
    const query = $("historySearch").value.trim().toLowerCase();
    let items = state.historyExpanded ? all : all.slice(0, 1);
    if (state.historyExpanded && query) items = items.filter((h) => h.title.toLowerCase().includes(query));
    $("historyAll").hidden = !state.historyExpanded;
    $("toggleHistory").textContent = Y.t(state.historyExpanded ? "hide" : "viewAll");
    $("toggleHistory").hidden = all.length < 2 && !state.historyExpanded;
    const list = $("historyList");
    list.replaceChildren();
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "muted history-empty";
      li.textContent = Y.t(all.length ? "noMatches" : "historyEmpty");
      list.append(li);
      return;
    }
    for (const h of items) list.append(historyItem(h));
  }

  function historyItem(h) {
    const li = document.createElement("li");
    li.className = "history-item";
    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent = h.title || h.url;
    const meta = document.createElement("div");
    meta.className = "history-meta muted";
    const chatNote = h.chat?.length ? ` · ${Y.t("hasChat")}` : "";
    meta.textContent = `${timeAgo(h.savedAt)} · ${Y.t("wordCount", [h.words.toLocaleString()])}${chatNote}`;
    const actions = document.createElement("div");
    actions.className = "history-actions";
    const button = (key, onClick, cls = "") => {
      const b = document.createElement("button");
      b.className = `btn small ${cls}`;
      b.textContent = Y.t(key);
      b.addEventListener("click", onClick);
      actions.append(b);
    };
    button("copyAgain", async () => {
      const text = Y.formatTranscript(h.segments || [], h, state.settings.format, state.settings.promptText);
      await Y.copyText(text);
      status(Y.t("copiedWords", [h.words.toLocaleString()]), "ok");
    });
    button("openVideo", () => chrome.tabs.create({ url: h.url }));
    if (h.chat?.length) {
      button("openChat", async () => {
        await chrome.storage.session.set({ openChatFor: h.videoId });
        await chrome.sidePanel.open({ windowId: state.tab.windowId });
        window.close();
      });
    }
    button(
      "delete",
      async () => {
        await Y.store.removeHistory(h.id);
        renderHistory();
      },
      "ghost danger",
    );
    li.append(title, meta, actions);
    return li;
  }

  // ---------- wiring ----------
  formatBoxes.forEach((box) => box.addEventListener("change", onFormatChange));
  $("promptText").addEventListener("input", (e) => {
    state.settings.promptText = e.target.value;
    afterSettingsEdit();
  });
  $("resetPrompt").addEventListener("click", () => {
    state.settings.promptText = Y.t("defaultPrompt");
    $("promptText").value = state.settings.promptText;
    afterSettingsEdit();
  });
  $("languageSelect").addEventListener("change", async (e) => {
    state.settings.language = e.target.value;
    await Y.store.saveSettings(state.settings);
    if (onVideoPage()) loadTranscript();
  });
  $("copyBtn").addEventListener("click", copy);
  $("exportBtn").addEventListener("click", () => {
    const row = $("exportRow");
    row.hidden = !row.hidden;
    $("exportBtn").setAttribute("aria-expanded", String(!row.hidden));
  });
  document.querySelectorAll("[data-export]").forEach((b) => b.addEventListener("click", () => exportAs(b.dataset.export)));
  $("retryBtn").addEventListener("click", () => state.lastAction && state.lastAction());
  $("chatBtn").addEventListener("click", async () => {
    await chrome.sidePanel.open({ windowId: state.tab.windowId });
    window.close();
  });
  $("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

  // ---------- in-place settings ----------
  function renderSettings() {
    const s = state.settings;
    document.querySelectorAll("[data-ui]").forEach((box) => (box.checked = Boolean(s.ui[box.dataset.ui])));
    $("historyToggle").checked = s.history;
    $("autoOpen").checked = s.platform.autoOpen;
    $("platform").value = s.platform.id;
    $("customUrl").value = s.platform.customUrl;
    $("platformBox").hidden = !s.platform.autoOpen;
    $("customUrl").hidden = $("customUrlHint").hidden = s.platform.id !== "custom";
  }

  function settingsChanged() {
    renderSettings();
    renderForm();
    renderPreview();
    renderHistory();
    persist();
  }

  // The popup is only as tall as its content, so grow it while the dialog is open.
  function fitBodyTo(dialog) {
    document.body.style.minHeight = `${Math.min(dialog.scrollHeight + 32, 600)}px`;
  }

  $("openSettings").addEventListener("click", () => {
    renderSettings();
    const dialog = $("settingsDialog");
    dialog.showModal();
    fitBodyTo(dialog);
  });
  $("closeSettings").addEventListener("click", () => $("settingsDialog").close());
  $("settingsDialog").addEventListener("click", (e) => e.target === e.currentTarget && e.currentTarget.close());
  $("settingsDialog").addEventListener("close", () => (document.body.style.minHeight = ""));
  document.querySelectorAll("[data-ui]").forEach((box) =>
    box.addEventListener("change", () => {
      state.settings.ui[box.dataset.ui] = box.checked;
      settingsChanged();
    }),
  );
  $("historyToggle").addEventListener("change", (e) => {
    state.settings.history = e.target.checked;
    settingsChanged();
  });
  $("autoOpen").addEventListener("change", (e) => {
    state.settings.platform.autoOpen = e.target.checked;
    settingsChanged();
    fitBodyTo($("settingsDialog"));
  });
  $("platform").addEventListener("change", (e) => {
    state.settings.platform.id = e.target.value;
    settingsChanged();
    fitBodyTo($("settingsDialog"));
  });
  $("customUrl").addEventListener("change", (e) => {
    state.settings.platform.customUrl = e.target.value.trim();
    persist();
  });

  $("presetSelect").addEventListener("change", (e) => applyPreset(e.target.value));
  $("savePreset").addEventListener("click", () => {
    $("presetName").value = "";
    $("presetCount").textContent = "0 / 30";
    $("presetDialog").showModal();
  });
  $("presetName").addEventListener("input", (e) => {
    $("presetCount").textContent = `${e.target.value.length} / 30`;
  });
  $("presetDialog").addEventListener("close", async () => {
    if ($("presetDialog").returnValue !== "save") return;
    const name = Y.sanitizePresetName($("presetName").value);
    if (!name) return status(Y.t("presetNameInvalid"), "error");
    if (state.presets.some((p) => p.name.toLowerCase() === name.toLowerCase()))
      return status(Y.t("presetExists"), "error");
    const preset = { id: Y.newId("p"), name, settings: presetSnapshot(), createdAt: Date.now() };
    state.presets.push(preset);
    state.activePreset = preset.id;
    await Y.store.savePresets(state.presets, state.activePreset);
    renderPresets();
    status(Y.t("presetSaved", [name]), "ok");
  });
  $("managePresets").addEventListener("click", () => {
    renderPresets();
    $("manageDialog").showModal();
  });
  $("closeManage").addEventListener("click", () => $("manageDialog").close());

  $("toggleHistory").addEventListener("click", () => {
    state.historyExpanded = !state.historyExpanded;
    renderHistory();
  });
  let searchTimer = 0;
  $("historySearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderHistory, 200);
  });
  $("clearHistory").addEventListener("click", async () => {
    await Y.store.writeHistory([]);
    renderHistory();
  });

  // ---------- start ----------
  ({ presets: state.presets, activePreset: state.activePreset } = await Y.store.getPresets());
  renderForm();
  renderPresets();
  renderHistory();
  [state.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (onVideoPage()) {
    $("videoLine").textContent = Y.cleanTabTitle(state.tab.title);
    loadLanguages();
    loadTranscript();
  } else {
    $("copyBtn").disabled = true;
    $("chatBtn").disabled = false;
    loadLanguages();
  }
})();
