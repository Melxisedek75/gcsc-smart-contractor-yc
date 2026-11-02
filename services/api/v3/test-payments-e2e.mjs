#!/usr/bin/env node
/**
 * GCSC Secure Payments — end-to-end test transaction proof.
 *
 * Proves the YC MVP demo flow over real HTTP against
 * services/api/v3/gcsc-payments.js (standalone server mode):
 *
 *   homeowner voice+photos job ("kitchen remodel mold", 4 photos)
 *     -> AI scope 2.3s (drywall 1200 sqft, risk map red/yellow/green,
 *        CMA $12.5k, 92%) [DRAFT figures]
 *     -> Alpha Lux Renovations (Everett WA) buys lead $199 [DRAFT],
 *        reputation 847 locked [DRAFT]
 *     -> escrow NMI sandbox $12.5k HELD [DRAFT]
 *     -> SMS monitoring ON (flag + event log; NO real SMS is sent by this
 *        script — Twilio is not wired into gcsc-payments.js)
 *     -> milestone drywall proof -> approved SMS (event log)
 *     -> Dwolla release $6k [DRAFT] -> final $6.5k [DRAFT]
 *     -> reputation 848 (+1) [DRAFT]
 *
 * Run:  node services/api/v3/test-payments-e2e.mjs
 * Env:  ENABLE_XPR=false (forced by this script for the child server).
 *       Leave NMI_SANDBOX_API_KEY / DWOLLA_API_KEY UNSET for mock mode.
 *       With keys set, the same script reports real-sandbox mode per step.
 *
 * Exit code: 0 only if every HTTP call returned 200 and the escrow ledger
 * ends HELD 12500 / RELEASED 12500. Anything else exits 1 and prints the
 * failing step. Mock vs real is printed per step — never hidden.
 *
 * NO live money moves here: NMI sandbox / Dwolla sandbox at most, mock
 * mode by default. NO credentials are read from or written to any file.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.GCSC_PAYMENTS_PORT || '10099';
const BASE = `http://127.0.0.1:${PORT}`;
const ESCROW_ID = 'escrow-demo-121214';

const rows = [];
function log(step, mode, detail) {
  rows.push({ step, mode, detail });
  console.log(`[${mode}] ${step}: ${detail}`);
}
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  return { status: r.status, body: j };
}
async function get(p) {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json() };
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, 'gcsc-payments.js')], {
    env: { ...process.env, ENABLE_XPR: 'false', GCSC_PAYMENTS_PORT: PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  child.stdout.on('data', (d) => { serverOut += d.toString(); });
  child.stderr.on('data', (d) => { serverOut += d.toString(); });
  const stop = () => { try { child.kill(); } catch { /* already stopped */ } };
  process.on('exit', stop);

  try {
    // Wait for health (up to 10s).
    let healthy = null;
    for (let i = 0; i < 50; i++) {
      try {
        const h = await get('/api/v3/payments/health');
        if (h.status === 200) { healthy = h.body; break; }
      } catch { /* not up yet */ }
      await sleep(200);
    }
    if (!healthy) { fail('server did not become healthy'); return; }
    if (healthy.enable_xpr !== false) { fail('ENABLE_XPR is not false'); return; }
    log('health', healthy.nmi_mode === 'mock' ? 'MOCK' : 'REAL', `nmi=${healthy.nmi_mode} dwolla=${healthy.dwolla_mode} live_money=${healthy.live_money} enable_xpr=${healthy.enable_xpr}`);

    // Step 1: homeowner job intake (local, no endpoint — intake UI lives in apps/web).
    const job = { voice: 'kitchen remodel mold', photos: 4, city: 'Everett WA' };
    log('job-intake', 'LOCAL', `voice="${job.voice}" photos=${job.photos} city=${job.city}`);

    // Step 2: AI scope (2.3s simulated latency, mirroring the SaaS demo).
    const t0 = Date.now();
    await sleep(2300);
    const scope = { drywall_sqft: 1200, risk_map: 'red/yellow/green', cma: 12500, confidence: 0.92 };
    log('ai-scope', 'LOCAL', `took ${Date.now() - t0}ms drywall=${scope.drywall_sqft}sqft cma=$${scope.cma} [DRAFT] confidence=92% [DRAFT] risk_map=${scope.risk_map}`);

    // Step 3: contractor buys the lead ($199 [DRAFT]).
    const lead = await post('/api/v3/payments/create-checkout', {
      amount: 199, milestone: 'lead-purchase', projectId: 'lead-demo-001',
    });
    if (lead.status !== 200 || !lead.body.ok) { fail('lead checkout: ' + JSON.stringify(lead.body)); return; }
    log('buy-lead', lead.body.mock ? 'MOCK' : 'REAL', `$199 [DRAFT] ref=${lead.body.checkout_reference} reputation 847 locked [DRAFT]`);

    // Step 4: homeowner funds the milestone; escrow HELD ($12.5k [DRAFT]).
    const fund = await post('/api/v3/payments/create-checkout', {
      amount: 12500, milestone: 'kitchen-remodel-full', projectId: 'lead-demo-001',
      escrowId: ESCROW_ID, hold: true,
    });
    if (fund.status !== 200 || !fund.body.ok) { fail('milestone funding: ' + JSON.stringify(fund.body)); return; }
    log('escrow-held', fund.body.mock ? 'MOCK' : 'REAL', `$12.5k [DRAFT] ref=${fund.body.checkout_reference} escrow=${JSON.stringify(fund.body.escrow)}`);

    // Step 5: SMS monitoring ON (flag + event log only; no real SMS sent).
    log('sms-monitoring', 'LOCAL', 'ON — event log only; no real SMS sent by this script (Twilio not wired into gcsc-payments.js)');

    // Step 6: milestone proof + approval (event log; approval is a human step).
    log('milestone-proof', 'LOCAL', 'drywall complete: photos + completion note submitted (event log)');
    log('approved-sms', 'LOCAL', 'homeowner approval recorded (event log; human approval, never AI-only release)');

    // Step 7: Dwolla release $6k [DRAFT].
    const rel1 = await post('/api/v3/payments/dwolla-payout', {
      amount: 6000, milestone: 'drywall-complete', escrowId: ESCROW_ID,
    });
    if (rel1.status !== 200 || !rel1.body.ok) { fail('dwolla release 1: ' + JSON.stringify(rel1.body)); return; }
    log('dwolla-release-1', rel1.body.mock ? 'MOCK' : 'REAL', `$6k [DRAFT] ref=${rel1.body.transfer_reference} escrow=${JSON.stringify(rel1.body.escrow)}`);

    // Step 8: final Dwolla release $6.5k [DRAFT].
    const rel2 = await post('/api/v3/payments/dwolla-payout', {
      amount: 6500, milestone: 'final-paint', escrowId: ESCROW_ID,
    });
    if (rel2.status !== 200 || !rel2.body.ok) { fail('dwolla release 2: ' + JSON.stringify(rel2.body)); return; }
    log('dwolla-release-2', rel2.body.mock ? 'MOCK' : 'REAL', `$6.5k [DRAFT] ref=${rel2.body.transfer_reference} escrow=${JSON.stringify(rel2.body.escrow)}`);

    // Step 9: verify the ledger ends fully released.
    const esc = await get(`/api/v3/payments/escrow?id=${ESCROW_ID}`);
    if (esc.status !== 200 || !esc.body.ok) { fail('escrow lookup: ' + JSON.stringify(esc.body)); return; }
    const e = esc.body.escrow;
    log('escrow-final', 'LOCAL', `held=${e.held} released=${e.released} status=${e.status} events=${e.events.length}`);
    if (e.held !== 12500 || e.released !== 12500 || e.status !== 'RELEASED') {
      fail(`ledger mismatch: expected held=12500 released=12500 RELEASED, got held=${e.held} released=${e.released} ${e.status}`);
      return;
    }

    // Step 10: reputation 847 -> 848 (+1) [DRAFT] — demo value, not a ledger field.
    log('reputation', 'LOCAL', '847 -> 848 (+1) [DRAFT] on completed milestone');

    console.log('\nE2E TEST PASSED — all steps HTTP 200, ledger consistent.');
    console.log('Modes: lead/escrow/payouts ran in ' + (lead.body.mock ? 'MOCK' : 'REAL-SANDBOX') + ' mode (see per-step rows above).');
    console.log('NOT verified by this script: real NMI/Dwolla sandbox calls (no keys set), real SMS delivery, apps/web intake UI, pure-server.js mounting.');
  } finally {
    stop();
  }
}

main().catch((e) => { console.error('FAIL: uncaught', e); process.exitCode = 1; });
