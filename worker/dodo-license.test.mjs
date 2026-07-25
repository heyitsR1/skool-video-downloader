import test from 'node:test';
import assert from 'node:assert';
import worker, {
  resolveDodo,
  dodoKeyCandidates,
  buildDodoActivateRequest,
  buildDodoValidateRequest,
  buildDodoDeactivateRequest,
  classifyDodoActivation,
  classifyDodoValidation,
} from './index.js';

const LIVE_MONTHLY = 'pdt_0Njs5UbIatGMhdS1azn5x';
const LIVE_LIFETIME = 'pdt_0Njs5dir2LdaL8u9azm7j';
const PRODUCTS = { [LIVE_MONTHLY]: 'monthly', [LIVE_LIFETIME]: 'lifetime' };

const INSTALL_ID = 'inst_11111111-2222-3333-4444-555555555555';
const DODO_KEY = '8F2A1B4C-9D3E-4F5A-8B7C-1D2E3F4A5B6C';

// ── Mode resolution ───────────────────────────────────────────────────────────
// Defaulting to live matters: this repo is public, so honouring test-mode keys by
// accident would hand out free Pro to anyone who read the product ids.

test('resolveDodo defaults to live when the mode is unset or unrecognised', () => {
  assert.strictEqual(resolveDodo(undefined).apiBase, 'https://live.dodopayments.com');
  assert.strictEqual(resolveDodo('').apiBase, 'https://live.dodopayments.com');
  assert.strictEqual(resolveDodo('LIVE').apiBase, 'https://live.dodopayments.com');
  assert.strictEqual(resolveDodo('staging').apiBase, 'https://live.dodopayments.com');
});

test('resolveDodo honours an explicit test mode, with its own product ids', () => {
  const cfg = resolveDodo('test');
  assert.strictEqual(cfg.apiBase, 'https://test.dodopayments.com');
  assert.deepStrictEqual(Object.values(cfg.products).sort(), ['lifetime', 'monthly']);
  assert.notDeepStrictEqual(Object.keys(cfg.products), Object.keys(resolveDodo('live').products));
});

// ── Key casing ────────────────────────────────────────────────────────────────

test('dodoKeyCandidates yields one candidate for an already-uppercase key', () => {
  assert.deepStrictEqual(dodoKeyCandidates(' ABC-123 '), ['ABC-123']);
});

test('dodoKeyCandidates adds an uppercase retry for a mixed-case key', () => {
  assert.deepStrictEqual(dodoKeyCandidates('abc-123'), ['abc-123', 'ABC-123']);
});

// ── Request builders ──────────────────────────────────────────────────────────

test('buildDodoActivateRequest posts license_key + name, no auth header', () => {
  const { url, options } = buildDodoActivateRequest('https://live.dodopayments.com', DODO_KEY, 'uid32');
  assert.strictEqual(url, 'https://live.dodopayments.com/licenses/activate');
  assert.strictEqual(options.method, 'POST');
  assert.strictEqual(options.headers.Authorization, undefined);
  assert.deepStrictEqual(JSON.parse(options.body), { license_key: DODO_KEY, name: 'uid32' });
});

test('buildDodoValidateRequest includes the instance id only when present', () => {
  const withInstance = buildDodoValidateRequest('https://live.dodopayments.com', DODO_KEY, 'lki_9');
  assert.deepStrictEqual(JSON.parse(withInstance.options.body), {
    license_key: DODO_KEY,
    license_key_instance_id: 'lki_9',
  });
  const without = buildDodoValidateRequest('https://live.dodopayments.com', DODO_KEY, undefined);
  assert.deepStrictEqual(JSON.parse(without.options.body), { license_key: DODO_KEY });
});

test('buildDodoDeactivateRequest targets the instance it should release', () => {
  const { url, options } = buildDodoDeactivateRequest('https://live.dodopayments.com', DODO_KEY, 'lki_9');
  assert.strictEqual(url, 'https://live.dodopayments.com/licenses/deactivate');
  assert.deepStrictEqual(JSON.parse(options.body), {
    license_key: DODO_KEY,
    license_key_instance_id: 'lki_9',
  });
});

// ── Activation classifier ─────────────────────────────────────────────────────

test('classifyDodoActivation maps each product id to its tier', () => {
  assert.deepStrictEqual(
    classifyDodoActivation(201, { id: 'lki_1', product: { product_id: LIVE_MONTHLY } }, PRODUCTS),
    { outcome: 'activated', tier: 'monthly', instanceId: 'lki_1' }
  );
  assert.deepStrictEqual(
    classifyDodoActivation(200, { id: 'lki_2', product: { product_id: LIVE_LIFETIME } }, PRODUCTS),
    { outcome: 'activated', tier: 'lifetime', instanceId: 'lki_2' }
  );
});

test("classifyDodoActivation refuses another product's valid Dodo key", () => {
  // Dodo's activate endpoint is global: a Claude Project Downloader key really
  // does activate here. Accepting it would unlock Skool Pro for free.
  assert.deepStrictEqual(
    classifyDodoActivation(201, { id: 'lki_3', product: { product_id: 'pdt_0NjqpWNLVLdjhXm2sDTtG' } }, PRODUCTS),
    { outcome: 'wrong_product', instanceId: 'lki_3' }
  );
});

test('classifyDodoActivation refuses a success body with no product at all', () => {
  assert.deepStrictEqual(
    classifyDodoActivation(201, { id: 'lki_4' }, PRODUCTS),
    { outcome: 'wrong_product', instanceId: 'lki_4' }
  );
  assert.deepStrictEqual(
    classifyDodoActivation(201, null, PRODUCTS),
    { outcome: 'wrong_product', instanceId: null }
  );
});

test('classifyDodoActivation: 404 falls back to Freemius', () => {
  assert.deepStrictEqual(classifyDodoActivation(404, { error: 'not_found' }, PRODUCTS), { outcome: 'fallback' });
});

test('classifyDodoActivation: 403/422 are hard errors, never a Freemius retry', () => {
  assert.deepStrictEqual(classifyDodoActivation(403, {}, PRODUCTS), { outcome: 'error', error: 'license_inactive' });
  assert.deepStrictEqual(classifyDodoActivation(422, {}, PRODUCTS), { outcome: 'error', error: 'activation_limit' });
});

test('classifyDodoActivation: Dodo being broken falls back rather than failing', () => {
  for (const status of [429, 500, 502, 503]) {
    assert.deepStrictEqual(classifyDodoActivation(status, null, PRODUCTS), { outcome: 'fallback' }, `status ${status}`);
  }
});

// ── Validation classifier ─────────────────────────────────────────────────────

test('classifyDodoValidation reads Dodo verdicts', () => {
  assert.deepStrictEqual(classifyDodoValidation(200, { valid: true }), { outcome: 'valid' });
  assert.deepStrictEqual(classifyDodoValidation(200, { valid: false }), { outcome: 'invalid' });
  assert.deepStrictEqual(classifyDodoValidation(404, {}), { outcome: 'invalid' });
  assert.deepStrictEqual(classifyDodoValidation(403, {}), { outcome: 'invalid' });
});

test('classifyDodoValidation treats anything unreadable as indeterminate', () => {
  // Never revoke a paying customer because a provider had a bad minute.
  assert.deepStrictEqual(classifyDodoValidation(200, null), { outcome: 'indeterminate' });
  assert.deepStrictEqual(classifyDodoValidation(200, { valid: 'yes' }), { outcome: 'indeterminate' });
  assert.deepStrictEqual(classifyDodoValidation(429, {}), { outcome: 'indeterminate' });
  assert.deepStrictEqual(classifyDodoValidation(500, {}), { outcome: 'indeterminate' });
});

// ── Worker fetch handler ──────────────────────────────────────────────────────
// Stubs global fetch so the two-provider ordering is exercised end to end.

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    const result = await handler(String(url), options, calls.length);
    if (result instanceof Error) throw result;
    const { status = 200, body = {} } = result || {};
    return { status, ok: status < 400, json: async () => body };
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

function post(path, body) {
  return new Request(`https://skool-dl-license.workers.dev${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('activate: a Dodo lifetime key resolves its tier and never touches Freemius', async () => {
  const stub = stubFetch(() => ({
    status: 201,
    body: { id: 'lki_live', product: { product_id: LIVE_LIFETIME } },
  }));
  try {
    const res = await worker.fetch(post('/activate-license', { licenseKey: DODO_KEY, installId: INSTALL_ID }), {});
    assert.deepStrictEqual(await res.json(), {
      valid: true,
      tier: 'lifetime',
      source: 'dodo',
      instanceId: 'lki_live',
      licenseKey: DODO_KEY,
    });
    assert.strictEqual(stub.calls.length, 1);
    assert.ok(!stub.calls.some((c) => c.url.includes('freemius')), 'must not call Freemius');
  } finally {
    stub.restore();
  }
});

test('activate: an unknown-to-Dodo short key falls through to Freemius', async () => {
  const stub = stubFetch((url, _options, n) => {
    if (url.includes('dodopayments')) return { status: 404, body: {} };
    if (url.includes('licenses/activate.json')) {
      return { status: 200, body: { install_id: '77', install_api_token: 'tok' } };
    }
    return { status: 200, body: { is_lifetime: false, expiration: '2026-12-01' }, n };
  });
  try {
    const res = await worker.fetch(
      post('/activate-license', { licenseKey: 'LEGACYKEY123', installId: INSTALL_ID }),
      { FREEMIUS_SECRET_KEY: 'sk_test' }
    );
    assert.deepStrictEqual(await res.json(), { valid: true, tier: 'monthly', source: 'freemius' });
    assert.ok(stub.calls.some((c) => c.url.includes('api.freemius.com')), 'should reach Freemius');
  } finally {
    stub.restore();
  }
});

test('activate: Freemius receives the key uppercased, as it always has', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('dodopayments')) return { status: 404, body: {} };
    return { status: 200, body: { error: { code: 'license_activated' } } };
  });
  try {
    await worker.fetch(
      post('/activate-license', { licenseKey: 'legacykey123', installId: INSTALL_ID }),
      { FREEMIUS_SECRET_KEY: 'sk_test' }
    );
    const freemiusCall = stub.calls.find((c) => c.url.includes('api.freemius.com'));
    assert.strictEqual(freemiusCall.body.license_key, 'LEGACYKEY123');
  } finally {
    stub.restore();
  }
});

test('activate: an over-length key that Dodo rejected is not shown to Freemius', async () => {
  const stub = stubFetch(() => ({ status: 404, body: {} }));
  try {
    const res = await worker.fetch(
      post('/activate-license', { licenseKey: `${DODO_KEY}-EXTRA-LONG-TAIL`, installId: INSTALL_ID }),
      { FREEMIUS_SECRET_KEY: 'sk_test' }
    );
    assert.deepStrictEqual(await res.json(), { valid: false, error: 'unknown_key' });
    assert.ok(!stub.calls.some((c) => c.url.includes('freemius')), 'Freemius would only add a confusing error');
  } finally {
    stub.restore();
  }
});

test("activate: another product's Dodo key is refused and its seat released", async () => {
  const stub = stubFetch((url) => {
    if (url.endsWith('/licenses/activate')) {
      return { status: 201, body: { id: 'lki_cpd', product: { product_id: 'pdt_0NjqpWNLVLdjhXm2sDTtG' } } };
    }
    return { status: 200, body: {} };
  });
  try {
    const res = await worker.fetch(post('/activate-license', { licenseKey: DODO_KEY, installId: INSTALL_ID }), {});
    assert.deepStrictEqual(await res.json(), { valid: false, error: 'wrong_product' });
    const deactivate = stub.calls.find((c) => c.url.endsWith('/licenses/deactivate'));
    assert.ok(deactivate, 'should release the instance it just created');
    assert.strictEqual(deactivate.body.license_key_instance_id, 'lki_cpd');
  } finally {
    stub.restore();
  }
});

test('activate: a cancelled Dodo subscription is a hard error, not a Freemius retry', async () => {
  const stub = stubFetch(() => ({ status: 403, body: {} }));
  try {
    const res = await worker.fetch(post('/activate-license', { licenseKey: DODO_KEY, installId: INSTALL_ID }), {});
    assert.deepStrictEqual(await res.json(), { valid: false, error: 'license_inactive' });
    assert.strictEqual(stub.calls.length, 1, 'no casing retry after a definitive verdict');
  } finally {
    stub.restore();
  }
});

test('activate: a mixed-case Dodo key is retried uppercase and stored canonically', async () => {
  const stub = stubFetch((_url, _options, n) => (
    n === 1
      ? { status: 404, body: {} }
      : { status: 201, body: { id: 'lki_up', product: { product_id: LIVE_MONTHLY } } }
  ));
  try {
    const res = await worker.fetch(
      post('/activate-license', { licenseKey: DODO_KEY.toLowerCase(), installId: INSTALL_ID }),
      {}
    );
    const payload = await res.json();
    assert.strictEqual(payload.valid, true);
    assert.strictEqual(payload.licenseKey, DODO_KEY, 'returns the casing Dodo accepted');
    assert.strictEqual(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test('validate: dispatches on the stored source, never guessing', async () => {
  const stub = stubFetch(() => ({ status: 200, body: { valid: true } }));
  try {
    await worker.fetch(
      post('/validate-license', { licenseKey: DODO_KEY, installId: INSTALL_ID, source: 'dodo', instanceId: 'lki_1' }),
      {}
    );
    assert.strictEqual(stub.calls.length, 1);
    assert.ok(stub.calls[0].url.endsWith('/licenses/validate'));
    assert.strictEqual(stub.calls[0].body.license_key_instance_id, 'lki_1');
  } finally {
    stub.restore();
  }
});

test('validate: an install with no stored source stays on Freemius', async () => {
  // Every install upgrading from v1.2.0 looks like this. Probing Dodo with a
  // Freemius key would be pointless at best.
  const stub = stubFetch(() => ({ status: 200, body: { error: { code: 'license_activated' } } }));
  try {
    const res = await worker.fetch(
      post('/validate-license', { licenseKey: 'LEGACYKEY123', installId: INSTALL_ID }),
      { FREEMIUS_SECRET_KEY: 'sk_test' }
    );
    assert.deepStrictEqual(await res.json(), { valid: true, source: 'freemius' });
    assert.ok(stub.calls[0].url.includes('api.freemius.com'));
  } finally {
    stub.restore();
  }
});

test('validate: Dodo saying valid:false revokes (that is how a lapsed sub reads)', async () => {
  const stub = stubFetch(() => ({ status: 200, body: { valid: false } }));
  try {
    const res = await worker.fetch(
      post('/validate-license', { licenseKey: DODO_KEY, installId: INSTALL_ID, source: 'dodo', instanceId: 'lki_1' }),
      {}
    );
    assert.deepStrictEqual(await res.json(), { valid: false, error: 'license_inactive' });
  } finally {
    stub.restore();
  }
});

test('validate: an unreachable provider keeps the customer paid (both providers)', async () => {
  const dodoStub = stubFetch(() => new Error('socket hang up'));
  try {
    const res = await worker.fetch(
      post('/validate-license', { licenseKey: DODO_KEY, installId: INSTALL_ID, source: 'dodo' }),
      {}
    );
    const payload = await res.json();
    assert.strictEqual(payload.valid, true, 'v1.2.0 clients only read `valid` — must not revoke');
    assert.strictEqual(payload.indeterminate, true);
  } finally {
    dodoStub.restore();
  }

  const freemiusStub = stubFetch(() => new Error('socket hang up'));
  try {
    const res = await worker.fetch(
      post('/validate-license', { licenseKey: 'LEGACYKEY123', installId: INSTALL_ID }),
      { FREEMIUS_SECRET_KEY: 'sk_test' }
    );
    const payload = await res.json();
    assert.strictEqual(payload.valid, true);
    assert.strictEqual(payload.indeterminate, true);
  } finally {
    freemiusStub.restore();
  }
});

test('validate: a Dodo 5xx is indeterminate, not a revocation', async () => {
  const stub = stubFetch(() => ({ status: 503, body: {} }));
  try {
    const res = await worker.fetch(
      post('/validate-license', { licenseKey: DODO_KEY, installId: INSTALL_ID, source: 'dodo' }),
      {}
    );
    const payload = await res.json();
    assert.strictEqual(payload.valid, true);
    assert.strictEqual(payload.indeterminate, true);
  } finally {
    stub.restore();
  }
});

test('both endpoints reject missing params, and unknown routes 404', async () => {
  for (const path of ['/activate-license', '/validate-license']) {
    const res = await worker.fetch(post(path, { installId: INSTALL_ID }), {});
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(await res.json(), { valid: false, error: 'missing_params' });
  }
  const res = await worker.fetch(post('/nope', {}), {});
  assert.strictEqual(res.status, 404);
});
