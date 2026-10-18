(async function () {
  "use strict";
  const Y = globalThis.YTS;
  const $ = (id) => document.getElementById(id);
  Y.localize();

  // Suggested actions: [labelKey, prompt]. Prompts are sent as the user's message.
  const GROUPS = {
    quick: [
      ["actSummarize", "Summarize this video. Open with a two-sentence overview, then group the main points by topic with timestamps."],
      ["actTakeaways", "List the most useful takeaways from this video as short bullets, each with the timestamp where it comes up."],
      ["actQuotes", "Pull out the most quotable lines verbatim, each with its timestamp and one line on why it matters."],
    ],
    study: [
      ["actFlashcards", "Make 10 flashcards from this video. Format each as **Q:** question / **A:** answer, and add the timestamp of the source."],
      ["actQuiz", "Quiz me on this video: ask 5 multiple-choice questions one at a time, wait for my answer, then explain using the transcript."],
      ["actEli5", "Explain the core idea of this video as if I were 10 years old, using one everyday analogy."],
    ],
    research: [
      ["actClaims", "List every factual claim the speaker makes, with timestamps. Mark which ones are supported by evidence in the video and which are asserted without support."],
      ["actCited", "Write a detailed summary where every sentence cites the [m:ss] timestamp it is based on."],
      ["actQuestions", "What questions does this video leave open or answer only partially? Explain each briefly."],
    ],
    create: [
      ["actThread", "Turn this video into a 6-post social thread. Hook first, one idea per post, end with a link-back line."],
      ["actBlog", "Draft a blog post outline from this video: title, intro angle, H2 sections with bullet points, and a closing takeaway."],
      ["actChapters", "Write chapter markers for this video: one per line as `m:ss Title`, starting at 0:00, 5 to 12 chapters."],
    ],
  };
  const TRANSLATE = [
    ["zh-CN", "Simplified Chinese"],
    ["zh-TW", "Traditional Chinese"],
    ["en", "English"],
    ["ja", "Japanese"],
    ["ko", "Korean"],
    ["es", "Spanish"],
    ["fr", "French"],
    ["de", "German"],
    ["pt", "Portuguese"],
  ];

  const currentWindow = await chrome.windows.getCurrent();
  const port = chrome.runtime.connect({ name: `sidepanel:${currentWindow.id}` });
  port.onMessage.addListener((msg) => msg.type === "close" && window.close());

  const state = {
    video: null, // {videoId, url, title, segments}
    messages: [], // [{role, content}]
    busy: false,
    abort: null,
    ai: await Y.store.getAi(),
    custom: null,
  };

  // ---------- rendering ----------
  function setChatControls() {
    const has = state.messages.length > 0;
    $("copyChatBtn").disabled = $("exportChatBtn").disabled = $("clearChatBtn").disabled = !has || state.busy;
    $("sendBtn").disabled = state.busy || !$("input").value.trim() || !state.video;
    $("sendBtn").hidden = state.busy;
    $("stopBtn").hidden = !state.busy;
    document.querySelectorAll(".chip").forEach((c) => (c.disabled = state.busy || !state.video));
  }

  function showEmpty(textKey, withKeyButton = false) {
    $("chat").replaceChildren($("emptyState"));
    $("emptyState").hidden = false;
    $("emptyText").textContent = Y.t(textKey);
    $("addKeyBtn").hidden = !withKeyButton;
  }

  function appendMessage(role, content) {
    $("emptyState").hidden = true;
    const el = document.createElement("div");
    el.className = `msg ${role === "user" ? "user" : "ai"}`;
    if (role === "user") el.textContent = content;
    else el.innerHTML = Y.markdown.render(content);
    $("chat").append(el);
    $("chat").scrollTop = $("chat").scrollHeight;
    return el;
  }

  function renderConversation() {
    if (!state.messages.length) {
      showEmpty(state.ai.apiKey ? "readyToChat" : "needApiKey", !state.ai.apiKey);
    } else {
      $("chat").replaceChildren($("emptyState"));
      $("emptyState").hidden = true;
      for (const m of state.messages) appendMessage(m.role, m.content);
    }
    setChatControls();
  }

  // ---------- video loading ----------
  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, windowId: currentWindow.id });
    return tab;
  }

  async function loadFromTab() {
    const tab = await activeTab();
    const videoId = tab && Y.videoRef(tab.url || "")?.key;
    if (!videoId) {
      state.video = null;
      state.messages = [];
      $("videoTitle").textContent = Y.t("noVideo");
      $("videoNote").textContent = "";
      showEmpty("openVideoToChat");
      setChatControls();
      return;
    }
    if (state.video && state.video.videoId === videoId) return;
    $("videoTitle").textContent = Y.cleanTabTitle(tab.title) || Y.t("loadingVideo");
    $("videoNote").textContent = Y.t("stepFetching");
    state.video = null;
    setChatControls();
    const ensured = await chrome.runtime.sendMessage({ type: "yts:ensureContent", tabId: tab.id });
    let res = { ok: false, code: "refresh" };
    if (ensured && ensured.ok) {
      const settings = await Y.store.getSettings();
      try {
        res = await chrome.tabs.sendMessage(tab.id, { type: "yts:transcript", language: settings.language });
      } catch {
        /* keep refresh error */
      }
    }
    if (!res || !res.ok) {
      $("videoNote").textContent = Y.errorMessage(res?.code || "network");
      state.messages = [];
      showEmpty("noTranscriptForChat");
      setChatControls();
      return;
    }
    await openVideo({ ...res.data });
  }

  async function openVideo(video, messages) {
    state.video = video;
    $("videoTitle").textContent = video.title || video.url;
    const words = Y.countWords(video.segments).toLocaleString();
    $("videoNote").textContent = Y.t("wordCount", [words]);
    if (messages) state.messages = messages;
    else {
      const prev = (await Y.store.getHistory()).find((h) => h.videoId === video.videoId);
      state.messages = prev?.chat || [];
    }
    renderConversation();
  }

  // ---------- chat ----------
  function friendlyError(err) {
    if (err.code === "no_key") return Y.t("needApiKey");
    if (err.status === 401 || err.status === 403) return Y.t("aiAuthError");
    if (err.status === 429) return Y.t("aiRateLimited");
    if (err.status >= 500) return Y.t("aiServerError");
    if (err.name === "TypeError") return Y.t("aiNetworkError");
    return `${Y.t("aiFailed")} ${err.message || ""}`.trim();
  }

  async function send(text) {
    const prompt = String(text || "").trim();
    if (!prompt || state.busy || !state.video) return;
    state.ai = await Y.store.getAi();
    $("input").value = "";
    autosize();
    collapseSuggestions(true);
    state.messages.push({ role: "user", content: prompt });
    appendMessage("user", prompt);
    const bubble = appendMessage("assistant", "");
    bubble.classList.add("streaming");
    state.busy = true;
    state.abort = new AbortController();
    setChatControls();

    let reply = "";
    let frame = 0;
    const paint = () => {
      frame = 0;
      bubble.innerHTML = Y.markdown.render(reply);
      const chat = $("chat");
      if (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120) chat.scrollTop = chat.scrollHeight;
    };
    try {
      const { stop } = await Y.ai.streamChat({
        ai: state.ai,
        video: state.video,
        segments: state.video.segments,
        messages: state.messages,
        signal: state.abort.signal,
        onText: (chunk) => {
          reply += chunk;
          if (!frame) frame = requestAnimationFrame(paint);
        },
      });
      cancelAnimationFrame(frame);
      paint();
      if (stop === "refusal") appendNote(bubble, Y.t("aiRefused"));
      if (stop === "max_tokens" || stop === "length") appendNote(bubble, Y.t("aiTruncated"));
      if (reply) state.messages.push({ role: "assistant", content: reply });
      else state.messages.pop();
    } catch (err) {
      cancelAnimationFrame(frame);
      if (err.name === "AbortError") {
        paint();
        if (reply) state.messages.push({ role: "assistant", content: reply });
        else state.messages.pop();
      } else {
        state.messages.pop();
        bubble.classList.add("error");
        bubble.textContent = friendlyError(err);
        if (err.code === "no_key") $("addKeyBtn").hidden = false;
      }
    } finally {
      bubble.classList.remove("streaming");
      state.busy = false;
      state.abort = null;
      setChatControls();
    }
    if (state.messages.length) await Y.store.recordChat(state.video, state.messages);
  }

  function appendNote(bubble, text) {
    const note = document.createElement("p");
    note.className = "msg-note muted";
    note.textContent = text;
    bubble.append(note);
  }

  function chatMarkdown() {
    const lines = [`# ${state.video.title || "Video"}`, "", `<${state.video.url}>`, ""];
    for (const m of state.messages) {
      lines.push(`## ${m.role === "user" ? Y.t("you") : Y.t("assistant")}`, "", m.content, "");
    }
    return lines.join("\n");
  }

  // ---------- suggestions ----------
  function chip(label, prompt) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = label;
    b.addEventListener("click", () => send(prompt));
    return b;
  }

  function buildSuggestions() {
    for (const [group, items] of Object.entries(GROUPS)) {
      const box = document.querySelector(`[data-group="${group}"]`);
      const label = document.createElement("span");
      label.className = "group-label";
      label.textContent = Y.t(`group_${group}`);
      box.append(label, ...items.map(([key, prompt]) => chip(Y.t(key), prompt)));
    }
    const select = $("translateSelect");
    for (const [code, name] of TRANSLATE) select.add(new Option(Y.t(`lang_${code.replace("-", "_")}`), name));
    const uiLang = chrome.i18n.getUILanguage();
    select.value = uiLang.startsWith("zh") ? "Simplified Chinese" : "English";
  }

  function collapseSuggestions(collapse) {
    $("suggestBody").hidden = collapse;
    $("suggestToggle").setAttribute("aria-expanded", String(!collapse));
  }

  async function loadCustom() {
    const { customCommand } = await chrome.storage.sync.get("customCommand");
    state.custom = customCommand || null;
    $("customBtn").textContent = state.custom ? state.custom.label : `+ ${Y.t("customCommand")}`;
    $("editCustomBtn").hidden = !state.custom;
  }

  function editCustom() {
    $("commandLabel").value = state.custom?.label || "";
    $("commandPrompt").value = state.custom?.prompt || "";
    $("deleteCommand").hidden = !state.custom;
    $("commandDialog").showModal();
  }

  // ---------- history drawer ----------
  async function renderHistory() {
    const list = $("historyList");
    list.replaceChildren();
    const chats = (await Y.store.getHistory()).filter((h) => h.chat?.length);
    if (!chats.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = Y.t("noChats");
      list.append(li);
      return;
    }
    for (const h of chats) {
      const li = document.createElement("li");
      const open = document.createElement("button");
      open.className = "open";
      const title = document.createElement("strong");
      title.textContent = h.title || h.url;
      const meta = document.createElement("span");
      meta.className = "muted";
      meta.textContent = `${new Date(h.chatAt).toLocaleString()} · ${Y.t("messageCount", [String(h.chat.length)])}`;
      open.append(title, meta);
      open.addEventListener("click", () => {
        $("historyPanel").hidden = true;
        openVideo({ videoId: h.videoId, url: h.url, title: h.title, segments: h.segments || [] }, h.chat);
      });
      const del = document.createElement("button");
      del.className = "icon-btn";
      del.setAttribute("aria-label", Y.t("delete"));
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      del.addEventListener("click", async () => {
        const all = await Y.store.getHistory();
        await Y.store.writeHistory(all.map((x) => (x.id === h.id ? { ...x, chat: [], chatAt: 0 } : x)));
        if (state.video?.videoId === h.videoId) {
          state.messages = [];
          renderConversation();
        }
        renderHistory();
      });
      li.append(open, del);
      list.append(li);
    }
  }

  // ---------- wiring ----------
  function autosize() {
    const box = $("input");
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
  }
  $("input").addEventListener("input", () => {
    autosize();
    setChatControls();
  });
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send($("input").value);
    }
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    send($("input").value);
  });
  $("stopBtn").addEventListener("click", () => state.abort && state.abort.abort());

  $("chat").addEventListener("click", async (e) => {
    const ts = e.target.closest(".ts");
    if (!ts || !state.video) return;
    const seconds = Y.parseTimestamp(ts.dataset.ts);
    if (!Number.isFinite(seconds)) return;
    const tab = await activeTab();
    if (tab && Y.videoRef(tab.url || "")?.key === state.video.videoId) {
      chrome.tabs.sendMessage(tab.id, { type: "yts:seek", seconds }).catch(() => {});
    } else {
      const site = Y.videoRef(state.video.url)?.site || "youtube";
      chrome.tabs.create({ url: Y.seekUrl(state.video.url, seconds, site) });
    }
  });

  $("copyChatBtn").addEventListener("click", async () => {
    await Y.copyText(chatMarkdown());
    $("copyChatBtn").title = Y.t("copied");
    setTimeout(() => ($("copyChatBtn").title = Y.t("copyChat")), 1500);
  });
  $("exportChatBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("exportMenu").hidden = !$("exportMenu").hidden;
  });
  document.addEventListener("click", () => ($("exportMenu").hidden = true));
  document.querySelectorAll("[data-chat-export]").forEach((b) =>
    b.addEventListener("click", () => {
      const name = `${Y.sanitizeFilename(state.video.title)} - chat`;
      if (b.dataset.chatExport === "md") Y.download(`${name}.md`, chatMarkdown(), "text/markdown;charset=utf-8");
      else
        Y.printToPdf({
          kind: "chat",
          title: state.video.title,
          url: state.video.url,
          messages: state.messages,
          labels: { user: Y.t("you"), assistant: Y.t("assistant") },
        });
    }),
  );
  $("clearChatBtn").addEventListener("click", async () => {
    state.messages = [];
    await Y.store.recordChat(state.video, []);
    collapseSuggestions(false);
    renderConversation();
  });
  $("settingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("addKeyBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("historyBtn").addEventListener("click", async () => {
    await renderHistory();
    $("historyPanel").hidden = false;
  });
  $("closeHistoryBtn").addEventListener("click", () => ($("historyPanel").hidden = true));
  $("clearChatsBtn").addEventListener("click", async () => {
    await Y.store.clearChats();
    state.messages = [];
    renderConversation();
    renderHistory();
  });
  $("suggestToggle").addEventListener("click", () => collapseSuggestions(!$("suggestBody").hidden));
  $("translateBtn").addEventListener("click", () =>
    send(
      `Translate the full transcript into ${$("translateSelect").value}. Keep every [m:ss] timestamp at the start of its line, and merge fragments into natural sentences.`,
    ),
  );
  $("customBtn").addEventListener("click", () => (state.custom ? send(state.custom.prompt) : editCustom()));
  $("editCustomBtn").addEventListener("click", editCustom);
  $("commandDialog").addEventListener("close", async () => {
    const action = $("commandDialog").returnValue;
    if (action === "save") {
      const label = $("commandLabel").value.trim();
      const prompt = $("commandPrompt").value.trim();
      if (label && prompt) await chrome.storage.sync.set({ customCommand: { label, prompt } });
    } else if (action === "delete") {
      await chrome.storage.sync.remove("customCommand");
    }
    loadCustom();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("historyPanel").hidden) $("historyPanel").hidden = true;
  });

  chrome.tabs.onActivated.addListener((info) => info.windowId === currentWindow.id && loadFromTab());
  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if (tab.active && tab.windowId === currentWindow.id && change.url) loadFromTab();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.ai) {
      state.ai = { ...Y.DEFAULT_AI, ...(changes.ai.newValue || {}) };
      if (!state.messages.length && state.video) renderConversation();
    }
  });

  // ---------- start ----------
  buildSuggestions();
  await loadCustom();
  const { openChatFor } = await chrome.storage.session.get("openChatFor");
  if (openChatFor) {
    await chrome.storage.session.remove("openChatFor");
    const h = (await Y.store.getHistory()).find((x) => x.videoId === openChatFor);
    if (h) {
      openVideo({ videoId: h.videoId, url: h.url, title: h.title, segments: h.segments || [] }, h.chat);
      return;
    }
  }
  loadFromTab();
})();
