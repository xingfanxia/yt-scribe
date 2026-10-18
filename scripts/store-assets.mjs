// Generates Chrome Web Store images from the real extension running on live YouTube.
// Usage: ANTHROPIC_API_KEY=... node scripts/store-assets.mjs
//        REUSE_CAPTURES=1 node scripts/store-assets.mjs   # only re-compose from scratch/media/store
// Output: docs/store/screenshot-{1..4}.png (1280x800) and docs/store/promo-small.png (440x280).
// Optional: scratch/media/e2e/bilibili-toolbar.png (from `npm run e2e` with BILI_COOKIES) is
// shown next to the YouTube toolbar on screenshot 4.
import { chromium } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "docs/store");
const work = join(root, "scratch/media/store");
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
const videoUrl =
  process.argv[2] || "https://www.youtube.com/watch?v=aircAruvnKk";
const key = process.env.ANTHROPIC_API_KEY;
const reuse =
  Boolean(process.env.REUSE_CAPTURES) &&
  existsSync(join(work, "sidepanel.png"));
if (!key && !reuse)
  throw new Error("ANTHROPIC_API_KEY is required for the chat screenshot");

const dataUrl = (path) =>
  `data:image/png;base64,${readFileSync(path).toString("base64")}`;

const context = await chromium.launchPersistentContext(
  mkdtempSync(join(tmpdir(), "scribe-assets-")),
  {
    channel: "chromium",
    headless: true,
    colorScheme: "dark",
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    permissions: ["clipboard-read", "clipboard-write"],
  },
);

try {
  if (!reuse) await capture();

  async function capture() {
    const sw =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const extId = new URL(sw.url()).host;
    await sw.evaluate(
      async (k) =>
        chrome.storage.local.set({
          ai: {
            provider: "anthropic",
            apiKey: k,
            model: "claude-opus-5-5",
            baseUrl: "",
            effort: "low",
          },
        }),
      key,
    );

    const yt = await context.newPage();
    await yt.goto(videoUrl, { waitUntil: "domcontentloaded" });
    await yt.waitForSelector("#yts-copy-btn button", { timeout: 40000 });
    await yt.waitForTimeout(1500);
    await (
      await yt.$("ytd-watch-metadata #actions")
    ).screenshot({ path: join(work, "yt-toolbar.png") });
    const tabId = await sw.evaluate(
      async () =>
        (await chrome.tabs.query({ url: "https://www.youtube.com/*" }))[0].id,
    );

    const patchTabs = (id) => {
      const original = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (q) =>
        q && q.active ? [await chrome.tabs.get(id)] : original(q);
    };

    // Popup with preview and language picker
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 620 });
    await popup.addInitScript(patchTabs, tabId);
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await popup.waitForFunction(
      () => document.getElementById("preview").value.length > 100,
      null,
      { timeout: 40000 },
    );
    await popup.waitForFunction(
      () => document.querySelectorAll("#languageSelect option").length > 1,
      null,
      { timeout: 20000 },
    );
    await popup.screenshot({ path: join(work, "popup.png") });

    // Export row open + a rendered PDF page
    await popup.click("#exportBtn");
    await popup.screenshot({
      path: join(work, "popup-export.png"),
      clip: { x: 0, y: 0, width: 360, height: 300 },
    });
    const [pdf] = await Promise.all([
      popup.waitForEvent("download", { timeout: 60000 }),
      popup.click("[data-export='pdf']"),
    ]);
    const pdfPath = join(work, "transcript.pdf");
    await pdf.saveAs(pdfPath);
    execFileSync("pdftoppm", [
      "-png",
      "-r",
      "110",
      "-f",
      "1",
      "-l",
      "1",
      pdfPath,
      join(work, "pdf"),
    ]);

    // Side panel chat with timestamp links
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 400, height: 760 });
    await panel.addInitScript(patchTabs, tabId);
    await panel.goto(
      `chrome-extension://${extId}/src/sidepanel/sidepanel.html`,
    );
    await panel.waitForFunction(
      () => /\d/.test(document.getElementById("videoNote").textContent),
      null,
      { timeout: 40000 },
    );
    await panel.fill(
      "#input",
      "What are the key ideas? Keep it short, with timestamps.",
    );
    await panel.press("#input", "Enter");
    await panel.waitForSelector(".msg.ai:not(.streaming)", { timeout: 180000 });
    await panel.evaluate(() => (document.getElementById("chat").scrollTop = 0));
    await panel.screenshot({ path: join(work, "sidepanel.png") });
  }

  // Compose store frames
  const stage = await context.newPage();
  await stage.setViewportSize({ width: 1280, height: 800 });
  const icon = dataUrl(join(root, "icons/icon128.png"));
  const bili = join(root, "scratch/media/e2e/bilibili-toolbar.png");
  const frames = [
    {
      title: "Copy any transcript in one click",
      body: "Timestamps, title, link and spacing the way you want them. Pick the caption language right next to the preview.",
      images: [{ src: dataUrl(join(work, "popup.png")), width: 360 }],
    },
    {
      title: "Ask the video, jump to the moment",
      body: "Summaries, takeaways, flashcards, chapters or any question. Every [m:ss] in the answer seeks the player.",
      images: [{ src: dataUrl(join(work, "sidepanel.png")), width: 400 }],
    },
    {
      title: "Export to text, Markdown or PDF",
      body: "PDFs download directly with real, selectable text, including Chinese and Japanese.",
      images: [
        { src: dataUrl(join(work, "popup-export.png")), width: 320 },
        { src: dataUrl(join(work, "pdf-1.png")), width: 350, paper: true },
      ],
    },
    {
      title: "Right on YouTube and Bilibili",
      body: "Copy transcript and Ask AI buttons sit beside the video. Shortcuts: Cmd/Ctrl+Shift+Y to copy, Alt+Shift+A for chat.",
      images: [
        { src: dataUrl(join(work, "yt-toolbar.png")), width: 560 },
        ...(existsSync(bili) ? [{ src: dataUrl(bili), width: 640 }] : []),
      ],
      stack: true,
    },
  ];
  const css = `
    *{box-sizing:border-box} body{margin:0;width:1280px;height:800px;overflow:hidden;
      background:#121a2e;color:#e9edf7;font:16px/1.5 -apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;gap:56px;padding:0 72px}
    .text{flex:0 0 380px} .brand{display:flex;align-items:center;gap:10px;margin-bottom:40px;font-weight:700;font-size:20px}
    .brand img{width:36px;height:36px} h1{font-size:40px;line-height:1.15;margin:0 0 18px;letter-spacing:-.02em}
    p{color:#9aa6c4;font-size:19px;margin:0} .bar{width:56px;height:6px;border-radius:3px;background:#f5c84c;margin-bottom:22px}
    .shots{flex:1;min-width:0;display:flex;gap:24px;align-items:center;justify-content:center} .shots.stack{flex-direction:column}
    .shots img{display:block;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.45);border:1px solid #2e3c62}
    .shots img.paper{border-color:#d5dbe6}`;
  for (const [i, f] of frames.entries()) {
    const imgs = f.images
      .map(
        (im) =>
          `<img src="${im.src}" style="width:${im.width}px" class="${im.paper ? "paper" : ""}">`,
      )
      .join("");
    await stage.setContent(
      `<style>${css}</style><div class="text"><div class="brand"><img src="${icon}">Scribe</div><div class="bar"></div><h1>${f.title}</h1><p>${f.body}</p></div><div class="shots ${f.stack ? "stack" : ""}">${imgs}</div>`,
    );
    await stage.waitForTimeout(200);
    await stage.screenshot({
      path: join(out, `screenshot-${i + 1}.png`),
      scale: "css",
    });
  }

  const tile = await context.newPage();
  await tile.setViewportSize({ width: 440, height: 280 });
  await tile.setContent(`<style>
    *{box-sizing:border-box} body{margin:0;width:440px;height:280px;background:#121a2e;color:#e9edf7;font:16px -apple-system,"Segoe UI",sans-serif;
      display:flex;flex-direction:column;justify-content:center;padding:0 40px}
    .row{display:flex;align-items:center;gap:16px} img{width:72px;height:72px} h1{margin:0;font-size:46px;letter-spacing:-.02em}
    p{margin:18px 0 0;color:#9aa6c4;font-size:18px} .bar{width:44px;height:5px;border-radius:3px;background:#f5c84c;margin-top:16px}</style>
    <div class="row"><img src="${icon}"><h1>Scribe</h1></div><div class="bar"></div><p>Video transcripts &amp; AI chat for YouTube and Bilibili</p>`);
  await tile.waitForTimeout(200);
  await tile.screenshot({ path: join(out, "promo-small.png"), scale: "css" });
  console.log("wrote", out);
} finally {
  await context.close();
}
