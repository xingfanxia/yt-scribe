// Browser-only helpers: i18n lookup, static-markup localization, clipboard.
(function () {
  "use strict";
  const Y = globalThis.YTS;

  function t(key, subs) {
    return chrome.i18n.getMessage(key, subs) || key;
  }

  // Fills data-i18n (text), data-i18n-placeholder, data-i18n-title and data-i18n-aria.
  function localize(root = document) {
    for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll("[data-i18n-placeholder]"))
      el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
    for (const el of root.querySelectorAll("[data-i18n-aria]"))
      el.setAttribute("aria-label", t(el.dataset.i18nAria));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* focus or permission issue; fall back to a hidden textarea */
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    const active = document.activeElement;
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (active && active.focus) active.focus({ preventScroll: true });
    if (!ok) {
      const err = new Error("clipboard");
      err.code = "clipboard";
      throw err;
    }
  }

  function errorMessage(code) {
    const key = `err_${code}`;
    const msg = chrome.i18n.getMessage(key);
    return msg || t("err_network");
  }

  function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Hands content to the print page, which opens the browser's Save-as-PDF dialog.
  async function printToPdf(job) {
    await chrome.storage.session.set({ printJob: job });
    await chrome.tabs.create({ url: chrome.runtime.getURL("src/print/print.html") });
  }

  Y.t = t;
  Y.localize = localize;
  Y.copyText = copyText;
  Y.errorMessage = errorMessage;
  Y.download = download;
  Y.printToPdf = printToPdf;
})();
