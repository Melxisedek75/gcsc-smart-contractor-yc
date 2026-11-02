# GCSC Secure Payments — NMI Sandbox + Dwolla (YC MVP)

Implementation: `services/api/v3/gcsc-payments.js` (zero external dependencies).
Proof: `services/api/v3/test-payments-e2e.mjs` (run it, read the per-step output).

## What this is

The payment leg of the Smart Contractor YC MVP, white-labeled as
**GCSC Secure Payments**. It is ADDITIVE: it does not modify
`services/api/v3/pure-server.js`, which stays untouched (large single API
file, deeply XPR-integrated — rewriting it was out of scope and unsafe).

## Two legs of money (do not confuse them)

- **Leg 1 — fiat, LIVE in MVP:** NMI gateway (card payments in) and Dwolla
  (bank ACH / FedNow payouts out). This is real dollars moving through
  regulated rails.
- **Leg 2 — XPR rails, FLAGGED OFF:** the product wording is
  "Built on XPR Network rails" only. This module contains NO XPR code paths
  and claims NO on-chain escrow. `ENABLE_XPR` must stay `false` for the
  YC MVP.

## ENV contract

```env
ENABLE_XPR=false            # REQUIRED for YC MVP; module runs fiat/mock only
NMI_SANDBOX_API_KEY=        # unset = mock mode for create-checkout
DWOLLA_API_KEY=             # unset = mock mode for dwolla-payout
DWOLLA_API_BASE=https://api-sandbox.dwolla.com   # optional override
DWOLLA_SOURCE_URL=          # required for REAL Dwolla transfers
DWOLLA_DESTINATION_URL=     # required for REAL Dwolla transfers
GCSC_MERCHANT_NAME=Alpha Lux Renovations, Everett WA
GCSC_PAYMENTS_PORT=10001    # standalone server port
```

Note: `services/api/v3/.env.example` was deliberately NOT edited by this
change — its read output redacts values, so a full rewrite could corrupt
the template. Copy the block above into your local `.env` instead.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v3/payments/health` | Mode report: nmi/dwolla mock vs real-sandbox, `enable_xpr`, `live_money: false` |
| POST | `/api/v3/payments/create-checkout` | GCSC-branded white-label checkout (`custom_gateway_title: "GCSC Secure Payments"`, `white_label: true`). Body: `{ amount, currency?, milestone?, projectId?, escrowId?, hold? }`. With `hold: true` + `escrowId`, the amount is recorded HELD in the in-memory escrow ledger. |
| POST | `/api/v3/payments/dwolla-payout` | Contractor payout via Dwolla A2A / FedNow. Body: `{ amount, escrowId?, milestone?, destination? }`. Updates the escrow ledger (PARTIALLY_RELEASED → RELEASED). |
| GET | `/api/v3/payments/escrow?id=<escrowId>` | Read-only ledger lookup. |

Mock vs real, honestly: with no key set, the endpoint returns HTTP 200
with `mock: true` and a mock reference — nothing reaches NMI or Dwolla.
With a key set, the real sandbox endpoint is called
(`https://sandbox.nmi.com/api/v4/checkout`, Dwolla sandbox transfers) and a
non-2xx response is returned as an error, never disguised as success.
Real Dwolla transfers additionally require `DWOLLA_SOURCE_URL` and
`DWOLLA_DESTINATION_URL`; without them the endpoint fails honestly instead
of faking a transfer. **No live money ever moves**: sandbox at most, mock
by default.

## Mounting in pure-server.js

One-line mount at the top of the HTTP request handler (adapt to the
server's actual dispatch shape — this module was not wired in automatically
because pure-server.js was not to be rewritten):

```js
const gcscPayments = require('./gcsc-payments');
// inside the request handler, before other routing:
if (await gcscPayments.handle(req, res)) return; // true = handled here
```

Or run standalone (no pure-server.js needed):

```sh
node services/api/v3/gcsc-payments.js   # port GCSC_PAYMENTS_PORT || 10001
```

## Running the end-to-end test

```sh
node services/api/v3/test-payments-e2e.mjs
```

The script boots the module on a scratch port (10099), runs the full demo
flow over real HTTP, and exits 0 only if every call returns 200 and the
ledger ends HELD 12500 / RELEASED 12500. Per-step output says MOCK or REAL
for every payment call.

Flow proven: homeowner voice+photos job ("kitchen remodel mold", 4 photos)
→ AI scope 2.3s (drywall 1200 sqft, risk map red/yellow/green, CMA $12.5k,
92%) → Alpha Lux Renovations (Everett WA) buys lead $199, reputation 847
locked → escrow NMI sandbox $12.5k HELD → SMS monitoring ON → milestone
drywall proof → approved SMS → Dwolla release $6k → final $6.5k →
reputation 848 (+1).

## What is NOT verified by this change

- Real NMI / Dwolla sandbox calls: no keys exist in this repo or environment,
  so the test ran in MOCK mode. The real code paths are written but
  unexecuted; they need real sandbox keys to be proven.
- Real SMS delivery: the test logs "SMS monitoring ON" as a flag + event
  log only. Twilio is not wired into this module, so no SMS is sent.
- The apps/web intake UI (voice + photo upload) and the pure-server.js
  mount: the test exercises the payments module standalone, not the full
  web app.
- Production readiness: the escrow ledger is in-memory. A managed database
  must replace it before any real money, plus counsel review of
  money-transmitter / escrow rules (see the payments spec).

## Figures label

$199 lead, $12.5k milestone, reputation 847 → 848, 92% confidence, and the
$6k / $6.5k split are **DRAFTS from the project MD, NOT owner-confirmed
facts**. They appear in this demo flow only, labeled [DRAFT], and must not
be presented to YC as verified numbers without the owner's confirmation.
