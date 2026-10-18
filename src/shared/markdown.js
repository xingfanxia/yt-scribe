// Minimal Markdown -> HTML for model replies. Escapes everything first, then adds a
// small whitelist of formatting, so model output can never inject markup.
// [m:ss] / [h:mm:ss] become seek links.
(function (root) {
  "use strict";

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function inline(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(
        /\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]/g,
        (_, ts) => `<button type="button" class="ts" data-ts="${ts}">${ts}</button>`,
      );
  }

  function render(md) {
    const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let list = null; // "ul" | "ol"
    let para = [];
    let fence = null;

    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    };
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };

    for (const line of lines) {
      if (fence !== null) {
        if (/^```/.test(line)) {
          out.push(`<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`);
          fence = null;
        } else fence.push(line);
        continue;
      }
      if (/^```/.test(line)) {
        flushPara();
        closeList();
        fence = [];
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const quote = line.match(/^>\s?(.*)$/);
      if (heading) {
        flushPara();
        closeList();
        const level = Math.min(heading[1].length + 2, 6);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (bullet || numbered) {
        flushPara();
        const kind = bullet ? "ul" : "ol";
        if (list !== kind) {
          closeList();
          out.push(`<${kind}>`);
          list = kind;
        }
        out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      } else if (quote) {
        flushPara();
        closeList();
        out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        flushPara();
        closeList();
        out.push("<hr>");
      } else if (!line.trim()) {
        flushPara();
        closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    if (fence !== null) out.push(`<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`);
    flushPara();
    closeList();
    return out.join("");
  }

  // Plain text for PDF output.
  function toPlain(md) {
    return String(md || "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s*[-*]\s+/gm, "• ");
  }

  const api = { render, toPlain, escapeHtml };
  root.YTS = root.YTS || {};
  root.YTS.markdown = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
