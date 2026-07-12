// Firefox MV3 exposes the promise-based `browser` namespace natively;
// Chrome's `chrome` namespace also resolves promises when no callback is
// passed, so a single api shim covers both.
const api = typeof browser !== "undefined" ? browser : chrome;

// ---------- Site detection ----------

function detectSite(url) {
  const host = new URL(url).hostname;
  if (host.includes("amazon.eg")) return "amazon";
  if (host.includes("noon.com")) return "noon";
  if (host.includes("jumia.com.eg")) return "jumia";
  return null;
}

const SITE_LABELS = {
  amazon: "Amazon Egypt",
  noon: "Noon Egypt",
  jumia: "Jumia Egypt"
};

// ---------- Product extraction (runs inside the page) ----------
// Executed via api.scripting.executeScript, so it must be self-contained.
function extractProductInfo() {
  function clean(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  let title = null;

  // 1) Site-specific selectors (best accuracy)
  const candidates = [
    "#productTitle",                 // Amazon
    "h1[class*='pdp']",              // Noon
    "h1[data-qa='pdp-name']",        // Noon
    "h1.-fs20",                      // Jumia
    "h1[data-name]",                 // Jumia variants
    "h1"
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && clean(el.textContent).length > 3) {
      title = clean(el.textContent);
      break;
    }
  }

  // 2) og:title meta fallback (usually clean product name)
  if (!title) {
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) title = clean(og.content);
  }

  // 3) document.title fallback, stripped of site suffix
  if (!title) {
    title = clean(document.title).split(/[:|]| - /)[0];
  }

  // Try to pull an Amazon ASIN from the URL for reference
  let asin = null;
  const m = location.href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (m) asin = m[1];

  return { title, asin, url: location.href };
}

// ---------- URL builders ----------

function slugify(text) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

function buildKanbkamUrl(query) {
  const slug = slugify(query) || "search";
  return `https://www.kanbkam.com/eg/en/search/${encodeURIComponent(slug)}`;
}

function buildPricenaUrl(query) {
  const params = new URLSearchParams({ s: query });
  return `https://eg.pricena.com/en/search/?${params.toString()}`;
}

// ---------- Popup wiring ----------

const els = {
  loading: document.getElementById("loading"),
  unsupported: document.getElementById("unsupported"),
  found: document.getElementById("found"),
  siteTag: document.getElementById("siteTag"),
  productTitle: document.getElementById("productTitle"),
  queryInput: document.getElementById("queryInput"),
  btnKanbkam: document.getElementById("btnKanbkam"),
  btnPricena: document.getElementById("btnPricena"),
  footnote: document.getElementById("footnote")
};

function showState(name) {
  els.loading.classList.add("hidden");
  els.unsupported.classList.add("hidden");
  els.found.classList.add("hidden");
  els[name].classList.remove("hidden");
}

async function init() {
  showState("loading");

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    showState("unsupported");
    return;
  }

  const site = detectSite(tab.url);
  if (!site) {
    showState("unsupported");
    return;
  }

  let info;
  try {
    const [{ result }] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractProductInfo
    });
    info = result;
  } catch (e) {
    info = null;
  }

  if (!info || !info.title) {
    showState("unsupported");
    return;
  }

  els.siteTag.textContent = SITE_LABELS[site];
  els.productTitle.textContent = info.title;
  els.queryInput.value = info.title;

  els.footnote.textContent = site === "amazon"
    ? "Note: Kanbkam does not track price history or alerts for Amazon listings — Pricena is the better pick here. Pricena searches by name, so pick the closest match on its results page."
    : site === "jumia"
    ? "Kanbkam opens with this product's name pasted into their search box (link search doesn't work for Jumia listings). Pricena searches by name, so pick the closest match on its results page."
    : "Kanbkam opens with this product's link pasted into their search box, same as doing it by hand. Pricena searches by name, so pick the closest match on its results page.";

  els.btnKanbkam.addEventListener("click", () => {
    const q = els.queryInput.value.trim() || info.title;
    // Kanbkam's exact-match search is a JS-driven box on their site, not a
    // documented GET endpoint. So instead of guessing a URL, we open
    // Kanbkam and paste text into their own search box — same as doing it
    // by hand. If that box can't be found, it falls back to a plain
    // keyword search. Jumia product links don't resolve on Kanbkam, so for
    // Jumia we paste the product name (keyword) instead of the link.
    const pasteValue = site === "jumia" ? q : info.url;
    api.runtime.sendMessage({
      action: "kanbkamPasteSearch",
      pasteValue,
      fallbackUrl: buildKanbkamUrl(q)
    });
    window.close();
  });

  els.btnPricena.addEventListener("click", () => {
    const q = els.queryInput.value.trim() || info.title;
    api.tabs.create({ url: buildPricenaUrl(q) });
  });

  showState("found");
}

document.addEventListener("DOMContentLoaded", init);
