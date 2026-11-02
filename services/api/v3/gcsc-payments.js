/**
 * GCSC Secure Payments — NMI Sandbox + Dwolla payout module (YC MVP).
 *
 * Zero external dependencies (Node.js built-ins only), matching the style of
 * services/api/v3/pure-server.js. This module is ADDITIVE: it does not modify
 * pure-server.js. Mount it from any HTTP server, or run it standalone:
 *
 *   node services/api/v3/gcsc-payments.js   # serves on GCSC_PAYMENTS_PORT || 10001
 *
 * Mount snippet (top of your HTTP request handler):
 *   const gcscPayments = require('./gcsc-payments');
 *   if (gcscPayments.handle(req, res)) return; // true = request handled here
 *
 * TWO LEGS OF MONEY (do not confuse them):
 *   Leg 1 — fiat, LIVE in MVP: NMI gateway (card payments in, white-labeled as
 *     "GCSC Secure Payments") and Dwolla (bank ACH / FedNow payouts out).
 *     This is real dollars moving through regulated rails.
 *   Leg 2 — XPR rails, FLAGGED OFF for the YC MVP (ENABLE_XPR=false):
 *     the product wording is "Built on XPR Network rails" only. This module
 *     contains NO XPR code paths and claims NO on-chain escrow. When the flag
 *     is off, every payment below runs in fiat/mock mode only.
 *
 * MOCK vs REAL (honest by design):
 *   - No NMI_SANDBOX_API_KEY set  -> create-checkout returns HTTP 200 with
 *     mock:true and a mock checkout reference. Nothing reaches NMI.
 *   - No DWOLLA_API_KEY set       -> dwolla-payout returns HTTP 200 with
 *     mock:true and a mock transfer reference. Nothing reaches Dwolla.
 *   - With keys set, the real sandbox endpoints are called and a non-2xx
 *     response is reported as an error, never disguised as success.
 *   - NO live money ever moves through this module: NMI sandbox and Dwolla
 *     sandbox only, and the mock path moves nothing at all.
 *
 * FIGURES: amounts and scores used in the demo flow ($199 lead, $12.5k
 * milestone, reputation 847 -> 848, 92% confidence) are DRAFTS from the
 * project MD, NOT owner-confirmed facts. They are labeled [DRAFT] wherever
 * they appear in responses and docs.
 *
 * ENV contract:
 *   ENABLE_XPR=false            (default false; must stay false for YC MVP)
 *   NMI_SANDBOX_API_KEY         (optional; unset = mock mode)
 *   DWOLLA_API_KEY              (optional; unset = mock mode)
 *   DWOLLA_API_BASE             (optional; default https://api-sandbox.dwolla.com)
 *   DWOLLA_SOURCE_URL           (optional; required for real Dwolla transfers)
 *   DWOLLA_DESTINATION_URL      (optional; required for real Dwolla transfers)
 *   GCSC_MERCHANT_NAME          (default "Alpha Lux Renovations, Everett WA")
 *   GCSC_PAYMENTS_PORT          (standalone server port; default 10001)
 */

'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const MERCHANT_NAME = process.env.GCSC_MERCHANT_NAME || 'Alpha Lux Renovations, Everett WA';
const ENABLE_XPR = process.env.ENABLE_XPR === 'true'; // default false
const NMI_SANDBOX_CHECKOUT_URL = 'https://sandbox.nmi.com/api/v4/checkout';
const DWOLLA_API_BASE = (process.env.DWOLLA_API_BASE || 'https://api-sandbox.dwolla.com').replace(/\/$/, '');

// In-memory escrow ledger for the YC MVP demo/test flow. This is NOT a
// production ledger: a managed database must replace it before real money.
const escrows = new Map(); // escrowId -> record

function randomRef(prefix) {
  return prefix + '-' + crypto.randomBytes(8).toString('hex');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function validateAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return 'amount must be a positive number';
  }
  if (Math.round(amount * 100) !== amount * 100) {
    return 'amount must have at most 2 decimal places';
  }
  return null;
}

function httpsPostJson(url, headers, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(payload);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers),
      timeout: timeoutMs || 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Upstream timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * POST /api/v3/payments/create-checkout
 * Body: { amount, currency?, milestone?, projectId?, escrowId?, hold? }
 * GCSC-branded white-label checkout. When body.hold is true and an escrowId
 * is given, the funded amount is recorded as HELD in the escrow ledger.
 */
async function createCheckout(body) {
  const amountError = validateAmount(body.amount);
  if (amountError) return { status: 400, payload: { ok: false, error: amountError } };

  const key = process.env.NMI_SANDBOX_API_KEY;
  const base = {
    ok: true,
    provider: 'nmi-sandbox',
    gateway_title: 'GCSC Secure Payments',
    white_label: true,
    merchant: MERCHANT_NAME,
    amount: body.amount,
    currency: body.currency || 'USD',
    milestone: body.milestone || null,
    projectId: body.projectId || null,
    rails: 'Built on XPR Network rails',
    rails_enabled: false, // ENABLE_XPR is false for the YC MVP
    xpr_flag: 'ENABLE_XPR=false',
  };

  let result;
  if (!key) {
    result = Object.assign({}, base, {
      mock: true,
      checkout_reference: randomRef('mock-nmi-checkout'),
      note: 'Mock mode: NMI_SANDBOX_API_KEY is not set; nothing was sent to NMI.',
    });
  } else {
    try {
      const upstream = await httpsPostJson(NMI_SANDBOX_CHECKOUT_URL,
        { Authorization: 'Bearer ' + key },
        {
          custom_gateway_title: 'GCSC Secure Payments',
          white_label: true,
          amount: body.amount,
          currency: body.currency || 'USD',
          merchant: MERCHANT_NAME,
          description: body.milestone ? ('GCSC milestone: ' + body.milestone) : 'GCSC milestone payment',
          metadata: { projectId: body.projectId || null, escrowId: body.escrowId || null },
        });
      if (upstream.status < 200 || upstream.status >= 300) {
        return { status: 502, payload: { ok: false, mock: false, provider: 'nmi-sandbox', error: 'NMI sandbox returned HTTP ' + upstream.status, upstream_body: upstream.body.slice(0, 500) } };
      }
      let parsed = null;
      try { parsed = JSON.parse(upstream.body); } catch (e) { /* keep raw */ }
      result = Object.assign({}, base, {
        mock: false,
        checkout_reference: (parsed && (parsed.checkout_id || parsed.id || parsed.reference)) || randomRef('nmi-checkout'),
        upstream_status: upstream.status,
      });
    } catch (e) {
      return { status: 502, payload: { ok: false, mock: false, provider: 'nmi-sandbox', error: 'NMI sandbox call failed: ' + e.message } };
    }
  }

  if (body.hold && body.escrowId) {
    const existing = escrows.get(body.escrowId) || {
      escrowId: body.escrowId, held: 0, released: 0, status: 'HELD', events: [],
    };
    existing.held += body.amount;
    existing.status = 'HELD';
    existing.events.push({ type: 'funded', amount: body.amount, mock: result.mock, at: new Date().toISOString() });
    escrows.set(body.escrowId, existing);
    result.escrow = { escrowId: body.escrowId, held: existing.held, status: existing.status };
  }
  return { status: 200, payload: result };
}

/**
 * POST /api/v3/payments/dwolla-payout
 * Body: { amount, escrowId?, milestone?, destination? }
 * Contractor payout via Dwolla (A2A / FedNow rails). Same mock/real pattern.
 * Real mode additionally requires DWOLLA_SOURCE_URL and
 * DWOLLA_DESTINATION_URL; without them it fails honestly instead of faking
 * a transfer.
 */
async function dwollaPayout(body) {
  const amountError = validateAmount(body.amount);
  if (amountError) return { status: 400, payload: { ok: false, error: amountError } };

  const key = process.env.DWOLLA_API_KEY;
  const base = {
    ok: true,
    provider: 'dwolla-sandbox',
    rails: 'Dwolla A2A / FedNow (bank payout)',
    merchant: MERCHANT_NAME,
    amount: body.amount,
    milestone: body.milestone || null,
    escrowId: body.escrowId || null,
    xpr_flag: 'ENABLE_XPR=false',
  };

  let result;
  if (!key) {
    result = Object.assign({}, base, {
      mock: true,
      transfer_reference: randomRef('mock-dwolla-transfer'),
      note: 'Mock mode: DWOLLA_API_KEY is not set; nothing was sent to Dwolla.',
    });
  } else if (!process.env.DWOLLA_SOURCE_URL || !process.env.DWOLLA_DESTINATION_URL) {
    return { status: 500, payload: { ok: false, mock: false, provider: 'dwolla-sandbox', error: 'DWOLLA_API_KEY is set but DWOLLA_SOURCE_URL / DWOLLA_DESTINATION_URL are not configured; refusing to fake a transfer.' } };
  } else {
    try {
      const upstream = await httpsPostJson(DWOLLA_API_BASE + '/transfers',
        { Authorization: 'Bearer ' + key, Accept: 'application/vnd.dwolla.v1.hal+json' },
        {
          _links: {
            source: { href: process.env.DWOLLA_SOURCE_URL },
            destination: { href: process.env.DWOLLA_DESTINATION_URL },
          },
          amount: { currency: 'USD', value: body.amount.toFixed(2) },
        });
      if (upstream.status < 200 || upstream.status >= 300) {
        return { status: 502, payload: { ok: false, mock: false, provider: 'dwolla-sandbox', error: 'Dwolla sandbox returned HTTP ' + upstream.status, upstream_body: upstream.body.slice(0, 500) } };
      }
      result = Object.assign({}, base, {
        mock: false,
        transfer_reference: randomRef('dwolla-transfer'),
        upstream_status: upstream.status,
      });
    } catch (e) {
      return { status: 502, payload: { ok: false, mock: false, provider: 'dwolla-sandbox', error: 'Dwolla sandbox call failed: ' + e.message } };
    }
  }

  if (body.escrowId) {
    const existing = escrows.get(body.escrowId);
    if (existing) {
      existing.released += body.amount;
      existing.status = existing.released >= existing.held ? 'RELEASED' : 'PARTIALLY_RELEASED';
      existing.events.push({ type: 'released', amount: body.amount, mock: result.mock, at: new Date().toISOString() });
      result.escrow = { escrowId: body.escrowId, held: existing.held, released: existing.released, status: existing.status };
    }
  }
  return { status: 200, payload: result };
}

/** GET /api/v3/payments/escrow?id=<escrowId> — read-only ledger lookup. */
function getEscrow(escrowId) {
  const rec = escrows.get(escrowId);
  if (!rec) return { status: 404, payload: { ok: false, error: 'Unknown escrowId' } };
  return { status: 200, payload: { ok: true, escrow: rec } };
}

/** GET /api/v3/payments/health — module health + mode report. */
function health() {
  return {
    status: 200,
    payload: {
      ok: true,
      service: 'gcsc-payments',
      merchant: MERCHANT_NAME,
      enable_xpr: ENABLE_XPR,
      rails_wording: 'Built on XPR Network rails',
      nmi_mode: process.env.NMI_SANDBOX_API_KEY ? 'real-sandbox' : 'mock',
      dwolla_mode: process.env.DWOLLA_API_KEY ? 'real-sandbox' : 'mock',
      live_money: false,
    },
  };
}

/**
 * Route dispatcher. Returns true when the request was handled (callers
 * should `return` after a true). Returns false for any other path/method.
 */
async function handle(req, res) {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (e) {
    return false;
  }
  if (req.method === 'GET' && pathname === '/api/v3/payments/health') {
    const r = health();
    sendJson(res, r.status, r.payload);
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/v3/payments/escrow') {
    let id = '';
    try { id = new URL(req.url, 'http://localhost').searchParams.get('id') || ''; } catch (e) { /* ignore */ }
    const r = getEscrow(id);
    sendJson(res, r.status, r.payload);
    return true;
  }
  if (req.method === 'POST' && (pathname === '/api/v3/payments/create-checkout' || pathname === '/api/v3/payments/dwolla-payout')) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
      return true;
    }
    const r = pathname === '/api/v3/payments/create-checkout'
      ? await createCheckout(body)
      : await dwollaPayout(body);
    sendJson(res, r.status, r.payload);
    return true;
  }
  return false;
}

if (require.main === module) {
  const port = parseInt(process.env.GCSC_PAYMENTS_PORT || '10001', 10);
  const server = http.createServer((req, res) => {
    handle(req, res).then((handled) => {
      if (!handled) sendJson(res, 404, { ok: false, error: 'Not found' });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  });
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log('GCSC Secure Payments listening on port ' + port + ' (ENABLE_XPR=' + ENABLE_XPR + ')');
  });
}

module.exports = { handle, createCheckout, dwollaPayout, getEscrow, health, escrows };
