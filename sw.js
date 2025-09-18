/* SAS-TimeStamps API Service Worker
   - Exposes GET /api?name=<FOLDER>
   - Returns JSON with deterministic timestamps based on your rules
   - No server required; runs entirely on GitHub Pages via SW

   NOTE: A client must visit the site once to install the SW.
*/

// ===== USER CONFIG =====
const SECONDS_BETWEEN_ITEMS = 1;
const SLOTS_PER_CATEGORY    = 86400; // 1 day worth of seconds per category

// Map exact (unprefixed) names into category buckets
const UNPREFIXED_IN_CATEGORY = {
  "APP_": ["OSDXMB", "XEBPLUS"],
  "APPS": [],
  "PS1_": [],
  "EMU_": [],
  "GME_": [],
  "DST_": [],
  "DBG_": [],
  "RAA_": ["RESTART", "POWEROFF"],
  "RTE_": ["NEUTRINO"],
  "SYS_": ["BOOT"],
  "ZZY_": ["EXPLOITS"],
  "ZZZ_": ["BM", "MATRIXTEAM", "OPL"],
};

// Category order (newest → oldest)
const CATEGORY_ORDER = [
  "APP_",
  "APPS",
  "PS1_",
  "EMU_",
  "GME_",
  "DST_",
  "DBG_",
  "RAA_",
  "RTE_",
  "DEFAULT",
  "SYS_",
  "ZZY_",
  "ZZZ_",
];

// ===== INTERNALS =====
const CATEGORY_INDEX = Object.fromEntries(CATEGORY_ORDER.map((k,i)=>[k,i]));
const CATEGORY_BLOCK_SECONDS = SLOTS_PER_CATEGORY * SECONDS_BETWEEN_ITEMS;

// Charset and lex mapping (we ignore '-' in payload)
const CHARSET = " 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_-.";
const CHAR_INDEX = new Map(Array.from(CHARSET).map((ch,i)=>[ch,i]));
const BASE = CHARSET.length;

// Helpers
function toUTCDateFromLocalBaseMinusSeconds(totalSeconds) {
  // Base local time: 2098-12-31 23:59:59, converted to UTC after subtracting
  const baseLocal = new Date(2098, 11, 31, 23, 59, 59); // months 0-based; 11 = December
  // Subtract seconds in local time
  const tsLocal = new Date(baseLocal.getTime() - totalSeconds * 1000);
  // Convert that local instant to UTC ISO (Date stores ms since epoch UTC)
  return tsLocal; // JS Date is always an absolute instant; format later
}

function normalizeToEffective(name) {
  const n = String(name || "").trim().toUpperCase();

  // 1) user-configured exact-name mappings
  for (const [catKey, list] of Object.entries(UNPREFIXED_IN_CATEGORY)) {
    if (list.includes(n)) {
      return catKey === "APPS" ? "APPS" : (catKey + n);
    }
  }

  // 2) built-ins
  if (n === "OSDXMB" || n === "XEBPLUS") return "APP_" + n;
  if (n === "RESTART" || n === "POWEROFF") return "RAA_" + n;
  if (n === "NEUTRINO") return "RTE_" + n;
  if (n === "BOOT") return "SYS_BOOT";
  if (n === "EXPLOITS") return "ZZY_EXPLOITS";
  if (n === "BM" || n === "MATRIXTEAM" || n === "OPL") return "ZZZ_" + n;

  // 3) otherwise, as-is (may already be prefixed)
  return n;
}

function effectiveCategoryKey(eff) {
  if (eff.startsWith("APP_")) return "APP_";
  if (eff === "APPS") return "APPS";
  if (eff.startsWith("PS1_")) return "PS1_";
  if (eff.startsWith("EMU_")) return "EMU_";
  if (eff.startsWith("GME_")) return "GME_";
  if (eff.startsWith("DST_")) return "DST_";
  if (eff.startsWith("DBG_")) return "DBG_";
  if (eff.startsWith("RAA_")) return "RAA_";
  if (eff.startsWith("RTE_")) return "RTE_";
  if (eff.startsWith("SYS_") || eff === "SYS") return "SYS_";
  if (eff.startsWith("ZZY_")) return "ZZY_";
  if (eff.startsWith("ZZZ_")) return "ZZZ_";
  return "DEFAULT";
}

function categoryLabel(eff) {
  const key = effectiveCategoryKey(eff);
  if (key === "DEFAULT") return "DEFAULT";
  return key === "APPS" ? "APPS" : `${key}*`;
}

function payloadForEffective(eff) {
  // Ignore dashes for ordering; keep underscores
  const key = effectiveCategoryKey(eff);
  if (key === "APPS") return "APPS";
  if (key === "DEFAULT") return eff.replace(/-/g, "");
  const payload = eff.startsWith(key) ? eff.slice(key.length) : eff;
  return payload.replace(/-/g, "");
}

function lexFraction(payload) {
  const s = String(payload || "").toUpperCase();
  let total = 0;
  let scale = 1;
  for (let i = 0; i < Math.min(128, s.length); i++) {
    scale *= BASE;
    const ch = s[i];
    const code = CHAR_INDEX.has(ch) ? CHAR_INDEX.get(ch) : (BASE - 1);
    total += (code + 1) / scale;
  }
  return total; // in [0, 1)
}

function slotIndexWithinCategory(eff) {
  const payload = payloadForEffective(eff);
  const frac = lexFraction(payload);
  let slot = Math.floor(frac * SLOTS_PER_CATEGORY);
  if (slot >= SLOTS_PER_CATEGORY) slot = SLOTS_PER_CATEGORY - 1;
  return { slot, payloadUsed: payload };
}

function stableHash01(s) {
  // FNV-1a 32-bit, then mod 2
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 1;
}

function planForName(originalName) {
  const eff = normalizeToEffective(originalName);
  const catKey = effectiveCategoryKey(eff);
  const catIdx = CATEGORY_INDEX[catKey];
  const { slot, payloadUsed } = slotIndexWithinCategory(eff);
  const nudge = stableHash01(eff);

  const catOffset  = catIdx * CATEGORY_BLOCK_SECONDS;
  const nameOffset = (slot * SECONDS_BETWEEN_ITEMS) + nudge;
  const offsetSec  = catOffset + nameOffset;

  const dt = toUTCDateFromLocalBaseMinusSeconds(offsetSec);

  return {
    ok: true,
    input: String(originalName || ""),
    effectiveName: eff,
    category: categoryLabel(eff),
    categoryKey: catKey,
    categoryIndex: catIdx,
    slot,
    offsetSeconds: offsetSec,
    payloadUsed, // the dash-stripped string used for ordering
    // Times
    isoLocal: new Date(dt.valueOf()).toLocaleString(), // local display
    isoUTC:   new Date(dt.valueOf()).toISOString(),    // UTC ISO
    epochMillis: dt.valueOf()
  };
}

// ===== Service Worker plumbing =====
self.addEventListener('install', (evt) => {
  // activate immediately
  self.skipWaiting();
});

self.addEventListener('activate', (evt) => {
  // take control immediately
  evt.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (evt) => {
  const url = new URL(evt.request.url);
  if (url.pathname === '/api' || url.pathname.endsWith('/api')) {
    evt.respondWith(handleApi(url));
  }
});

async function handleApi(url) {
  const name = url.searchParams.get('name') || '';
  const body = JSON.stringify(
    name ? planForName(name) : { ok:false, error:"Missing 'name' query param" },
    null, 2
  );
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
