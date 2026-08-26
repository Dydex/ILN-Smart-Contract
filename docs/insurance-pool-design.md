# Insurance Pool Design — Default Protection for LPs (Issue #123)

**Status:** Design-forward stub (interface + accounting implemented; economics & token settlement are follow-ups)
**Crate:** `contracts/insurance_pool`

## Motivation

Liquidity providers (LPs) who fund invoices bear the risk that a payer
*defaults*. Before mainnet, ILN should offer an **optional** insurance pool that
LPs can buy into for protection: they pay periodic premiums, and if an invoice
they funded defaults, the pool compensates them out of accumulated premiums.

This document describes the contract interface, the stub implementation shipped
in this PR, and the integration with the main `invoice_liquidity` contract.

## Interface

Defined in [`contracts/insurance_pool/src/insurance_interface.rs`] as the
`InsurancePoolInterface` trait (a typed `InsurancePoolInterfaceClient` is
generated for cross-contract calls):

| Method | Auth | Description |
|--------|------|-------------|
| `enroll(lp)` | `lp` | Opt an LP into the program. |
| `is_enrolled(lp) -> bool` | — | Whether `lp` is enrolled. |
| `deposit_premium(lp, amount)` | `lp` | Pay a premium; increases pool balance; auto-enrolls. |
| `claim(invoice_id) -> i128` | admin | Compensate for a defaulted invoice; returns payout. Idempotent per invoice. |
| `get_pool_balance() -> i128` | — | Total pool balance (premiums − payouts). |

Auxiliary views on the contract: `get_premiums_paid(lp)`, `get_coverage()`,
`is_claimed(invoice_id)`, plus `initialize(admin, coverage)`.

### Timelocked admin actions (Issue #542)

Coverage cap changes and admin transfers are sensitive to LPs, so they are
queued behind a `TIMELOCK_DELAY_SECONDS` (3 days) delay rather than applying
immediately:

| Method | Auth | Description |
|--------|------|-------------|
| `propose_coverage_change(new_coverage) -> u64` | admin | Queue a new coverage cap; returns the ledger timestamp (ETA) at which it becomes executable. |
| `execute_coverage_change()` | — | Apply the pending coverage change once its ETA has passed. Callable by anyone. |
| `cancel_coverage_change()` | admin | Cancel a pending coverage change before it executes. |
| `propose_admin_transfer(new_admin) -> u64` | admin | Queue an admin transfer; returns the ETA. |
| `execute_admin_transfer()` | — | Apply the pending admin transfer once its ETA has passed. Callable by anyone. |
| `cancel_admin_transfer()` | admin | Cancel a pending admin transfer before it executes. |
| `get_pending_coverage() -> Option<(i128, u64)>` | — | View the pending coverage proposal, if any. |
| `get_pending_admin() -> Option<(Address, u64)>` | — | View the pending admin proposal, if any. |

Each proposal overwrites any previously pending proposal of the same kind.
`execute_*` is intentionally open to any caller (like `execute_proposal` in
`iln_governance`) since the timelock itself — not caller identity — is the
security boundary once a change has been proposed by the admin.

## Stub semantics (what ships here)

The stub in `contracts/insurance_pool/src/lib.rs` is a **correct, fully-tested**
implementation of the interface with intentionally simplified economics:

- **Accounting, not custody for premiums; real transfers for payouts.**
  `deposit_premium` moves real SAC tokens from the LP into the pool and
  records the amount as pool balance; `claim` transfers real tokens back out.
- **Tiered coverage cap (Issue #528).** `claim` pays
  `min(tiered_coverage(lp), pool_balance)`, where `tiered_coverage(lp)` scales
  the configured flat `coverage` cap by how much the LP has paid in premiums
  over the pool's lifetime — see
  [Tiered coverage boundaries](#tiered-coverage-boundaries-issue-528) below.
- **Idempotency & auth.** Each `invoice_id` can be claimed once; `claim`
  requires the configured admin (the liquidity contract in production).

The crate's test suite (`cargo test -p insurance_pool`) covers initialization,
enrollment, premium accumulation, tiered and balance-capped payouts,
idempotency, the empty-pool and invalid-amount rejection paths, risk-priced
premiums, timelocked admin actions, pool-health estimation, and the
scale/precision boundary checks described below.

### Tiered coverage boundaries (Issue #528)

`get_tiered_coverage(lp)` scales the flat `coverage` cap (set at `initialize`,
adjustable via the timelocked `propose_coverage_change` or the no-timelock
`set_coverage_via_governance`) by how much premium `lp` has paid **over the
pool's lifetime** (`get_premiums_paid(lp)`, cumulative, never decays):

| LP's cumulative premiums paid (as % of `coverage`) | Coverage multiplier | Rationale |
|---|---|---|
| < 10% | 50% | Minimal stake in the pool — reduced protection discourages depositing just enough to qualify. |
| 10% – 25% | 75% | Moderate, ongoing commitment. |
| 25% – 50% | 100% | Full flat-cap protection — the "baseline" tier most LPs should target. |
| ≥ 50% | 150% | Heavy contributors are over-protected relative to the flat cap, since their premiums have materially built up the pool's own solvency. |

Implementation (`contracts/insurance_pool/src/lib.rs::get_tiered_coverage`):
boundaries are computed as `coverage / 10`, `coverage / 4`, `coverage / 2`,
and each branch uses `>=`, so a premium total sitting *exactly* on a
threshold already belongs to the tier above it, not the one below.

This uses **premiums paid**, not pool balance or claim history, as the proxy
for an LP's stake — deliberately simple for the stub. A production version
would likely also weight remaining pool solvency (see
[Follow-up work](#follow-up-work-before-mainnet)) so tier eligibility can't
outrun what the pool can actually pay out.

#### Verified at scale (precision and i128 boundaries)

`tiered_coverage_low/medium/high/very_high_premiums` exercise the four tiers
at the crate's small test-fixture coverage (1_000_000_000 stroops). Three
additional tests confirm the same boundary logic holds at magnitudes the
fixture doesn't reach:

- **`tiered_coverage_boundaries_hold_at_realistic_mainnet_scale`** — re-runs
  all four tiers, and each exact threshold ± 1, across coverage caps from
  $1,000 to $10,000,000 equivalent (assuming 7-decimal stroops, i.e.
  1e10–1e14), including one non-round value, confirming no integer-division
  truncation issue distorts a boundary at realistic magnitudes.
- **`tiered_coverage_resolves_top_tier_with_i128_scale_premiums`** — an LP
  with cumulative premiums near `i128::MAX` (mirroring
  `deposit_premium_at_i128_max_overflows`'s technique) against a
  $10,000,000-equivalent coverage cap still resolves cleanly to the top tier;
  the `>=` threshold comparison itself has no overflow risk regardless of how
  large `premiums_paid` grows, since comparison isn't arithmetic.
- **`tiered_coverage_overflows_past_the_i128_safe_bound`** — the top tier's
  payout, `(coverage * 150) / 100`, requires the intermediate product
  `coverage * 150` to fit in `i128`. That means `coverage` itself must stay
  below `i128::MAX / 150` (≈ 1.13 × 10³⁶ stroops, ≈ 1.13 × 10²⁹ dollars at
  7-decimal stroops) for `get_tiered_coverage` to be computable at all — about
  10²² times the $10,000,000 ceiling exercised above, so this is a
  defensive/theoretical bound rather than an operational concern under any
  sane governance-set coverage cap. Soroban's checked arithmetic panics on
  overflow, and the generated client's `try_*` methods surface that as a
  trapped `Err` rather than corrupting state or silently wrapping — the test
  confirms both that the bound is exactly where the math says it should be
  (safe at `i128::MAX / 150`, erroring just past it) and that governance is
  not expected to enforce an explicit upper bound on `coverage` today.

## Integration with `invoice_liquidity` (Issue #529)

The compensation hook lives on the liquidity contract's default-handling path
(`claim_default`), implemented directly in
`contracts/invoice_liquidity/src/lib.rs`. The design:

1. `invoice_liquidity` depends on the `insurance_pool` crate directly (a
   regular Cargo dependency, not just dev-only) so it can use the generated
   `InsurancePoolInterfaceClient` for typed cross-contract calls. The deployed
   pool address is stored as a new `DataKey::InsurancePool` instance key, set
   via the admin-gated `set_insurance_pool(pool)` / read via
   `get_insurance_pool()`.
2. After a default is confirmed for `invoice_id` (invoice marked `Defaulted`,
   funders refunded their principal), `claim_default` checks whether the
   *claiming* LP (the caller) is enrolled and, if so, attempts to claim on
   their behalf:

```rust
// inside claim_default(), after the principal refund loop:
if let Some(pool_addr) = crate::storage::get_insurance_pool(&env) {
    let pool_client = InsurancePoolInterfaceClient::new(&env, &pool_addr);
    let enrolled = matches!(pool_client.try_is_enrolled(&funder), Ok(Ok(true)));
    if enrolled {
        let (compensated, payout) = match pool_client.try_claim(&invoice_id, &funder) {
            Ok(Ok(payout)) => (true, payout),
            _ => (false, 0),
        };
        env.events().publish(
            (Symbol::new(&env, "insurance_claim_attempted"), invoice.id, funder.clone()),
            InsuranceClaimAttempted { invoice_id: invoice.id, lp: funder.clone(), compensated, payout },
        );
    }
}
```

3. The pool is configured with the liquidity contract's own address as its
   `admin`, so only a genuine confirmed default (the liquidity contract
   authorizing itself) can trigger `claim`. `claim()` transfers the payout
   directly from the pool's balance to the LP — `invoice_liquidity` never
   holds or forwards insurance funds itself.
4. **Graceful degradation**: the pool calls use `try_is_enrolled` /
   `try_claim` rather than the panicking variants. If the pool is paused,
   empty, unreachable, or the invoice was already claimed, `claim_default`
   still completes successfully (the principal refund and status update
   already happened, in the same atomic invocation) — it just reports
   `compensated: false` instead of reverting the whole default over an
   optional insurance top-up.

Tests covering this integration (using the real `insurance_pool` contract,
not a mock) are in `contracts/invoice_liquidity/src/tests_insurance_integration.rs`.

## SDK Integration

The `@iln/sdk` TypeScript package provides convenience methods to interact with the insurance pool:

### Querying pool status

```typescript
import { ILNClient } from "@iln/sdk";
import { Networks } from "@stellar/stellar-sdk";

const client = ILNClient.testnet(mySigner);

const poolBalance = await client.getPoolBalance(
  client.rpc,
  insurancePoolAddress
);

const coverage = await client.getCoverage(
  client.rpc,
  insurancePoolAddress
);

const isEnrolled = await client.isEnrolled(
  client.rpc,
  insurancePoolAddress,
  lpAddress
);

const premiumsPaid = await client.getPremiumsPaid(
  client.rpc,
  insurancePoolAddress,
  lpAddress
);
```

### Convenience methods

The SDK provides shorter method names for common queries:

```typescript
// Convenience wrapper for isEnrolled(...)
const enrolled = await client.isInsuranceEnrolled(
  client.rpc,
  insurancePoolAddress,
  lpAddress
);

// Convenience wrapper for getPremiumsPaid(...)
const premiums = await client.getInsurancePremiums(
  client.rpc,
  insurancePoolAddress,
  lpAddress
);
```

### Querying LP pool info

Fetch enrollment status, pool balance, coverage cap, and premiums paid in one call:

```typescript
const poolInfo = await client.getInsurancePoolInfo(
  client.rpc,
  insurancePoolAddress,
  lpAddress
);

console.log(`
  Enrolled: ${poolInfo.isEnrolled}
  Premiums paid: ${poolInfo.premiumsPaid}
  Pool balance: ${poolInfo.poolBalance}
  Coverage cap: ${poolInfo.coverage}
`);
```

### Enrolling in the pool

```typescript
import { Keypair } from "@stellar/stellar-sdk";

const lp = Keypair.fromSecret(lpSecretKey);
const sourceAccount = await client.rpc.getAccount(lp.publicKey());

const { txHash } = await client.enrollInsurancePool(
  client.rpc,
  insurancePoolAddress,
  lp.publicKey(),
  sourceAccount,
  (tx) => {
    tx.sign(lp);
    return tx;
  }
);

console.log(`Enrolled in insurance pool: ${txHash}`);
```

### Depositing premiums

Auto-enrolls the LP on first payment.

```typescript
const { txHash } = await client.depositInsurancePremium(
  client.rpc,
  insurancePoolAddress,
  lpAddress,
  premiumAmount,
  sourceAccount,
  (tx) => {
    tx.sign(lp);
    return tx;
  }
);

console.log(`Premium deposited: ${txHash}`);
```

### Filing a claim (admin-only)

In production, the `invoice_liquidity` contract is the pool admin and files claims automatically on confirmed defaults. For testing or standalone use:

```typescript
// Only the pool admin can call claim
const adminKeypair = Keypair.fromSecret(adminSecretKey);
const adminAccount = await client.rpc.getAccount(adminKeypair.publicKey());

const { txHash, payout } = await client.claimInsurance(
  client.rpc,
  insurancePoolAddress,
  invoiceId,
  adminAccount,
  (tx) => {
    tx.sign(adminKeypair);
    return tx;
  }
);

console.log(`Claim filed for invoice ${invoiceId}: payout ${payout} stroops`);
```

---

## Follow-up work (before mainnet)

- ~~Real SAC token custody for premiums and payouts.~~ Done (Issue #527).
- ~~Risk-priced premiums and coverage (vs. flat cap).~~ Done (Issue #528) —
  see [Tiered coverage boundaries](#tiered-coverage-boundaries-issue-528).
- Pool solvency guards and payout prioritization across simultaneous defaults
  — tier eligibility (above) is based on premiums paid only and doesn't yet
  weight remaining pool balance, so a pool near-depleted by prior claims could
  still nominally owe a top-tier LP more than it can pay (`claim` does clamp
  the actual payout to `pool_balance`, but tier *eligibility* itself doesn't
  account for solvency).
- Governance parameters (premium schedule, coverage ratio).
- End-to-end integration tests across `invoice_liquidity` ⇄ `insurance_pool`.
