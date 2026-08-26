# Access Control Matrix

## 1. Overview

The ILN-Smart-Contract implements a centralized access-control architecture to guarantee that all protocol operations are properly authorized. By centralizing permissions into shared guards, we achieve:
- **Consistency**: All similar checks behave exactly the same way across different endpoints.
- **Audibility**: Clear, easily reviewable access annotations on every public instruction.
- **Maintainability**: Reduced code duplication by eliminating inline authorization checks.

Security goals include enforcing the principle of least privilege, preventing unauthorized state mutations, and ensuring that any authorization failure immediately returns a deterministic contract error.

## 2. Role Definitions

### Submitter
Represents a freelancer or service provider who submits invoices to the protocol.
- **Can**: Create invoices, update invoices before funding, cancel un-funded invoices, and transfer invoice ownership.
- **Cannot**: Modify another user's invoice, force funding, or alter protocol configuration.

### Payer
The client who owes payment on the submitted invoice.
- **Can**: Pay the invoice (mark paid), file an appeal if a default occurs unfairly.
- **Cannot**: Create an invoice on behalf of a submitter, modify invoice terms, or claim yields.

### LP (Liquidity Provider)
Entities providing liquidity to fund pending invoices.
- **Can**: Join funding queues, fund approved invoices, claim yields, and claim default refunds.
- **Cannot**: Approve themselves without queue resolution, modify invoice terms, or appeal a default.

### Admin
The protocol administrator.
- **Can**: Update fee rates, maximum discount rates, distribution contracts, manage allowed tokens, pause/unpause the protocol, and resolve default appeals.
- **Cannot**: Arbitrarily modify invoice ownership, submit invoices as users without explicit authorization, or drain funds.

### Governance
Reserved for future DAO or multisig control over core parameter changes. Currently delegates to Admin functionality.

### Insurance Pool Admin
Authorized to process default claims against the insurance pool (typically the liquidity contract).
- **Can**: File claims on behalf of defaulted invoices, trigger compensation payouts, and query pool state.
- **Cannot**: Modify enrollment, adjust premium rates, or drain the pool directly.

### Anyone
Publicly accessible read or state-transition functions that do not require specific authorization.
- **Can**: Read contract stats, query scores, resolve fund queues, and expire timed-out invoices.

## 3. Instruction Permission Matrix

| Instruction | Allowed Role(s) | Description |
| ----------- | --------------- | ----------- |
| `initialize` | Anyone | Initializes the contract once |
| `set_admin` | Admin | Updates the contract administrator address |
| `update_fee_rate` | Admin | Sets the protocol fee rate |
| `update_max_discount` | Admin | Updates the maximum allowed discount rate |
| `set_distribution_contract`| Admin | Updates the distribution contract address |
| `add_token` | Admin | Adds a supported token to the protocol |
| `remove_token` | Admin | Removes a supported token |
| `pause` | Admin | Pauses the protocol for emergency |
| `unpause` | Admin | Resumes protocol operations |
| `get_contract_stats` | Anyone | Reads protocol statistics |
| `submit_invoice` | Submitter | Submits a new invoice |
| `update_invoice` | Submitter | Updates an existing un-funded invoice |
| `submit_invoices_batch` | Submitter | Submits multiple invoices |
| `join_fund_queue` | LP | Enqueues intent to fund an invoice |
| `resolve_fund_queue` | Anyone | Selects the LP with highest reputation |
| `fund_invoice` | LP | Funds a pending invoice |
| `transfer_invoice` | Submitter | Transfers ownership of an invoice |
| `cancel_invoice` | Submitter | Cancels an un-funded invoice |
| `expire_invoice` | Anyone | Marks a pending expired invoice as Expired |
| `mark_paid` | Payer | Pays off an invoice |
| `claim_yield` | LP | Claims yield for a paid invoice |
| `claim_default` | LP | Claims refund for a defaulted invoice |
| `appeal_default` | Payer | Appeals an unfair default |
| `resolve_appeal` | Admin | Approves or rejects a default appeal |
| `payer_score` | Anyone | Reads a payer's reputation score |
| `lp_score` | Anyone | Reads an LP's reputation score |
| `suggested_discount_rate` | Anyone | Calculates discount rate based on score |
| `get_invoice` | Anyone | Reads invoice details |
| `get_invoice_count` | Anyone | Reads total invoice count |
| `insurance_pool_enroll` | LP | Opts into default-protection insurance |
| `insurance_pool_deposit_premium` | LP | Pays premium to pool (auto-enrolls) |
| `insurance_pool_claim` | Insurance Pool Admin | Files a claim for a defaulted invoice |
| `insurance_pool_get_balance` | Anyone | Reads current pool balance |
| `insurance_pool_get_coverage` | Anyone | Reads per-claim coverage cap |
| `insurance_pool_is_enrolled` | Anyone | Checks LP enrollment status |
| `insurance_pool_get_premiums_paid` | Anyone | Reads cumulative premiums by LP |

## 4. Insurance Pool Access Control

The insurance pool operates as a separate contract with its own authorization model:

- **Pool Enrollment**: LPs call `enroll()` or implicitly auto-enroll on first premium deposit.
- **Premium Deposits**: Any LP can call `deposit_premium()` to add funds to the pool (requires LP signature).
- **Claims**: Only the configured pool admin (the liquidity contract in production) can call `claim()` to trigger compensation for a confirmed default.
- **Queries**: Pool state (balance, coverage, enrollment, premiums) is publicly readable to support analytics and integrations.

This isolation ensures that the insurance pool cannot be drained except through claims authorized by the main contract, and that no single LP can block others from withdrawing coverage.

### Additional Admin Functions (Dispute Resolution)

| Instruction | Allowed Role(s) | Description |
| ----------- | --------------- | ----------- |
| `resolve_appeal` | Admin | Approves or rejects a default appeal (must call `require_admin`) |
| `resolve_dispute` | Admin | Resolves a dispute on an invoice |
| `auto_resolve_dispute` | Anyone | Auto-resolves a dispute after timeout elapsed |
| `set_min_payer_reputation` | Admin | Sets minimum payer reputation threshold |
| `set_price_oracle` | Admin | Updates the price oracle address |
| `set_max_oracle_age` | Admin | Updates the maximum oracle age |
| `upgrade` | Admin | Emits upgrade event for WASM hash change |
| `update_config` | Admin | Updates reputation and token configuration |

### Governance Contract Admin Functions

| Instruction | Allowed Role(s) | Description |
| ----------- | --------------- | ----------- |
| `set_execution_delay` | Admin | Sets timelock delay for proposal execution |
| `veto_proposal` | Admin | Vetoes an active/passed proposal |
| `set_min_quorum_bps` | ILN Contract | Updates quorum threshold |
| `set_min_proposal_balance` | ILN Contract | Updates minimum proposer balance |
| `disable_veto_power` | ILN Contract | Permanently disables admin veto |

### Insurance Pool Contract Admin Functions

| Instruction | Allowed Role(s) | Description |
| ----------- | --------------- | ----------- |
| `claim` | Admin (liquidity contract) | Files a claim for defaulted invoice |

## 5. Audit Findings (Issue #540)

The following findings were identified and resolved during the access control audit:

### Finding AC-01: Missing `require_admin` in `resolve_appeal`
- **Severity:** High
- **Location:** `contracts/invoice_liquidity/src/lib.rs:resolve_appeal`
- **Description:** The function lacked an explicit `require_admin` guard. Although only the payer of the specific invoice could trigger appeals, the resolution function could be called by anyone, allowing unauthorized state transitions from `Appealed` to `Defaulted`.
- **Resolution:** Added `require_admin(&env)?;` as the first statement in the function body.
- **Commit:** This commit.

### Finding AC-02: All other admin functions properly guarded
- All admin-privileged functions in the Invoice Liquidity, Insurance Pool, and Governance contracts include explicit authorization checks at entry. No additional missing guards were found.

## 6. Rate Limiting Design (Issue #541)

### Rationale

Certain admin operations are sensitive to high-frequency invocation — an attacker who compromises an admin key could rapidly toggle economic parameters to extract value or disrupt protocol operations. Rate limiting introduces a time-based cooldown between successive calls to mitigate this risk.

### Functions with Rate Limiting

| Function | Cooldown | Rationale |
|---|---|---|
| `set_admin` | 720 ledgers (~1h) | Admin key rotation must be slow to allow detection |
| `upgrade` | 1440 ledgers (~2h) | Contract upgrade is the most sensitive operation |
| `update_fee_rate` | 360 ledgers (~30min) | Economic parameter manipulation |
| `update_max_discount` | 360 ledgers (~30min) | Economic parameter manipulation |
| `set_min_payer_reputation` | 360 ledgers (~30min) | Economic parameter manipulation |
| `set_distribution_contract` | 120 ledgers (~10min) | Infrastructure change |
| `set_price_oracle` | 120 ledgers (~10min) | Infrastructure change |
| `set_max_oracle_age` | 120 ledgers (~10min) | Infrastructure change |
| `add_token` | 120 ledgers (~10min) | Token allowlist change |
| `remove_token` | 120 ledgers (~10min) | Token allowlist change |

### Exempt Functions

Emergency functions are not rate-limited so they can be used immediately when a threat is detected:
- `pause`
- `unpause`
- `resolve_appeal`
- `resolve_dispute`

### Implementation

Rate limiting is implemented in `contracts/invoice_liquidity/src/access.rs`:

- `check_rate_limit(env, fn_name, cooldown_ledgers)` checks the last ledger when the function was called. If insufficient ledgers have elapsed, it returns `ContractError::RateLimited`. Otherwise, it records the current ledger as the last call time.
- Storage key: `DataKey::RateLimit(Symbol::new(env, fn_name))` — per-function, instance storage.
- The cooldown is measured in ledgers (not timestamps) to align with Soroban's deterministic execution model.
- At ~5 seconds per ledger: 120 ledgers ≈ 10 min, 360 ≈ 30 min, 720 ≈ 1h, 1440 ≈ 2h.

### Audit Finding RL-01

- **Severity:** Medium
- **Finding:** Several admin functions (`update_fee_rate`, `set_admin`, `upgrade`, etc.) lacked any rate-limiting mechanism, allowing rapid successive calls that could be used to grief the protocol or confuse indexers.
- **Resolution:** Added `check_rate_limit` guard to all sensitive admin functions with appropriate cooldown periods.

## 7. Pause Behavior & Cross-Contract Scope

### Scope of `pause()`

`pause()` sets a single `Paused` flag (see `docs/storage-layout.md`) read by the *invoice_liquidity* contract's own state-changing entry points — `submit_invoice`, `fund_invoice`, `mark_paid`, `claim_yield`, `claim_default`, `appeal_default`, `expire_invoice`, etc. Each checks `is_paused` and returns `ContractError::ContractPaused` before performing any state mutation.

Two categories of operation are explicitly **not** affected by this flag:

1. **Read-only views**, e.g. `get_contract_stats`, `get_invoice`, `payer_score`/`lp_score`, and — the subject of this section — the oracle registry's read surface: `get_oracle_for_token`, `get_oracle_health`, and `check_oracle_health`. These carry no `is_paused` guard by design, so monitoring/keeper tooling can keep observing protocol and oracle state throughout an incident. `check_oracle_health` in particular performs a live cross-contract call to the resolved oracle and persists a health snapshot — this succeeds identically whether the contract is paused or not.
2. **Oracle registry governance mutations** — `register_oracle`, `remove_oracle`, `register_token_oracle`, `remove_token_oracle` (Issue #532). These are gated only by `require_admin`, not `is_paused`. This is intentional: repointing or clearing a misbehaving oracle is itself a common *response* to an incident, and gating it behind an unpause would create a chicken-and-egg problem for governance.

### The cross-contract boundary

The oracle registry tracked here is bookkeeping *inside* invoice_liquidity (which oracle address to query for a given feed type/token) — the oracles it points at are themselves separate deployed contracts, and governance itself typically operates through the separate Governance contract, executing proposals that call back into `register_oracle`/`remove_oracle`. Pausing invoice_liquidity has no effect on either:

- The external oracle contracts continue to serve `get_payer_data` / price queries exactly as before — pausing the consumer does not pause the provider.
- The Governance contract's own proposal lifecycle (`propose`, `vote`, `execute`) is entirely unaware of invoice_liquidity's `Paused` flag; only the *effect* of an executed oracle-config proposal (a call to `register_oracle`/`remove_oracle`) lands here, and, per above, that call itself is not blocked by pause.

In short: **pause halts invoice_liquidity's own funding/settlement mutations only** — it is not a kill switch for oracle reads, oracle governance, or any other contract in the system. `fund_invoice` reflects this correctly: it checks `is_paused` as its very first step, so a paused call never reaches the oracle registry at all (no query, no health write) rather than querying it and silently discarding the result. See `contracts/invoice_liquidity/src/tests_oracle_registry.rs` (`test_get_oracle_for_token_readable_while_paused`, `test_check_oracle_health_readable_while_paused`, `test_fund_invoice_paused_never_reaches_oracle_registry`, `test_oracle_registry_mutations_unaffected_by_core_contract_pause`).

## 8. Security Notes

- **Principle of Least Privilege**: Each instruction relies only on the minimal authority required to execute.
- **Centralized Verification**: Extracted inline logic ensures uniform verification logic and robust testing.
- **Auditability Improvements**: Every guard clearly emits a deterministic `Unauthorized` error instead of panicking, enhancing tracing.
- **Rejection Behavior**: If authorization fails, the protocol safely rejects the mutation without consuming extra gas or altering contract state.
