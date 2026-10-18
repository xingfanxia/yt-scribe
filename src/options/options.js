(async function () {
  "use strict";
  const Y = globalThis.YTS;
  const $ = (id) => document.getElementById(id);
  Y.localize();

  const MODELS = {
    anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
    openai: [],
  };

  let settings = await Y.store.getSettings();
  let savedTimer = 0;
  async function save() {
    await Y.store.saveSettings(settings);
    $("saved").hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($("saved").hidden = true), 1600);
  }

  // ---------- general ----------
  function renderGeneral() {
    document.querySelectorAll("[data-ui]").forEach((box) => (box.checked = Boolean(settings.ui[box.dataset.ui])));
    $("history").checked = settings.history;
    $("autoOpen").checked = settings.platform.autoOpen;
    $("platform").value = settings.platform.id;
    $("customUrl").value = settings.platform.customUrl;
    $("platformBox").hidden = !settings.platform.autoOpen;
    const custom = settings.platform.id === "custom";
    $("customUrl").hidden = $("customUrlLabel").hidden = $("customUrlHint").hidden = !custom;
  }

  document.querySelectorAll("[data-ui]").forEach((box) =>
    box.addEventListener("change", () => {
      settings.ui[box.dataset.ui] = box.checked;
      save();
    }),
  );
  $("history").addEventListener("change", (e) => {
    settings.history = e.target.checked;
    save();
  });
  $("clearHistory").addEventListener("click", async () => {
    await Y.store.writeHistory([]);
    $("clearHistory").textContent = Y.t("historyCleared");
  });
  $("autoOpen").addEventListener("change", (e) => {
    settings.platform.autoOpen = e.target.checked;
    renderGeneral();
    save();
  });
  $("platform").addEventListener("change", (e) => {
    settings.platform.id = e.target.value;
    renderGeneral();
    save();
  });
  $("customUrl").addEventListener("change", (e) => {
    settings.platform.customUrl = e.target.value.trim();
    save();
  });

  const commands = await chrome.commands.getAll();
  const keyFor = (name) => commands.find((c) => c.name === name)?.shortcut || Y.t("notSet");
  $("shortcutHint").textContent = Y.t("shortcutHint", [keyFor("copy-transcript"), keyFor("toggle-chat")]);
  $("shortcutsBtn").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

  // ---------- AI ----------
  let ai = await Y.store.getAi();

  function renderAi() {
    $("provider").value = ai.provider;
    $("apiKey").value = ai.apiKey;
    $("model").value = ai.model;
    $("baseUrl").value = ai.baseUrl;
    $("effort").value = ai.effort;
    updateAiFields();
  }

  function updateAiFields() {
    const anthropic = $("provider").value === "anthropic";
    $("effort").hidden = $("effortLabel").hidden = !anthropic;
    $("baseUrl").placeholder = anthropic ? "https://api.anthropic.com" : "https://your-gateway.example.com/v1";
    $("baseUrl").required = !anthropic;
    $("modelList").replaceChildren(...MODELS[$("provider").value].map((m) => new Option(m, m)));
  }

  function readAiForm() {
    return {
      provider: $("provider").value,
      apiKey: $("apiKey").value.trim(),
      model: $("model").value.trim() || Y.DEFAULT_AI.model,
      baseUrl: $("baseUrl").value.trim(),
      effort: $("effort").value,
    };
  }

  function aiStatus(text, tone = "") {
    $("aiStatus").textContent = text;
    $("aiStatus").dataset.tone = tone;
  }

  // Custom endpoints need a host permission; the request must run inside the click.
  async function grantHost(baseUrl) {
    if (!baseUrl) return true;
    let origin;
    try {
      origin = `${new URL(baseUrl).origin}/*`;
    } catch {
      return false;
    }
    if (origin === "https://api.anthropic.com/*") return true;
    return chrome.permissions.request({ origins: [origin] });
  }

  $("provider").addEventListener("change", () => {
    const anthropic = $("provider").value === "anthropic";
    if (anthropic && !MODELS.anthropic.includes($("model").value)) $("model").value = Y.DEFAULT_AI.model;
    if (!anthropic && MODELS.anthropic.includes($("model").value)) $("model").value = "";
    updateAiFields();
  });

  $("aiForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const next = readAiForm();
    if (!(await grantHost(next.baseUrl))) return aiStatus(Y.t("hostDenied"), "error");
    ai = next;
    await Y.store.saveAi(ai);
    aiStatus(Y.t("aiSaved"), "ok");
  });

  $("testAi").addEventListener("click", async () => {
    const candidate = readAiForm();
    if (!(await grantHost(candidate.baseUrl))) return aiStatus(Y.t("hostDenied"), "error");
    aiStatus(Y.t("testing"));
    let reply = "";
    try {
      await Y.ai.streamChat({
        ai: { ...candidate, effort: "low" },
        video: { title: "Connection test", url: "https://www.youtube.com/" },
        segments: [{ start: 0, text: "This is a connection test." }],
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        onText: (t) => (reply += t),
      });
      aiStatus(Y.t("testOk", [reply.trim().slice(0, 40) || "OK"]), "ok");
    } catch (err) {
      aiStatus(`${Y.t("testFailed")} ${err.message || ""}`.trim(), "error");
    }
  });

  renderGeneral();
  renderAi();
})();
