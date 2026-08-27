# Oracle Integration Guide

This guide explains how third-party providers can deploy a compatible payer-verification oracle and register it with the Invoice Liquidity Network.

---

## Overview

The ILN payer-verification oracle is an optional on-chain component. When registered, the ILN contract calls it to check whether a payer's identity or creditworthiness has been verified off-chain before allowing invoice funding. See [oracle-design.md](./oracle-design.md) for the full design specification.

---

## Oracle Interface Specification

Any oracle contract must expose two Soroban entry-points:

```rust
// Returns the verification record for `payer`
fn get_verification(env: Env, payer: Address) -> VerificationResult

// Updates the verification status for `payer` (oracle-operator only)
fn update_verification(env: Env, payer: Address, verified: bool)
```

Where `VerificationResult` is a `#[contracttype]` struct:

```rust
#[contracttype]
pub struct VerificationResult {
    pub verified: bool,   // true = payer is verified
    pub timestamp: u64,   // Unix epoch seconds of last update
}
```

The `get_verification` method must never panic under normal conditions. If no record exists for a payer, return `VerificationResult { verified: false, timestamp: 0 }`.

The `update_verification` method should enforce access control (e.g., `require_auth()` for the oracle operator address). The ILN contract never calls this method directly.

---

## Staleness Policy

`fund_invoice`'s `require_oracle_verification` path (the live enforcement point) checks freshness against `max_oracle_age_ledgers`, a per-protocol setting in **ledgers**, not seconds — default `DEFAULT_MAX_ORACLE_AGE_LEDGERS` = 17 280 ledgers, ≈ **24 hours** at 5 seconds/ledger. It's read/set via `get_max_oracle_age()` / `set_max_oracle_age()` (admin-gated, rate-limited to one call per ~10 minutes). Oracle operators must refresh records more often than this window to keep payers passing verification.

`oracle_interface.rs` also defines `ORACLE_STALENESS_THRESHOLD_SECS` (7 days) and an `is_fresh()` helper — this is **legacy/unused**: nothing in `fund_invoice` or any other live code path calls `is_fresh()`. Don't rely on the 7-day figure; it does not reflect enforced behavior. See [oracle-attack-economics.md](oracle-attack-economics.md) for why the actual enforced window matters to attack-cost modeling.

---

## Deploying a Custom Oracle

### Step 1 — Implement the interface

Create a Soroban contract that implements `get_verification` and `update_verification` as shown above. A minimal reference implementation is available in `contracts/tests/mocks/mock_oracle.rs`.

### Step 2 — Deploy to the target network

```sh
stellar contract deploy \
  --wasm oracle.wasm \
  --source <operator-keypair> \
  --network <testnet|mainnet>
```

Note the deployed contract address.

### Step 3 — Register with ILN

The ILN admin must call `set_price_oracle` with the oracle contract address. This is a **separate transaction** after `initialize()`:

```typescript
// Using the Soroban TypeScript SDK
await ilnClient.set_price_oracle({
  oracle: oracleContractAddress,
}, { fee: 100 });
```

Once registered, all subsequent payer-verification checks use the new oracle. There is no delay — the oracle takes effect immediately.

### Step 4 — Populate verification data

The oracle operator calls `update_verification` for each verified payer:

```typescript
await oracleClient.update_verification({
  payer: payerAddress,
  verified: true,
}, { fee: 100 });
```

Refresh records at least every 7 days to stay within the staleness threshold.

---

## Failure Handling

| Situation | ILN Response |
|---|---|
| No oracle registered | All payers pass (fail-open) |
| Oracle returns `verified = false` | Payer check fails |
| Oracle timestamp > 7 days old | Treated as unverified |
| Oracle contract panics | Treated as unverified |

---

## Testing with MockOracle

The mock oracle in `contracts/tests/mocks/mock_oracle.rs` lets you test oracle-dependent behaviour deterministically.

### Basic usage

```rust
// In a test:
#[path = "path/to/mocks/mock_oracle.rs"]
mod mock_oracle;
use mock_oracle::{MockOracle, MockOracleClient};

let env = Env::default();
env.mock_all_auths();
let oracle_id = env.register(MockOracle, ());
let oracle = MockOracleClient::new(&env, &oracle_id);

// Mark a payer as verified
oracle.set_verified(&payer_address, &true);

// Set the oracle timestamp (simulate fresh data)
oracle.set_timestamp(&env.ledger().timestamp());
```

### Simulating stale data

```rust
// Oracle last updated 30 days ago
oracle.set_timestamp(&(env.ledger().timestamp() - 30 * 24 * 60 * 60));
oracle.set_verified(&payer, &true);

// ILN will treat this as unverified because timestamp is stale
let result = iln_client.check_something(&payer);
```

### Simulating oracle failure

```rust
// Arm a one-shot panic
oracle.set_should_panic();

// The next get_verification call panics; ILN treats payer as unverified
```

See `contracts/tests/oracle_integration_test.rs` for complete test examples.

---

## Security Checklist

- [ ] Oracle `update_verification` enforces `require_auth()` for the operator
- [ ] The ILN admin key that calls `set_price_oracle` is protected (hardware wallet / multisig)
- [ ] Consider a governance timelock on oracle registration changes (see [governance.md](./governance.md))
- [ ] Refresh verification records before they exceed 7 days
- [ ] Monitor oracle contract for unexpected upgrades or admin key changes
- [ ] The oracle is a single trust point — evaluate whether multi-oracle quorum is needed for your use case
