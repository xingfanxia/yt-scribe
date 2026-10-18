// Builds a real PDF (selectable text, subsetted fonts) for transcripts and chats with pdfkit.
// Noto Sans covers Latin/Greek/Cyrillic; Noto Sans SC adds Chinese and Japanese kana.
// Text the two fonts cannot draw (e.g. Hangul, Arabic, Thai) returns null so callers
// can fall back to the print view instead of producing empty boxes.
(function () {
  "use strict";
  const Y = globalThis.YTS;

  const PAGE = { width: 595.28, height: 841.89, margin: 56 };
  const INK = "#17203a";
  const MUTED = "#5b6680";
  const ACCENT = "#8a6200";
  const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/u;
  const TOKEN = /[⺀-鿿豈-﫿＀-￯　-〿]|[^\s⺀-鿿豈-﫿＀-￯　-〿]+\s*|\s+/gu;

  let lib = null;
  function ensureLib() {
    if (!lib) {
      lib = new Promise((resolve, reject) => {
        if (globalThis.PDFDocument) return resolve();
        const s = document.createElement("script");
        s.src = chrome.runtime.getURL("src/vendor/pdfkit.standalone.js");
        s.onload = resolve;
        s.onerror = () => reject(new Error("failed to load pdfkit"));
        document.head.append(s);
      });
    }
    return lib;
  }

  const fontBytes = {};
  function loadFont(file) {
    if (!fontBytes[file]) {
      fontBytes[file] = fetch(chrome.runtime.getURL(`fonts/${file}`))
        .then((r) => r.arrayBuffer())
        .then((b) => new Uint8Array(b));
    }
    return fontBytes[file];
  }

  // pdfkit keeps the parsed fontkit font on the active font object (pinned pdfkit@0.20.2).
  function hasGlyph(doc, name, ch) {
    doc.font(name);
    return doc._font.font.hasGlyphForCodePoint(ch.codePointAt(0));
  }

  class Writer {
    constructor(doc, hasCjk) {
      this.doc = doc;
      this.hasCjk = hasCjk;
      this.y = PAGE.margin;
      this.cache = new Map();
    }

    fontFor(ch) {
      if (!this.hasCjk) return "L";
      let name = this.cache.get(ch);
      if (!name) {
        name = hasGlyph(this.doc, "L", ch) ? "L" : "C";
        this.cache.set(ch, name);
      }
      return name;
    }

    // [{font, text}] runs of consecutive characters sharing a font; spaces join the current run.
    runs(text) {
      const out = [];
      for (const ch of text) {
        const font = /\s/.test(ch) && out.length ? out[out.length - 1].font : this.fontFor(ch);
        const last = out[out.length - 1];
        if (last && last.font === font) last.text += ch;
        else out.push({ font, text: ch });
      }
      return out;
    }

    width(text, size) {
      return this.runs(text).reduce((w, r) => w + this.doc.font(r.font).fontSize(size).widthOfString(r.text), 0);
    }

    wrap(text, size, maxWidth) {
      const lines = [];
      let line = "";
      for (const tok of text.match(TOKEN) || []) {
        const candidate = line + tok;
        if (line && this.width(candidate.trimEnd(), size) > maxWidth) {
          lines.push(line.trimEnd());
          line = tok.trimStart();
        } else line = candidate;
        // A single unbreakable token wider than the line is split by characters.
        while ([...line].length > 1 && this.width(line.trimEnd(), size) > maxWidth) {
          let head = "";
          for (const ch of line) {
            if (head && this.width(head + ch, size) > maxWidth) break;
            head += ch;
          }
          lines.push(head);
          line = line.slice(head.length);
        }
      }
      if (line.trim()) lines.push(line.trimEnd());
      return lines.length ? lines : [""];
    }

    ensureSpace(height) {
      if (this.y + height > PAGE.height - PAGE.margin) {
        this.doc.addPage();
        this.y = PAGE.margin;
      }
    }

    drawLine(text, x, size, color) {
      let cursor = x;
      for (const run of this.runs(text)) {
        this.doc.font(run.font).fontSize(size).fillColor(color).text(run.text, cursor, this.y, { lineBreak: false });
        cursor += this.doc.widthOfString(run.text);
      }
    }

    // Wrapped paragraph; `prefix` (e.g. a timestamp) sits in a hanging column.
    paragraph(text, { size = 10.5, color = INK, gap = 0, prefix = "", prefixWidth = 0 } = {}) {
      const lineHeight = size * 1.5;
      const x = PAGE.margin + prefixWidth;
      const lines = this.wrap(text, size, PAGE.width - PAGE.margin - x);
      lines.forEach((line, i) => {
        this.ensureSpace(lineHeight);
        if (i === 0 && prefix) this.drawLine(prefix, PAGE.margin, size * 0.92, ACCENT);
        this.drawLine(line, x, size, color);
        this.y += lineHeight;
      });
      this.y += gap;
    }

    rule() {
      this.ensureSpace(14);
      this.doc
        .moveTo(PAGE.margin, this.y + 2)
        .lineTo(PAGE.width - PAGE.margin, this.y + 2)
        .lineWidth(0.5)
        .strokeColor("#d5dbe6")
        .stroke();
      this.y += 14;
    }
  }

  async function build(allText, title, render) {
    await ensureLib();
    const doc = new globalThis.PDFDocument({ size: "A4", margin: 0, info: { Title: title || "Transcript", Creator: "YT Scribe" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    const done = new Promise((resolve) => doc.on("end", resolve));

    doc.registerFont("L", await loadFont("NotoSans-Regular.ttf"));
    const chars = [...new Set(allText.replace(/\s/g, ""))];
    const needCjk = chars.some((c) => !hasGlyph(doc, "L", c));
    if (needCjk) {
      doc.registerFont("C", await loadFont("NotoSansSC-Regular.ttf"));
      if (chars.some((c) => !hasGlyph(doc, "L", c) && !hasGlyph(doc, "C", c))) return null;
    }
    render(new Writer(doc, needCjk));
    doc.end();
    await done;
    const size = chunks.reduce((n, c) => n + c.length, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    return bytes;
  }

  function header(w, title, url) {
    if (title) w.paragraph(title, { size: 16, gap: 4 });
    if (url) w.paragraph(url, { size: 8.5, color: MUTED, gap: 2 });
    if (title || url) w.rule();
  }

  // Resolves to PDF bytes, or null when the text needs a script the bundled fonts lack.
  async function transcriptPdf({ title, url, segments, format, promptText }) {
    const f = { ...Y.DEFAULT_SETTINGS.format, ...(format || {}) };
    const all = [title, url, promptText, ...segments.map((s) => s.text), "0123456789:"].join("\n");
    return build(all, title, (w) => {
      header(w, f.title ? title : "", f.url ? url : "");
      if (f.prompt && promptText) {
        w.paragraph(promptText, { color: MUTED, gap: 8 });
        w.rule();
      }
      if (f.paragraph) {
        w.paragraph(segments.map((s) => s.text).join(CJK.test(segments[0]?.text || "") ? "" : " "));
        return;
      }
      const prefixWidth = f.timestamps ? (segments.some((s) => s.start >= 3600000) ? 54 : 40) : 0;
      for (const s of segments) {
        w.paragraph(s.text, {
          prefix: f.timestamps ? Y.formatTimestamp(s.start) : "",
          prefixWidth,
          gap: f.spacing ? 5 : 0,
        });
      }
    });
  }

  async function chatPdf({ title, url, messages, labels }) {
    const bodies = messages.map((m) => Y.markdown.toPlain(m.content));
    const all = [title, url, labels.user, labels.assistant, ...bodies].join("\n");
    return build(all, title, (w) => {
      header(w, title, url);
      messages.forEach((m, i) => {
        w.paragraph(m.role === "user" ? labels.user : labels.assistant, { size: 11, color: ACCENT, gap: 2 });
        for (const para of bodies[i].split(/\n+/)) if (para.trim()) w.paragraph(para, { gap: 4 });
        w.y += 8;
      });
    });
  }

  // Downloads the PDF directly; falls back to the print view for unsupported scripts.
  // Resolves to "download" or "print".
  async function exportPdf(job, filename) {
    const bytes = job.kind === "chat" ? await chatPdf(job) : await transcriptPdf(job);
    if (!bytes) {
      await Y.printToPdf(job);
      return "print";
    }
    Y.download(`${filename}.pdf`, bytes, "application/pdf");
    return "download";
  }

  Y.pdf = { transcriptPdf, chatPdf, exportPdf };
})();
