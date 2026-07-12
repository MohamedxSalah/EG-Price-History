// Background script: owns the "open Kanbkam, paste the link into
// their own search box, submit it" flow. This runs independently of the
// popup, which closes as soon as the new tab gets focus.
//
// Firefox MV3 exposes the promise-based `browser` namespace natively;
// Chrome's `chrome` namespace also resolves promises when no callback is
// passed, so a single api shim covers both.
const api = typeof browser !== "undefined" ? browser : chrome;

const KANBKAM_HOME = "https://www.kanbkam.com/eg/en/home";

api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.action === "kanbkamPasteSearch") {
    runKanbkamPasteSearch(msg.pasteValue, msg.fallbackUrl);
  }
  return false;
});

async function runKanbkamPasteSearch(pasteValue, fallbackUrl) {
  const tab = await api.tabs.create({ url: KANBKAM_HOME, active: true });
  if (!tab || !tab.id) return;
  const tabId = tab.id;
  let settled = false;

  const timeoutId = setTimeout(() => {
    if (!settled) {
      settled = true;
      api.tabs.onUpdated.removeListener(listener);
      // Give up waiting on page load signals; try anyway.
      attemptFill(tabId, pasteValue, fallbackUrl);
    }
  }, 15000);

  function listener(updatedTabId, changeInfo) {
    if (updatedTabId === tabId && changeInfo.status === "complete") {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      api.tabs.onUpdated.removeListener(listener);
      // Kanbkam is a JS-rendered page; give its search box a beat to mount.
      setTimeout(() => attemptFill(tabId, pasteValue, fallbackUrl), 900);
    }
  }
  api.tabs.onUpdated.addListener(listener);
}

async function attemptFill(tabId, pasteValue, fallbackUrl) {
  let ok = false;
  try {
    const results = await api.scripting.executeScript({
      target: { tabId },
      func: fillAndSubmitSearch,
      args: [pasteValue]
    });
    ok = Boolean(results && results[0] && results[0].result && results[0].result.ok);
  } catch (e) {
    ok = false;
  }

  if (!ok && fallbackUrl) {
    // Their search box wasn't found (layout changed / didn't load in time) —
    // fall back to a plain keyword search so the user still lands somewhere useful.
    api.tabs.update(tabId, { url: fallbackUrl });
  }
}

// Runs inside the Kanbkam page. Finds their search input, sets it to the
// pasted value the same way a person pasting text would, and submits it.
function fillAndSubmitSearch(value) {
  function reactSet(el, val) {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, val);
  }

  const selectors = [
    'input[type="search"]',
    'input[name="search"]',
    'input[name="q"]',
    'input#search',
    'input.search-input',
    'input[placeholder*="Search" i]',
    'input[placeholder*="بحث"]',
    'header form input[type="text"]',
    'form input[type="text"]'
  ];

  let input = null;
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      input = el;
      break;
    }
  }
  if (!input) return { ok: false, reason: "no-input-found" };

  input.focus();
  reactSet(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  const enterOpts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
  input.dispatchEvent(new KeyboardEvent("keydown", enterOpts));
  input.dispatchEvent(new KeyboardEvent("keypress", enterOpts));
  input.dispatchEvent(new KeyboardEvent("keyup", enterOpts));

  const form = input.closest("form");
  if (form && typeof form.requestSubmit === "function") {
    try { form.requestSubmit(); } catch (e) { /* ignore */ }
  }

  const btn = (form || document).querySelector(
    'button[type="submit"], .search-btn, .search-icon, button[class*="search" i]'
  );
  if (btn) btn.click();

  return { ok: true };
}
