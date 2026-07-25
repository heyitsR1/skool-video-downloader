// Skool Video Downloader — license Worker (skool-dl-license).
//
// License-only: activation and 24h revalidation. Problem reports, uninstall
// feedback, version checks, subscription cancellation and the win-back offer go
// through the shared whop-dl-license Worker with product=skool-video-downloader
// — not here. That split is deliberate: everything in THIS Worker uses only
// Dodo's PUBLIC license endpoints, so no secret key is deployed alongside the
// hot path. Every mutation that can move money lives in the shared Worker.
//
// TWO PROCESSORS, one hot path:
//   • Dodo Payments — every customer from v1.3.0 onward.
//   • Freemius — legacy. Kept forever as the fallback so that every key sold
//     before the cutover keeps activating. Never remove it.
//
// Activation tries Dodo first and falls through to Freemius on 404 (unknown
// key). Revalidation dispatches on the source the extension stored at
// activation time — never a guess — so an install that upgraded from 1.2.0
// (no stored source) stays on Freemius.
const FREEMIUS_PRODUCT_ID = '33457';
const FREEMIUS_BASE = `https://api.freemius.com/v1/products/${FREEMIUS_PRODUCT_ID}`;

// ── Dodo Payments ─────────────────────────────────────────────────────────────
// /licenses/activate and /licenses/validate are public — no API key — so they're
// safe to call from a Worker that holds no secret.
//
// ⚠️ Dodo's activate endpoint is GLOBAL, not product-scoped: a valid key for any
// OTHER Dodo product of ours (Claude Project Downloader, Whop) activates
// successfully here too. That's why `products` exists and why an unrecognised
// product_id is a hard error — otherwise a CPD customer's key would unlock Skool
// Pro. Tier comes from the same lookup, so it's exact rather than inferred.
//
// ⚠️ DODO_MODE defaults to 'live' on purpose. This repo is PUBLIC, so the test
// product ids below are public too — anyone could mint a free test-mode license
// against them. Test mode is therefore opt-in per deploy (set the var in
// wrangler.toml, deploy, test, then remove it). Never default this to 'test'.
const DODO_MODES = {
  live: {
    apiBase: 'https://live.dodopayments.com',
    products: {
      pdt_0Njs5UbIatGMhdS1azn5x: 'monthly',
      pdt_0Njs5dir2LdaL8u9azm7j: 'lifetime',
    },
  },
  test: {
    apiBase: 'https://test.dodopayments.com',
    products: {
      pdt_0NjweqyxnaCkUpmqPuhHr: 'monthly',
      pdt_0NjwezohjoHXsRMGhRi9A: 'lifetime',
    },
  },
};

export function resolveDodo(mode) {
  return DODO_MODES[mode === 'test' ? 'test' : 'live'];
}

// Keys a customer might paste for the same license. Dodo compares
// case-sensitively, and copy-paste out of an email client mangles case often
// enough to be worth one extra request on the failure path only — a wrong case
// otherwise reads to the customer as "my key doesn't work".
export function dodoKeyCandidates(licenseKey) {
  const raw = licenseKey.trim();
  const upper = raw.toUpperCase();
  return upper === raw ? [raw] : [raw, upper];
}

export function buildDodoActivateRequest(apiBase, licenseKey, instanceName) {
  return {
    url: `${apiBase}/licenses/activate`,
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ license_key: licenseKey, name: instanceName }),
    },
  };
}

export function buildDodoValidateRequest(apiBase, licenseKey, instanceId) {
  const body = { license_key: licenseKey };
  if (instanceId) body.license_key_instance_id = instanceId;
  return {
    url: `${apiBase}/licenses/validate`,
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

export function buildDodoDeactivateRequest(apiBase, licenseKey, instanceId) {
  return {
    url: `${apiBase}/licenses/deactivate`,
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ license_key: licenseKey, license_key_instance_id: instanceId }),
    },
  };
}

// -> { outcome: 'activated', tier, instanceId }
//  | { outcome: 'fallback' }                     — not a Dodo key; try Freemius
//  | { outcome: 'error', error }                 — a Dodo key we must refuse
//  | { outcome: 'wrong_product', instanceId }    — another product's Dodo key
export function classifyDodoActivation(status, body, products) {
  if (status === 200 || status === 201) {
    const productId = body && body.product && body.product.product_id;
    const tier = productId ? products[productId] : undefined;
    // A real, paid Dodo key — for something that isn't this extension.
    if (!tier) return { outcome: 'wrong_product', instanceId: (body && body.id) || null };
    return { outcome: 'activated', tier, instanceId: (body && body.id) || null };
  }
  // Unknown to Dodo — almost certainly a legacy Freemius key.
  if (status === 404) return { outcome: 'fallback' };
  // A real Dodo key that can't be activated. Don't fall back: Freemius would
  // only fail with a more confusing message.
  if (status === 403) return { outcome: 'error', error: 'license_inactive' };
  if (status === 422) return { outcome: 'error', error: 'activation_limit' };
  // 5xx / rate limit / anything unexpected: a possibly-valid Freemius key must
  // not die because Dodo hiccuped.
  return { outcome: 'fallback' };
}

// -> { outcome: 'valid' | 'invalid' | 'indeterminate' }
// 'indeterminate' is the important one: it means "we could not reach a verdict",
// and callers must keep the customer's existing entitlement.
export function classifyDodoValidation(status, body) {
  if (status === 200 && body && typeof body.valid === 'boolean') {
    return { outcome: body.valid ? 'valid' : 'invalid' };
  }
  // Key deleted, or disabled after a cancellation — Dodo's own verdict.
  if (status === 404 || status === 403) return { outcome: 'invalid' };
  return { outcome: 'indeterminate' };
}

// Activate against Dodo, trying each key casing. Stops at the first definitive
// answer so a 403/422 never triggers a redundant retry.
async function activateViaDodo(cfg, licenseKey, instanceName) {
  let last = { outcome: 'fallback' };
  for (const candidate of dodoKeyCandidates(licenseKey)) {
    const { url, options } = buildDodoActivateRequest(cfg.apiBase, candidate, instanceName);
    let res;
    try {
      res = await fetch(url, options);
    } catch {
      return { outcome: 'fallback' };
    }
    let body = null;
    try { body = await res.json(); } catch { /* empty or non-JSON body */ }
    last = classifyDodoActivation(res.status, body, cfg.products);
    if (last.outcome !== 'fallback') return { ...last, key: candidate };
  }
  return last;
}

// Undo an activation we're about to refuse (another product's key), so we don't
// silently consume a seat on a license that belongs to a different extension.
// Best-effort by definition — the refusal stands either way.
async function deactivateQuietly(cfg, licenseKey, instanceId) {
  if (!instanceId) return;
  try {
    const { url, options } = buildDodoDeactivateRequest(cfg.apiBase, licenseKey, instanceId);
    await fetch(url, options);
  } catch { /* best-effort cleanup */ }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(null, 204);
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/validate-license') return handleValidate(request, env);
    if (request.method === 'POST' && url.pathname === '/activate-license') return handleActivate(request, env);
    return cors(JSON.stringify({ error: 'Not found' }), 404);
  }
};

// ── Freemius (legacy) ─────────────────────────────────────────────────────────
// Freemius uid must be exactly 32 chars. The extension's installId is 'inst_' + UUID.
// Strip the prefix and hyphens to get the 32-char hex UUID.
function toFreemiusUid(installId) {
  return installId.replace(/^inst_/, '').replace(/-/g, '').slice(0, 32);
}

// Until v1.3.0 the popup uppercased the key before sending it, so every stored
// Freemius key is uppercase and Freemius has only ever been asked uppercase
// questions. The popup now sends the key as typed (Dodo is case-sensitive), so
// the uppercasing moved here — keeping the Freemius path byte-identical to what
// has always worked.
function toFreemiusKey(licenseKey) {
  return licenseKey.trim().toUpperCase();
}

// Freemius requires a user email (or an existing user) on activation; extensions
// have no account, so we synthesize a stable per-install address from the uid.
async function callActivate(licenseKey, installId, env) {
  const uid = toFreemiusUid(installId);
  const res = await fetch(`${FREEMIUS_BASE}/licenses/activate.json`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.FREEMIUS_SECRET_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      uid,
      license_key: toFreemiusKey(licenseKey),
      first_name: 'Extension',
      last_name: 'User',
      user_email: `install-${uid.slice(0, 16)}@extension.app`,
      is_marketing_allowed: false,
    }),
  });
  return res.json();
}

// After a fresh activation we have install_id + install_api_token; use them to fetch
// the license object so we can determine lifetime vs monthly tier.
async function fetchInstallLicense(freemiusInstallId, uid, licenseKey, installToken) {
  const url = `${FREEMIUS_BASE}/installs/${freemiusInstallId}/license.json` +
    `?uid=${encodeURIComponent(uid)}&license_key=${encodeURIComponent(licenseKey)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${installToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.error ? null : data;
}

function parseTier(licenseData) {
  if (!licenseData) return 'monthly';
  return (licenseData.is_lifetime || !licenseData.expiration) ? 'lifetime' : 'monthly';
}

// ── POST /activate-license ────────────────────────────────────────────────────
// -> { valid: true, tier?, source, instanceId? } | { valid: false, error }
async function handleActivate(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.licenseKey || !body?.installId) {
    return cors(JSON.stringify({ valid: false, error: 'missing_params' }), 400);
  }

  // ── Mechanism 1: Dodo Payments (every customer since v1.3.0) ────────────────
  const dodo = resolveDodo(env.DODO_MODE);
  const uid = toFreemiusUid(body.installId);
  const outcome = await activateViaDodo(dodo, body.licenseKey, uid);

  if (outcome.outcome === 'activated') {
    return cors(JSON.stringify({
      valid: true,
      tier: outcome.tier,
      source: 'dodo',
      instanceId: outcome.instanceId,
      licenseKey: outcome.key,
    }), 200);
  }
  if (outcome.outcome === 'wrong_product') {
    await deactivateQuietly(dodo, outcome.key, outcome.instanceId);
    return cors(JSON.stringify({ valid: false, error: 'wrong_product' }), 200);
  }
  if (outcome.outcome === 'error') {
    return cors(JSON.stringify({ valid: false, error: outcome.error }), 200);
  }

  // ── Mechanism 2: Freemius (keys sold before the cutover) ────────────────────
  // A Dodo key is a 36-char UUID; Freemius keys are at most 32. Anything longer
  // can only be a Dodo key that Dodo already rejected, and asking Freemius would
  // return a confusing "limited to 32 characters" error.
  if (body.licenseKey.trim().length > 32) {
    return cors(JSON.stringify({ valid: false, error: 'unknown_key' }), 200);
  }

  let data;
  try {
    data = await callActivate(body.licenseKey, body.installId, env);
  } catch {
    return cors(JSON.stringify({ valid: false, error: 'network_error' }), 200);
  }

  if (data.error) {
    const code = data.error.code;
    // Same device re-activating an already-active license is valid — no new seat consumed.
    // We don't have tier info in this error response; the extension keeps its stored tier.
    if (code === 'license_activated') return cors(JSON.stringify({ valid: true, source: 'freemius' }), 200);
    return cors(JSON.stringify({ valid: false, error: code }), 200);
  }

  // Fresh activation — fetch license details to determine tier.
  const licenseData = await fetchInstallLicense(data.install_id, uid, toFreemiusKey(body.licenseKey), data.install_api_token);
  const tier = parseTier(licenseData);

  return cors(JSON.stringify({ valid: true, tier, source: 'freemius' }), 200);
}

// ── POST /validate-license ────────────────────────────────────────────────────
// -> { valid: true }                          — still entitled
//  | { valid: false, error }                  — definitively not entitled; revoke
//  | { valid: true, indeterminate: true }     — no verdict reachable; keep state
//
// The indeterminate shape deliberately reports valid:true. v1.2.0 clients look
// only at `valid` and revoke on anything falsy, which means a provider outage
// used to downgrade paying customers to free. Reporting valid:true fixes that
// for already-shipped clients; v1.3.0+ additionally reads `indeterminate` and
// retries on the next hourly alarm instead of resting for 24h.
async function handleValidate(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.licenseKey || !body?.installId) {
    return cors(JSON.stringify({ valid: false, error: 'missing_params' }), 400);
  }

  // Dispatch on the source stored at activation time. Absent = an install that
  // predates v1.3.0, which can only hold a Freemius key.
  if (body.source === 'dodo') return validateDodo(body, env);
  return validateFreemius(body, env);
}

async function validateDodo(body, env) {
  const dodo = resolveDodo(env.DODO_MODE);
  const { url, options } = buildDodoValidateRequest(dodo.apiBase, body.licenseKey.trim(), body.instanceId);
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    return cors(JSON.stringify({ valid: true, indeterminate: true, error: 'network_error' }), 200);
  }
  let payload = null;
  try { payload = await res.json(); } catch { /* empty or non-JSON body */ }

  const { outcome } = classifyDodoValidation(res.status, payload);
  if (outcome === 'valid') return cors(JSON.stringify({ valid: true, source: 'dodo' }), 200);
  if (outcome === 'invalid') return cors(JSON.stringify({ valid: false, error: 'license_inactive' }), 200);
  return cors(JSON.stringify({ valid: true, indeterminate: true, error: 'provider_unavailable' }), 200);
}

async function validateFreemius(body, env) {
  let data;
  try {
    data = await callActivate(body.licenseKey, body.installId, env);
  } catch {
    // Unreachable provider is not a verdict — keep the customer's entitlement.
    return cors(JSON.stringify({ valid: true, indeterminate: true, error: 'network_error' }), 200);
  }

  if (data.error) {
    const code = data.error.code;
    // license_activated means the seat is still held by this device = still valid.
    if (code === 'license_activated') return cors(JSON.stringify({ valid: true, source: 'freemius' }), 200);
    return cors(JSON.stringify({ valid: false, error: code }), 200);
  }

  // Shouldn't normally happen during revalidation (first activation was already counted),
  // but handle it gracefully.
  return cors(JSON.stringify({ valid: true, source: 'freemius' }), 200);
}

function cors(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
