# ADR-011: Reputation State Source of Truth

**Date:** 2026-08-26  
**Status:** Accepted

## Context

Two crates expose reputation-like state:

1. **`invoice_liquidity`** — protocol SoT: decaying payer/LP scores
   (`ReputationScore`) plus detailed counters (`ReputationProfile`). Updated by
   the live invoice lifecycle (`submit_invoice`, `mark_paid`, `claim_default`,
   appeals, etc.).
2. **`reputation_bonus`** — standalone discount-bonus module with its own
   invoice store and its own `ReputationScore` counters. Updated only by
   *its* `submit_invoice` / `mark_paid` / `handle_default` entry points.

Neither contract reads or writes the other's storage. Integrators and FAQ
copy historically blurred the two, creating a perceived double-counting /
desync risk.

## Decision

**There is no shared reputation ledger and no sync/reconciliation hook.**

| Concern | Rule |
|---------|------|
| Protocol funding, defaults, appeals, min-payer gates | **Only** `invoice_liquidity` reputation |
| Reputation-weighted discount bonus on bonus-module invoices | **Only** `reputation_bonus` reputation |
| Same Stellar address in both contracts | Scores may differ; that is expected |
| Double-counting of one invoice event | Impossible across crates: each event updates only the contract that received the call |

Governance may update `reputation_bonus` *parameters* (`UpdateReputationBonusParams`)
without touching `invoice_liquidity` scores.

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| Unify into a single reputation contract | Large migration; bonus module is intentionally separable (ADR-002) |
| Cross-contract sync / reconciliation | Adds failure modes and instruction cost for no protocol benefit while invoice stores remain separate |
| Make `reputation_bonus` read ILN profiles | Couples bonus rates to ILN decay/penalty semantics that the bonus module does not use |

## Consequences

**Positive:**
- Clear SoT for auditors and indexers: query ILN for protocol reputation.
- No silent desync of a shared counter — there is nothing to keep in sync.
- Isolation test (`test_reputation_state_is_independent_across_contracts`) locks the relationship in CI.

**Negative / Trade-offs:**
- Address-level scores can diverge if an actor uses both products; UIs must label which contract a score came from.
- FAQ / docs must not claim protocol reputation lives in `reputation_bonus`.
