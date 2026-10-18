// Pure helpers shared by the content script, extension pages and Node tests.
// Classic script: attaches to globalThis.YTS (content scripts cannot be modules).
(function (root) {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    format: {
      timestamps: true,
      title: true,
      url: false,
      spacing: true,
      paragraph: false,
      prompt: false,
    },
    promptText: "",
    language: "",
    ui: {
      exportButton: true,
      livePreview: true,
      pageCopyButton: true,
      pageChatButton: true,
    },
    history: true,
    platform: { autoOpen: false, id: "claude", customUrl: "" },
  });

  const DEFAULT_AI = Object.freeze({
    provider: "anthropic",
    apiKey: "",
    model: "claude-opus-5-5",
    baseUrl: "",
    effort: "medium",
  });

  const PLATFORMS = Object.freeze({
    chatgpt: { name: "ChatGPT", url: "https://chatgpt.com/" },
    claude: { name: "Claude", url: "https://claude.ai/new" },
    gemini: { name: "Gemini", url: "https://gemini.google.com/app" },
    perplexity: { name: "Perplexity", url: "https://www.perplexity.ai/" },
  });

  function mergeSettings(stored) {
    const s = stored || {};
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      format: { ...DEFAULT_SETTINGS.format, ...(s.format || {}) },
      ui: { ...DEFAULT_SETTINGS.ui, ...(s.ui || {}) },
      platform: { ...DEFAULT_SETTINGS.platform, ...(s.platform || {}) },
    };
  }

  function videoIdFromUrl(href) {
    let u;
    try {
      u = new URL(href);
    } catch {
      return "";
    }
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return "";
    const m = u.pathname.match(/^\/(shorts|live)\/([\w-]{6,})/);
    if (m) return m[2];
    if (u.pathname === "/watch") return u.searchParams.get("v") || "";
    return "";
  }

  // Bilibili: /video/BV…|av… (?p=N), /list/…?bvid=BV…, /bangumi/play/ep…
  function bilibiliRef(u) {
    if (!/(^|\.)bilibili\.com$/.test(u.hostname)) return null;
    const p = Math.max(1, parseInt(u.searchParams.get("p") || "1", 10) || 1);
    const video = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i);
    const listBvid = u.pathname.startsWith("/list/") && u.searchParams.get("bvid");
    const id = video ? video[1] : listBvid;
    if (id) {
      const isBv = /^BV/i.test(id);
      const bvid = isBv ? `BV${id.slice(2)}` : "";
      const aid = isBv ? "" : id.slice(2);
      return { site: "bilibili", bvid, aid, p, key: `${bvid || `av${aid}`}${p > 1 ? `_p${p}` : ""}` };
    }
    const ep = u.pathname.match(/^\/bangumi\/play\/ep(\d+)/);
    if (ep) return { site: "bilibili", ep: ep[1], p: 1, key: `ep${ep[1]}` };
    return null;
  }

  // Identifies a supported video page. `key` is the stable per-video id used in history.
  function videoRef(href) {
    let u;
    try {
      u = new URL(href);
    } catch {
      return null;
    }
    const yt = videoIdFromUrl(href);
    if (yt) return { site: "youtube", id: yt, key: yt };
    return bilibiliRef(u);
  }

  // URL that opens the video at a given second.
  function seekUrl(href, seconds, site) {
    try {
      const u = new URL(href);
      u.searchParams.set("t", site === "youtube" ? `${seconds}s` : String(seconds));
      return u.toString();
    } catch {
      return href;
    }
  }

  function cleanTabTitle(title) {
    return String(title || "")
      .replace(/ - YouTube$/, "")
      .replace(/_哔哩哔哩_bilibili$/, "")
      .replace(/_bilibili$/, "")
      .trim();
  }

  // ---- Bilibili WBI request signing (md5 over sorted query + mixin key) ----
  const WBI_MIXIN = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
    12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
    57, 62, 11, 36, 20, 34, 44, 52,
  ];

  function wbiKeyFromUrl(url) {
    return String(url || "").split("/").pop().split(".")[0];
  }

  function signWbi(params, imgKey, subKey, nowSeconds) {
    const raw = imgKey + subKey;
    const mixin = WBI_MIXIN.map((i) => raw[i]).join("").slice(0, 32);
    const all = { ...params, wts: nowSeconds };
    const query = Object.keys(all)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ""))}`)
      .join("&");
    return `${query}&w_rid=${md5(query + mixin)}`;
  }

  function md5(input) {
    const bytes = new TextEncoder().encode(input);
    const words = new Uint32Array(((bytes.length + 8) >> 6) * 16 + 16);
    for (let i = 0; i < bytes.length; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
    words[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
    const bitLen = bytes.length * 8;
    words[words.length - 2] = bitLen >>> 0;
    words[words.length - 1] = Math.floor(bitLen / 0x100000000);
    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < words.length; off += 16) {
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        const round = i >> 4;
        let f, g;
        if (round === 0) (f = (b & c) | (~b & d)), (g = i);
        else if (round === 1) (f = (d & b) | (~d & c)), (g = (5 * i + 1) % 16);
        else if (round === 2) (f = b ^ c ^ d), (g = (3 * i + 5) % 16);
        else (f = c ^ (b | ~d)), (g = (7 * i) % 16);
        const s = S[round * 4 + (i % 4)];
        const sum = (a + f + K[i] + words[off + g]) >>> 0;
        a = d;
        d = c;
        c = b;
        b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
      }
      a0 = (a0 + a) >>> 0;
      b0 = (b0 + b) >>> 0;
      c0 = (c0 + c) >>> 0;
      d0 = (d0 + d) >>> 0;
    }
    return [a0, b0, c0, d0]
      .map((w) => Array.from({ length: 4 }, (_, i) => ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, "0")).join(""))
      .join("");
  }

  // Bilibili subtitle JSON ({body: [{from, to, content}]}) -> [{start, text}]
  function segmentsFromBilibili(payload) {
    return ((payload && payload.body) || [])
      .map((row) => ({ start: Math.round((Number(row.from) || 0) * 1000), text: cleanText(row.content) }))
      .filter((s) => s.text);
  }

  function normalizeBilibiliTracks(list) {
    return (list || [])
      .filter((t) => t && t.subtitle_url)
      .map((t, index) => {
        const lan = String(t.lan || "").toLowerCase();
        const url = String(t.subtitle_url);
        return {
          index,
          baseUrl: url.startsWith("//") ? `https:${url}` : url.replace(/^http:/, "https:"),
          languageCode: lan.replace(/^ai-/, ""),
          name: t.lan_doc || lan,
          auto: lan.startsWith("ai-") || Number(t.ai_type) > 0,
        };
      });
  }

  function isShortsUrl(href) {
    try {
      return new URL(href).pathname.startsWith("/shorts/");
    } catch {
      return false;
    }
  }

  function formatTimestamp(ms) {
    const total = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  // "1:02:03" | "2:03" -> seconds; NaN when malformed.
  function parseTimestamp(text) {
    const parts = String(text).trim().split(":").map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return NaN;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/[​‎‏]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // YouTube json3 caption payload -> [{start, text}]
  function segmentsFromJson3(payload) {
    const events = (payload && payload.events) || [];
    const out = [];
    for (const ev of events) {
      if (!ev.segs) continue;
      const text = cleanText(ev.segs.map((s) => s.utf8 || "").join(""));
      if (text) out.push({ start: ev.tStartMs || 0, text });
    }
    return out;
  }

  function runsText(v) {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (v.simpleText) return v.simpleText;
    if (Array.isArray(v.runs)) return v.runs.map((r) => r.text || "").join("");
    return "";
  }

  function normalizeTracks(rawTracks) {
    return (rawTracks || [])
      .filter((t) => t && t.baseUrl)
      .map((t, index) => {
        const auto = t.kind === "asr" || String(t.vssId || "").startsWith("a.");
        const languageCode = String(t.languageCode || "").toLowerCase();
        return {
          index,
          baseUrl: t.baseUrl,
          languageCode,
          name: runsText(t.name) || languageCode.toUpperCase() || `Track ${index + 1}`,
          auto,
        };
      });
  }

  // Manual tracks before auto-generated ones; source order otherwise.
  function rankTracks(tracks) {
    return [...tracks].sort((a, b) => (a.auto === b.auto ? a.index - b.index : a.auto ? 1 : -1));
  }

  function matchLanguage(tracks, code) {
    const want = String(code || "").toLowerCase().replace("_", "-");
    if (!want) return null;
    const exact = rankTracks(tracks.filter((t) => t.languageCode === want));
    if (exact.length) return exact[0];
    const base = want.split("-")[0];
    const loose = rankTracks(tracks.filter((t) => t.languageCode.split("-")[0] === base));
    return loose[0] || null;
  }

  // Preference order: saved language, browser languages, English, first manual track.
  function chooseTrack(tracks, preferred, browserLanguages) {
    if (!tracks.length) return null;
    for (const code of [preferred, ...(browserLanguages || []), "en"]) {
      const hit = matchLanguage(tracks, code);
      if (hit) return hit;
    }
    return rankTracks(tracks)[0];
  }

  function formatTranscript(segments, meta, format, promptText) {
    const f = { ...DEFAULT_SETTINGS.format, ...(format || {}) };
    const blocks = [];
    if (f.prompt && promptText) blocks.push(promptText.trim());
    const headerLines = [];
    if (f.title && meta.title) headerLines.push(`Title: ${meta.title}`);
    if (f.url && meta.url) headerLines.push(`URL: ${meta.url}`);
    if (headerLines.length) blocks.push(headerLines.join("\n"));
    let body;
    if (f.paragraph) {
      body = segments.map((s) => s.text).join(" ");
    } else {
      const lines = segments.map((s) =>
        f.timestamps ? `(${formatTimestamp(s.start)}) ${s.text}` : s.text,
      );
      body = lines.join(f.spacing ? "\n\n" : "\n");
    }
    blocks.push(body);
    return blocks.join("\n\n").trim();
  }

  function formatMarkdown(segments, meta, format, promptText) {
    const f = { ...DEFAULT_SETTINGS.format, ...(format || {}) };
    let out = "";
    if (f.prompt && promptText) out += `> ${promptText.trim().replace(/\n/g, "\n> ")}\n\n`;
    if (f.title && meta.title) out += `# ${meta.title}\n\n`;
    if (f.url && meta.url) out += `Source: <${meta.url}>\n\n`;
    if (out) out += "---\n\n";
    if (f.paragraph) return out + segments.map((s) => s.text).join(" ") + "\n";
    const sep = f.spacing ? "\n\n" : "  \n";
    out += segments
      .map((s) => (f.timestamps ? `**${formatTimestamp(s.start)}** ${s.text}` : s.text))
      .join(sep);
    return out + "\n";
  }

  // Timestamped plain text for the AI chat context.
  function transcriptForModel(segments) {
    return segments.map((s) => `[${formatTimestamp(s.start)}] ${s.text}`).join("\n");
  }

  // Counts letter/number runs; CJK characters count individually since they have no spaces.
  function countWords(segments) {
    let n = 0;
    for (const s of segments) {
      const text = s.text || "";
      n += (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
      const rest = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, " ");
      n += (rest.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
    }
    return n;
  }

  function sanitizeFilename(name) {
    let s = String(name || "")
      .normalize("NFC")
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
      .replace(/[‪-‮⁦-⁩]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "");
    s = Array.from(s).slice(0, 120).join("").replace(/[.\s]+$/, "");
    if (!/[^_.\s]/.test(s)) return "transcript";
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
    return s;
  }

  function sanitizePresetName(name) {
    return String(name || "")
      .replace(/[<>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 30);
  }

  function platformUrl(platform, text) {
    if (platform.id === "custom") {
      if (!platform.customUrl || !/^https?:\/\//i.test(platform.customUrl)) return "";
      return platform.customUrl.replace(/\{transcript\}/g, encodeURIComponent(text.slice(0, 6000)));
    }
    return (PLATFORMS[platform.id] && PLATFORMS[platform.id].url) || "";
  }

  // Finds `name = {...}` in page HTML and parses the balanced JSON object.
  function extractJsonAssignment(html, name) {
    const re = new RegExp(`${name.replace(/[$]/g, "\\$")}\\s*=\\s*\\{`, "g");
    let m;
    while ((m = re.exec(html))) {
      const start = m.index + m[0].length - 1;
      const json = balancedObject(html, start);
      if (!json) continue;
      try {
        return JSON.parse(json);
      } catch {
        /* keep scanning */
      }
    }
    return null;
  }

  function balancedObject(text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  root.YTS = Object.assign(root.YTS || {}, {
    DEFAULT_SETTINGS,
    DEFAULT_AI,
    PLATFORMS,
    mergeSettings,
    videoIdFromUrl,
    videoRef,
    seekUrl,
    cleanTabTitle,
    wbiKeyFromUrl,
    signWbi,
    md5,
    segmentsFromBilibili,
    normalizeBilibiliTracks,
    isShortsUrl,
    formatTimestamp,
    parseTimestamp,
    cleanText,
    segmentsFromJson3,
    runsText,
    normalizeTracks,
    rankTracks,
    chooseTrack,
    formatTranscript,
    formatMarkdown,
    transcriptForModel,
    countWords,
    sanitizeFilename,
    sanitizePresetName,
    platformUrl,
    extractJsonAssignment,
    newId,
  });
  if (typeof module !== "undefined" && module.exports) module.exports = root.YTS;
})(typeof globalThis !== "undefined" ? globalThis : this);
