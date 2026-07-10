// Skool Video Downloader — license Worker (skool-dl-license).
// License-only: activation and 24h revalidation against Freemius. Problem
// reports, uninstall feedback, and version checks go through the shared
// whop-dl-license Worker with product=skool-video-downloader — not here.
const FREEMIUS_PRODUCT_ID = '33457';
const FREEMIUS_BASE = `https://api.freemius.com/v1/products/${FREEMIUS_PRODUCT_ID}`;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(null, 204);
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/validate-license') return handleValidate(request, env);
    if (request.method === 'POST' && url.pathname === '/activate-license') return handleActivate(request, env);
    return cors(JSON.stringify({ error: 'Not found' }), 404);
  }
};

// Freemius uid must be exactly 32 chars. The extension's installId is 'inst_' + UUID.
// Strip the prefix and hyphens to get the 32-char hex UUID.
function toFreemiusUid(installId) {
  return installId.replace(/^inst_/, '').replace(/-/g, '').slice(0, 32);
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
      license_key: licenseKey,
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

async function handleActivate(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.licenseKey || !body?.installId) {
    return cors(JSON.stringify({ valid: false, error: 'missing_params' }), 400);
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
    if (code === 'license_activated') return cors(JSON.stringify({ valid: true }), 200);
    return cors(JSON.stringify({ valid: false, error: code }), 200);
  }

  // Fresh activation — fetch license details to determine tier.
  const uid = toFreemiusUid(body.installId);
  const licenseData = await fetchInstallLicense(data.install_id, uid, body.licenseKey, data.install_api_token);
  const tier = parseTier(licenseData);

  return cors(JSON.stringify({ valid: true, tier }), 200);
}

async function handleValidate(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.licenseKey || !body?.installId) {
    return cors(JSON.stringify({ valid: false, error: 'missing_params' }), 400);
  }

  let data;
  try {
    data = await callActivate(body.licenseKey, body.installId, env);
  } catch {
    // Network error — caller keeps existing state and retries next day.
    return cors(JSON.stringify({ valid: false, error: 'network_error' }), 200);
  }

  if (data.error) {
    const code = data.error.code;
    // license_activated means the seat is still held by this device = still valid.
    if (code === 'license_activated') return cors(JSON.stringify({ valid: true }), 200);
    return cors(JSON.stringify({ valid: false, error: code }), 200);
  }

  // Shouldn't normally happen during revalidation (first activation was already counted),
  // but handle it gracefully.
  return cors(JSON.stringify({ valid: true }), 200);
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
