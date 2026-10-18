// chrome.storage wrappers shared by every extension surface.
// sync: settings, presets, custom command. local: history, AI credentials.
(function () {
  "use strict";
  const Y = globalThis.YTS;
  const HISTORY_LIMIT = 500;

  async function getSettings() {
    const { settings } = await chrome.storage.sync.get("settings");
    const merged = Y.mergeSettings(settings);
    if (!merged.promptText) merged.promptText = Y.t("defaultPrompt");
    return merged;
  }

  async function saveSettings(settings) {
    await chrome.storage.sync.set({ settings });
  }

  async function getAi() {
    const { ai } = await chrome.storage.local.get("ai");
    return { ...Y.DEFAULT_AI, ...(ai || {}) };
  }

  async function saveAi(ai) {
    await chrome.storage.local.set({ ai });
  }

  async function getPresets() {
    const { presets = [], activePreset = "" } = await chrome.storage.sync.get(["presets", "activePreset"]);
    return { presets, activePreset };
  }

  async function savePresets(presets, activePreset) {
    await chrome.storage.sync.set({ presets, activePreset: activePreset || "" });
  }

  async function getHistory() {
    const { history = [] } = await chrome.storage.local.get("history");
    return history;
  }

  async function writeHistory(history) {
    await chrome.storage.local.set({ history: history.slice(0, HISTORY_LIMIT) });
  }

  // One entry per video; a newer copy moves it to the top and keeps any saved chat.
  async function recordTranscript(data, url) {
    const history = await getHistory();
    const prev = history.find((h) => h.videoId === data.videoId);
    const entry = {
      id: prev?.id || Y.newId("h"),
      videoId: data.videoId,
      url,
      title: data.title || "",
      savedAt: Date.now(),
      words: Y.countWords(data.segments),
      language: data.track?.name || "",
      segments: data.segments,
      chat: prev?.chat || [],
      chatAt: prev?.chatAt || 0,
    };
    await writeHistory([entry, ...history.filter((h) => h.videoId !== data.videoId)]);
    return entry;
  }

  async function recordChat(video, chat) {
    const history = await getHistory();
    const prev = history.find((h) => h.videoId === video.videoId);
    const entry = {
      id: prev?.id || Y.newId("h"),
      videoId: video.videoId,
      url: video.url,
      title: video.title || prev?.title || "",
      savedAt: prev?.savedAt || Date.now(),
      words: prev?.words || Y.countWords(video.segments || []),
      language: prev?.language || "",
      segments: prev?.segments || video.segments || [],
      chat,
      chatAt: Date.now(),
    };
    await writeHistory([entry, ...history.filter((h) => h.videoId !== video.videoId)]);
  }

  async function removeHistory(id) {
    await writeHistory((await getHistory()).filter((h) => h.id !== id));
  }

  async function clearChats() {
    const history = await getHistory();
    await writeHistory(history.map((h) => ({ ...h, chat: [], chatAt: 0 })));
  }

  Y.store = {
    getSettings,
    saveSettings,
    getAi,
    saveAi,
    getPresets,
    savePresets,
    getHistory,
    writeHistory,
    recordTranscript,
    recordChat,
    removeHistory,
    clearChats,
  };
})();
