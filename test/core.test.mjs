import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const Y = require("../src/shared/core.js");
const md = require("../src/shared/markdown.js");

test("videoIdFromUrl handles watch, shorts, live and rejects others", () => {
  assert.equal(Y.videoIdFromUrl("https://www.youtube.com/watch?v=abcDEF12345&t=3"), "abcDEF12345");
  assert.equal(Y.videoIdFromUrl("https://www.youtube.com/shorts/abcDEF12345"), "abcDEF12345");
  assert.equal(Y.videoIdFromUrl("https://www.youtube.com/live/abcDEF12345?si=x"), "abcDEF12345");
  assert.equal(Y.videoIdFromUrl("https://m.youtube.com/watch?v=abcDEF12345"), "abcDEF12345");
  assert.equal(Y.videoIdFromUrl("https://www.youtube.com/feed/subscriptions"), "");
  assert.equal(Y.videoIdFromUrl("https://notyoutube.com/watch?v=abcDEF12345"), "");
});

test("timestamps format and parse round-trip", () => {
  assert.equal(Y.formatTimestamp(0), "0:00");
  assert.equal(Y.formatTimestamp(65_400), "1:05");
  assert.equal(Y.formatTimestamp(3_725_000), "1:02:05");
  assert.equal(Y.parseTimestamp("1:02:05"), 3725);
  assert.equal(Y.parseTimestamp("4:05"), 245);
  assert.ok(Number.isNaN(Y.parseTimestamp("abc")));
});

test("segmentsFromJson3 joins segs, drops empty events, normalizes whitespace", () => {
  const segs = Y.segmentsFromJson3({
    events: [
      { tStartMs: 0, segs: [{ utf8: "hello" }, { utf8: " world\n" }] },
      { tStartMs: 500 },
      { tStartMs: 900, segs: [{ utf8: "\n" }] },
      { tStartMs: 1200, segs: [{ utf8: "next  line" }] },
    ],
  });
  assert.deepEqual(segs, [
    { start: 0, text: "hello world" },
    { start: 1200, text: "next line" },
  ]);
});

test("chooseTrack prefers saved language, then browser, then English, manual over auto", () => {
  const tracks = Y.normalizeTracks([
    { baseUrl: "a", languageCode: "en", kind: "asr", name: { simpleText: "English (auto)" } },
    { baseUrl: "b", languageCode: "en", name: { runs: [{ text: "English" }] } },
    { baseUrl: "c", languageCode: "zh-Hans", name: { simpleText: "Chinese" } },
    { baseUrl: "d", languageCode: "ja", vssId: "a.ja" },
  ]);
  assert.equal(Y.chooseTrack(tracks, "zh", []).baseUrl, "c");
  assert.equal(Y.chooseTrack(tracks, "", ["ja-JP"]).baseUrl, "d");
  assert.equal(Y.chooseTrack(tracks, "", ["fr"]).baseUrl, "b");
  assert.equal(tracks[3].auto, true);
  assert.equal(tracks[1].name, "English");
});

const segments = [
  { start: 0, text: "First line." },
  { start: 61_000, text: "Second line." },
];
const meta = { title: "My Video", url: "https://www.youtube.com/watch?v=x" };

test("formatTranscript honours each option", () => {
  assert.equal(
    Y.formatTranscript(segments, meta, { timestamps: true, title: true, url: true, spacing: false }, ""),
    "Title: My Video\nURL: https://www.youtube.com/watch?v=x\n\n(0:00) First line.\n(1:01) Second line.",
  );
  assert.equal(
    Y.formatTranscript(segments, meta, { timestamps: false, title: false, spacing: true }, ""),
    "First line.\n\nSecond line.",
  );
  assert.equal(
    Y.formatTranscript(segments, meta, { paragraph: true, title: false, prompt: true }, "Summarize:"),
    "Summarize:\n\nFirst line. Second line.",
  );
});

test("formatMarkdown renders heading, source and bold timestamps", () => {
  const out = Y.formatMarkdown(segments, meta, { timestamps: true, title: true, url: true, spacing: true }, "");
  assert.match(out, /^# My Video\n\nSource: <https:\/\/www\.youtube\.com\/watch\?v=x>\n\n---\n\n\*\*0:00\*\* First line\.\n\n\*\*1:01\*\* Second line\.\n$/);
});

test("countWords counts CJK characters and latin words", () => {
  assert.equal(Y.countWords([{ text: "Hello world, it's 2026" }]), 4);
  assert.equal(Y.countWords([{ text: "你好世界 AI" }]), 5);
});

test("sanitizeFilename strips reserved characters and empty names", () => {
  assert.equal(Y.sanitizeFilename('a/b:c*?"<>|'), "a_b_c______");
  assert.equal(Y.sanitizeFilename("..."), "transcript");
  assert.equal(Y.sanitizeFilename("CON"), "_CON");
  assert.equal(Y.sanitizeFilename("中文 标题. "), "中文 标题");
});

test("extractJsonAssignment parses balanced JSON with braces inside strings", () => {
  const html = '<script>var ytInitialPlayerResponse = {"a":{"b":"}{;"},"c":[1,2]};var other = 1;</script>';
  assert.deepEqual(Y.extractJsonAssignment(html, "ytInitialPlayerResponse"), { a: { b: "}{;" }, c: [1, 2] });
  assert.equal(Y.extractJsonAssignment("nothing here", "ytInitialData"), null);
});

test("platformUrl only accepts http(s) custom URLs and encodes the transcript", () => {
  assert.equal(Y.platformUrl({ id: "claude" }, "x"), "https://claude.ai/new");
  assert.equal(Y.platformUrl({ id: "custom", customUrl: "javascript:alert(1)" }, "x"), "");
  assert.equal(Y.platformUrl({ id: "custom", customUrl: "https://e.com/?q={transcript}" }, "a b"), "https://e.com/?q=a%20b");
});

test("markdown escapes HTML and links timestamps", () => {
  const html = md.render("# Title\n<img src=x onerror=alert(1)> **bold** at [1:05]\n\n- one\n- two [1:02:03]");
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes('<button type="button" class="ts" data-ts="1:05">1:05</button>'));
  assert.ok(html.includes('data-ts="1:02:03"'));
  assert.ok(html.includes("<ul><li>one</li>"));
  assert.ok(html.includes("<strong>bold</strong>"));
});

test("every i18n key referenced in source exists in both locales", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(name)) files.push(p);
    }
  };
  walk(new URL("../src", import.meta.url).pathname);
  const src = files.map((f) => readFileSync(f, "utf8")).join("\n") + readFileSync(new URL("../manifest.json", import.meta.url), "utf8");
  const keys = new Set();
  for (const m of src.matchAll(/Y\.t\("([A-Za-z_]+)"/g)) keys.add(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-[a-z]+)?="([A-Za-z_]+)"/g)) keys.add(m[1]);
  for (const m of src.matchAll(/__MSG_([A-Za-z_]+)__/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\["(act[A-Za-z]+|step[A-Za-z]+)"/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\[\d+, "(step[A-Za-z]+)"\]/g)) keys.add(m[1]);
  for (const code of ["wrong_page", "refresh", "network", "restricted", "live", "unavailable", "rate_limited", "no_captions", "no_captions_short", "clipboard", "login_needed"]) keys.add(`err_${code}`);
  for (const g of ["quick", "study", "research", "create"]) keys.add(`group_${g}`);
  for (const loc of ["en", "zh_CN"]) {
    const messages = JSON.parse(readFileSync(new URL(`../_locales/${loc}/messages.json`, import.meta.url), "utf8"));
    const missing = [...keys].filter((k) => !messages[k]);
    assert.deepEqual(missing, [], `${loc} missing keys`);
  }
});

test("videoRef recognises YouTube and Bilibili pages with stable keys", () => {
  assert.deepEqual(Y.videoRef("https://www.youtube.com/watch?v=abcDEF12345"), { site: "youtube", id: "abcDEF12345", key: "abcDEF12345" });
  const bv = Y.videoRef("https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=x");
  assert.equal(bv.site, "bilibili");
  assert.equal(bv.bvid, "BV1GJ411x7h7");
  assert.equal(bv.key, "BV1GJ411x7h7");
  assert.equal(Y.videoRef("https://www.bilibili.com/video/BV1GJ411x7h7?p=3").key, "BV1GJ411x7h7_p3");
  assert.equal(Y.videoRef("https://www.bilibili.com/video/av170001").aid, "170001");
  assert.equal(Y.videoRef("https://www.bilibili.com/list/watchlater?bvid=BV1GJ411x7h7").bvid, "BV1GJ411x7h7");
  assert.equal(Y.videoRef("https://www.bilibili.com/bangumi/play/ep12345").key, "ep12345");
  assert.equal(Y.videoRef("https://www.bilibili.com/"), null);
  assert.equal(Y.videoRef("https://space.bilibili.com/2"), null);
});

test("seekUrl and cleanTabTitle per site", () => {
  assert.equal(Y.seekUrl("https://www.youtube.com/watch?v=x", 65, "youtube"), "https://www.youtube.com/watch?v=x&t=65s");
  assert.equal(Y.seekUrl("https://www.bilibili.com/video/BV1GJ411x7h7?p=2", 65, "bilibili"), "https://www.bilibili.com/video/BV1GJ411x7h7?p=2&t=65");
  assert.equal(Y.cleanTabTitle("某视频_哔哩哔哩_bilibili"), "某视频");
  assert.equal(Y.cleanTabTitle("A talk - YouTube"), "A talk");
});

test("md5 matches node:crypto, including multi-block and non-ASCII input", () => {
  for (const s of ["", "abc", "中文 wbi", "x".repeat(200)]) {
    assert.equal(Y.md5(s), createHash("md5").update(s).digest("hex"));
  }
});

test("signWbi sorts params, strips reserved chars and appends w_rid", () => {
  const img = "7cd084941338484aae1ad9425b84077c";
  const sub = "4932caff0ff746eab6f01bf08b70ac45";
  const q = Y.signWbi({ foo: "one's", bar: "五一四", baz: 1919810 }, img, sub, 1702204169);
  assert.ok(q.startsWith("bar=%E4%BA%94%E4%B8%80%E5%9B%9B&baz=1919810&foo=ones&wts=1702204169&w_rid="));
  const raw = img + sub;
  const table = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];
  const mixin = table.map((i) => raw[i]).join("");
  const unsigned = q.split("&w_rid=")[0];
  assert.equal(q.split("&w_rid=")[1], createHash("md5").update(unsigned + mixin).digest("hex"));
});

test("Bilibili subtitle payload and track list normalise", () => {
  assert.deepEqual(Y.segmentsFromBilibili({ body: [{ from: 1.25, to: 3, content: " 你好  世界 " }, { from: 4, content: "" }] }), [{ start: 1250, text: "你好 世界" }]);
  const tracks = Y.normalizeBilibiliTracks([
    { lan: "ai-zh", lan_doc: "中文（自动生成）", subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/x.json", ai_type: 1 },
    { lan: "en-US", lan_doc: "English", subtitle_url: "http://i0.hdslb.com/bfs/subtitle/y.json" },
    { lan: "ja", lan_doc: "日本語", subtitle_url: "" },
  ]);
  assert.equal(tracks.length, 2);
  assert.deepEqual([tracks[0].languageCode, tracks[0].auto, tracks[0].baseUrl], ["zh", true, "https://aisubtitle.hdslb.com/bfs/ai_subtitle/x.json"]);
  assert.equal(tracks[1].baseUrl, "https://i0.hdslb.com/bfs/subtitle/y.json");
  assert.equal(Y.chooseTrack(tracks, "", ["zh-CN"]).languageCode, "zh");
});
