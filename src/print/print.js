// Renders a transcript or chat as a printable page and opens the Save-as-PDF dialog.
// The browser's print pipeline handles every script (CJK included) without bundling fonts.
(async function () {
  "use strict";
  const Y = globalThis.YTS;
  const doc = document.getElementById("doc");
  const { printJob: job } = await chrome.storage.session.get("printJob");
  document.getElementById("hint").textContent = Y.t("printHint");
  if (!job) {
    doc.textContent = Y.t("printNothing");
    return;
  }
  await chrome.storage.session.remove("printJob");

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  document.title = Y.sanitizeFilename(job.title) + (job.kind === "chat" ? " - chat" : "");

  if (job.kind === "chat") {
    doc.append(el("h1", "", job.title || "YouTube"), el("p", "source", job.url));
    for (const m of job.messages || []) {
      const turn = el("section", "turn");
      turn.append(el("h2", "", m.role === "user" ? job.labels.user : job.labels.assistant));
      turn.append(el("div", "body", Y.markdown.toPlain(m.content)));
      doc.append(turn);
    }
  } else {
    const f = job.format || {};
    if (f.title && job.title) doc.append(el("h1", "", job.title));
    if (f.url && job.url) doc.append(el("p", "source", job.url));
    if (f.prompt && job.promptText) doc.append(el("p", "prompt", job.promptText));
    if (f.paragraph) {
      doc.append(el("p", "line", job.segments.map((s) => s.text).join(" ")));
    } else {
      const body = el("div", f.spacing ? "spaced" : "");
      for (const s of job.segments) {
        const line = el("p", "line");
        if (f.timestamps) line.append(el("span", "ts", Y.formatTimestamp(s.start)));
        line.append(document.createTextNode(s.text));
        body.append(line);
      }
      doc.append(body);
    }
  }
  setTimeout(() => window.print(), 300);
})();
