// End-to-end smoke test against live YouTube with the unpacked extension loaded.
// Usage: npm run e2e [-- <youtube-url>]
//   ANTHROPIC_API_KEY set => also exercises AI chat
//   BILI_COOKIES=<playwright cookie JSON for .bilibili.com> => also runs the signed-in Bilibili flow
//   (Bilibili serves subtitles only to signed-in users; without cookies only the signed-out path is checked)
// Writes screenshots to scratch/media/e2e/. Requires a Chromium build that allows --load-extension.
import { chromium } from "playwright";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const shots = join(root, "scratch/media/e2e");
mkdirSync(shots, { recursive: true });
const videoUrl = process.argv[2] || "https://www.youtube.com/watch?v=aircAruvnKk";
const biliUrl = process.env.BILI_URL || "https://www.bilibili.com/video/BV1CsJ16HEsF/";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "yts-e2e-")), {
  // The default headless shell cannot load extensions; full Chromium in new-headless mode can.
  channel: "chromium",
  headless: true,
  locale: process.env.E2E_LOCALE || "en-US",
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  permissions: ["clipboard-read", "clipboard-write"],
});

try {
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const extId = new URL(sw.url()).host;
  check("extension loaded", Boolean(extId), extId);

  const yt = await context.newPage();
  await yt.goto(videoUrl, { waitUntil: "domcontentloaded" });
  await yt.waitForSelector("#movie_player", { timeout: 30000 });

  // In-page buttons
  const btn = await yt.waitForSelector("#yts-copy-btn button", { timeout: 30000 }).catch(() => null);
  check("in-page Copy button injected", Boolean(btn));
  check("in-page Ask AI button injected", Boolean(await yt.$("#yts-chat-btn button")));

  // Content-script transcript API
  const res = await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
    const r = await chrome.tabs.sendMessage(tab.id, { type: "yts:transcript", language: "" });
    return { tabId: tab.id, url, ok: r.ok, code: r.code, source: r.data?.source, n: r.data?.segments?.length, title: r.data?.title, track: r.data?.track, first: r.data?.segments?.slice(0, 3) };
  }, videoUrl);
  check("transcript fetched", res.ok && res.n > 0, `${res.n} segments via ${res.source}, track=${res.track?.name}, title=${res.title}`);
  if (res.first) console.log("  first lines:", JSON.stringify(res.first));
  const tabId = res.tabId;

  const tracks = await sw.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: "yts:tracks" }), tabId);
  check("caption tracks listed", tracks.ok && tracks.tracks.length > 0, tracks.tracks?.map((t) => t.languageCode).join(","));

  // Specific language choice
  const zh = await sw.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: "yts:transcript", language: "zh-Hans" }), tabId);
  check("language preference honoured", zh.ok, `${zh.data?.track?.name} (${zh.data?.track?.languageCode}) ${zh.data?.segments?.length} segs`);

  // In-page copy button -> clipboard
  if (btn) {
    await btn.click();
    await yt.waitForSelector("#yts-copy-btn[data-state='ok'], #yts-copy-btn[data-state='error']", { timeout: 30000 });
    const state = await yt.getAttribute("#yts-copy-btn", "data-state");
    const clip = await yt.evaluate(() => navigator.clipboard.readText());
    check("in-page copy writes clipboard", state === "ok" && clip.length > 200, `state=${state}, ${clip.length} chars: ${clip.slice(0, 80).replace(/\n/g, "⏎")}`);
    await yt.screenshot({ path: join(shots, "youtube-page.png"), clip: { x: 0, y: 500, width: 1280, height: 300 } });
  }

  // Popup (opened as a page; tabs.query patched to point at the YouTube tab)
  const patchTabs = (id) => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => {
      if (q && q.active) return [await chrome.tabs.get(id)];
      return original(q);
    };
  };
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 760 });
  await popup.addInitScript(patchTabs, tabId);
  await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await popup.waitForFunction(() => document.getElementById("preview").value.length > 100, null, { timeout: 30000 }).catch(() => {});
  const preview = await popup.$eval("#preview", (el) => el.value);
  check("popup live preview", preview.length > 100, preview.slice(0, 90).replace(/\n/g, "⏎"));
  await popup.click("#formatPanel summary");
  await popup.screenshot({ path: join(shots, "popup.png"), fullPage: true });

  await popup.evaluate(() => navigator.clipboard.writeText(""));
  await popup.click("#copyBtn");
  await popup.waitForFunction(() => /\d/.test(document.getElementById("statusText").textContent), null, { timeout: 10000 }).catch(() => {});
  const popupClip = await popup.evaluate(() => navigator.clipboard.readText());
  check("popup copy", popupClip === preview, `${await popup.textContent("#statusText")}, clipboard matches preview: ${popupClip === preview}`);
  const hist = await popup.$$eval(".history-item", (els) => els.length);
  check("history recorded", hist > 0, `${hist} item(s) shown`);

  // Paragraph mode clears timestamps
  await popup.check("[data-format='paragraph']");
  const para = await popup.$eval("#preview", (el) => el.value);
  check("paragraph style", !/\(\d+:\d{2}\)/.test(para) && (await popup.isChecked("[data-format='timestamps']")) === false);
  await popup.check("[data-format='timestamps']");

  // Exports
  await popup.click("#exportBtn");
  const [mdDownload] = await Promise.all([popup.waitForEvent("download"), popup.click("[data-export='md']")]);
  const mdPath = join(shots, mdDownload.suggestedFilename());
  await mdDownload.saveAs(mdPath);
  check("markdown export", readFileSync(mdPath, "utf8").startsWith("# "), mdDownload.suggestedFilename());
  const [txtDownload] = await Promise.all([popup.waitForEvent("download"), popup.click("[data-export='txt']")]);
  check("text export", txtDownload.suggestedFilename().endsWith(".txt"), txtDownload.suggestedFilename());
  const [printPage] = await Promise.all([context.waitForEvent("page"), popup.click("[data-export='pdf']")]);
  await printPage.waitForSelector(".line", { timeout: 10000 }).catch(() => {});
  const lines = await printPage.$$eval(".line", (els) => els.length);
  check("PDF print view rendered", lines > 0, `${lines} lines`);
  await printPage.screenshot({ path: join(shots, "print.png") });
  await printPage.close();

  // Presets
  await popup.click("#savePreset");
  await popup.fill("#presetName", "Notes");
  await popup.click("#confirmPreset");
  await popup.waitForTimeout(300);
  check("preset saved", (await popup.$$eval("#presetSelect option", (o) => o.map((x) => x.textContent))).includes("Notes"));

  // Side panel (as a page)
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) await sw.evaluate(async (k) => chrome.storage.local.set({ ai: { provider: "anthropic", apiKey: k, model: "claude-opus-5-5", baseUrl: "", effort: "low" } }), key);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.addInitScript(patchTabs, tabId);
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`);
  await panel.waitForFunction(() => /\d/.test(document.getElementById("videoNote").textContent), null, { timeout: 30000 }).catch(() => {});
  check("side panel loaded transcript", /\d/.test(await panel.textContent("#videoNote")), await panel.textContent("#videoNote"));
  if (key) {
    await panel.click("[data-group='quick'] .chip");
    await panel.waitForSelector(".msg.ai:not(.streaming)", { timeout: 180000 });
    const answer = await panel.$eval(".msg.ai", (el) => el.textContent);
    const links = await panel.$$eval(".msg.ai .ts", (els) => els.length);
    check("AI chat streamed answer", answer.length > 100 && !(await panel.$(".msg.ai.error")), `${answer.length} chars, ${links} timestamp links`);
    if (links) {
      await panel.click(".msg.ai .ts");
      await yt.waitForTimeout(800);
      const t = await yt.evaluate(() => document.querySelector("video").currentTime);
      check("timestamp link seeks video", t > 0, `currentTime=${t.toFixed(1)}`);
    }
    const saved = await sw.evaluate(async () => (await chrome.storage.local.get("history")).history?.[0]?.chat?.length || 0);
    check("chat saved to history", saved >= 2, `${saved} messages`);
  } else {
    console.log("SKIP AI chat (no ANTHROPIC_API_KEY)");
  }
  await panel.screenshot({ path: join(shots, "sidepanel.png") });

  // Options page
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/src/options/options.html`);
  await options.screenshot({ path: join(shots, "options.png"), fullPage: true });
  check("options page renders", (await options.textContent("h1")).includes("YT Scribe"));
  // ---------- Bilibili ----------
  const bili = await context.newPage();
  await bili.goto(biliUrl, { waitUntil: "domcontentloaded" });
  await bili.waitForSelector("video", { timeout: 30000 }).catch(() => {});
  const biliCall = (msg) =>
    sw.evaluate(async (m) => {
      const [tab] = await chrome.tabs.query({ url: "https://www.bilibili.com/*" });
      return { tabId: tab.id, res: await chrome.tabs.sendMessage(tab.id, m) };
    }, msg);
  const signedOut = (await biliCall({ type: "yts:transcript", language: "" })).res;
  check("bilibili signed-out asks to sign in", !signedOut.ok && signedOut.code === "login_needed", `code=${signedOut.code}`);

  const cookieFile = process.env.BILI_COOKIES;
  if (cookieFile) {
    await context.addCookies(JSON.parse(readFileSync(cookieFile, "utf8")));
    await bili.reload({ waitUntil: "domcontentloaded" });
    await bili.waitForSelector("video", { timeout: 30000 });
    const biliBtn = await bili.waitForSelector("#yts-copy-btn button", { timeout: 30000 }).catch(() => null);
    check("bilibili in-page buttons injected", Boolean(biliBtn) && Boolean(await bili.$("#yts-chat-btn button")));
    const { tabId: biliTab, res: b } = await biliCall({ type: "yts:transcript", language: "" });
    check("bilibili transcript fetched", b.ok && b.data.segments.length > 0, b.ok ? `${b.data.segments.length} segments, track=${b.data.track?.name}, key=${b.data.videoId}, title=${b.data.title}` : `code=${b.code} ${b.detail}`);
    const bt = (await biliCall({ type: "yts:tracks" })).res;
    check("bilibili tracks listed", bt.ok && bt.tracks.length > 0, bt.tracks?.map((t) => `${t.languageCode}${t.auto ? "(ai)" : ""}`).join(","));
    const ben = (await biliCall({ type: "yts:transcript", language: "en" })).res;
    check("bilibili language preference honoured", ben.ok && ben.data.track?.languageCode === "en", `${ben.data?.track?.name} ${ben.data?.segments?.length} segs`);
    if (biliBtn) {
      await bili.evaluate(() => navigator.clipboard.writeText(""));
      await biliBtn.click();
      await bili.waitForSelector("#yts-copy-btn[data-state='ok'], #yts-copy-btn[data-state='error']", { timeout: 30000 });
      const clip = await bili.evaluate(() => navigator.clipboard.readText());
      check("bilibili in-page copy writes clipboard", (await bili.getAttribute("#yts-copy-btn", "data-state")) === "ok" && clip.length > 100, `${clip.length} chars`);
      const bar = await bili.$(".video-toolbar-container, .video-toolbar-left");
      if (bar) await bar.screenshot({ path: join(shots, "bilibili-toolbar.png") });
    }
    const bpop = await context.newPage();
    await bpop.setViewportSize({ width: 360, height: 760 });
    await bpop.addInitScript(patchTabs, biliTab);
    await bpop.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await bpop.waitForFunction(() => document.getElementById("preview").value.length > 50, null, { timeout: 30000 }).catch(() => {});
    check("bilibili popup preview", (await bpop.$eval("#preview", (el) => el.value)).length > 50);
    await bpop.screenshot({ path: join(shots, "popup-bilibili.png"), fullPage: true });
    if (key) {
      const bpanel = await context.newPage();
      await bpanel.setViewportSize({ width: 400, height: 900 });
      await bpanel.addInitScript(patchTabs, biliTab);
      await bpanel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`);
      await bpanel.waitForFunction(() => /\d/.test(document.getElementById("videoNote").textContent), null, { timeout: 30000 }).catch(() => {});
      await bpanel.fill("#input", "用三句话概括这个视频，并给出对应时间戳。");
      await bpanel.press("#input", "Enter");
      await bpanel.waitForSelector(".msg.ai:not(.streaming)", { timeout: 180000 });
      const links = await bpanel.$$eval(".msg.ai .ts", (els) => els.length);
      check("bilibili AI chat answered", !(await bpanel.$(".msg.ai.error")) && links > 0, `${links} timestamp links`);
      if (links) {
        await bpanel.click(".msg.ai .ts >> nth=-1");
        await bili.waitForTimeout(800);
        check("bilibili timestamp link seeks video", (await bili.evaluate(() => document.querySelector("video").currentTime)) > 0);
      }
      await bpanel.screenshot({ path: join(shots, "sidepanel-bilibili.png") });
    }
  } else {
    console.log("SKIP signed-in Bilibili flow (no BILI_COOKIES)");
  }
} finally {
  await context.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
