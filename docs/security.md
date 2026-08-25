# ILN Security Policy

ILN spans Soroban smart contracts, a TypeScript SDK, a CLI, an indexer, and a notifications service. This policy explains what to report, how to report it, and how maintainers triage and respond.

## Scope

| Component | In scope | Primary references |
|-----------|----------|--------------------|
| Soroban contracts | Authorization, accounting, settlement, storage, upgrade, and governance defects | [contracts](../contracts), [Threat Model](threat-model.md), [Access Control](access-control.md), [Upgrade Guide](upgrade-guide.md) |
| SDK | XDR encoding, transaction construction, signing flow, contract ID handling, and client-side validation defects | [sdk](../sdk), [SDK Integration](sdk-integration.md) |
| CLI | Wallet profile handling, local secret storage, command validation, and network configuration defects | [cli](../cli), [CLI README](../cli/README.md) |
| Indexer | API behavior, event ingestion, database handling, cache safety, and denial-of-service exposure | [indexer](../indexer) |
| Notifications | Webhook subscription handling, HMAC signing, SSRF defenses, rate limiting, and circuit breaker behavior | [notifications](../notifications), [webhook verification](webhook-verification.md) |
| CI/CD and deployment scripts | Secret handling, deployment correctness, artifact integrity, and release automation | [.github/workflows](../.github/workflows), [scripts](../scripts) |

Out of scope: spam, social engineering, physical attacks, attacks requiring compromised maintainer machines, and findings that only affect unsupported local configurations without a protocol or user-impact path.

## Vulnerability Classes

### Soroban Contracts

- Missing or incorrect authorization checks.
- Reentrancy-like control-flow mistakes across contract calls or token transfers.
- Storage key collision, stale storage, or incorrect storage lifetime handling.
- Incorrect invoice state transitions, settlement math, discount-rate math, or reputation updates.
- Governance bypasses, quorum mistakes, timelock bypasses, or unsafe upgrade paths.
- SAC integration mistakes, token decimal assumptions, or trustline-related accounting errors.
- Denial-of-service paths that permanently block valid invoice, settlement, or governance actions.

### SDK

- Incorrect XDR encoding or decoding that changes contract arguments or return values.
- Signing bypass, signing the wrong transaction envelope, or network-passphrase confusion.
- Contract ID, account, or asset validation bugs that route funds or calls incorrectly.
- Unsafe secret handling in helpers such as keypair signers.
- Misleading errors that cause callers to retry unsafe transactions or ignore failed submissions.

### CLI

- Secret leakage through logs, stack traces, profile files, or command output.
- Incorrect encryption/decryption or PIN handling for wallet profiles.
- Network configuration bugs that cause mainnet/testnet/local confusion.
- Commands that submit unintended transactions or skip required confirmation.

### Indexer

- SQL injection or unsafe query construction.
- API abuse, resource exhaustion, or unbounded request amplification.
- Incorrect event parsing that reports false invoice or reputation state.
- Cache poisoning or stale data presented as finalized state.
- Exposure of local database files, internal errors, or operational metadata.

### Notifications

- HMAC bypass, signature confusion, replay exposure, or unsigned payload delivery.
- SSRF through webhook URLs, redirects, DNS rebinding, or internal network targets.
- Rate-limit bypass or circuit-breaker bypass.
- Subscription authorization mistakes or cross-tenant data disclosure.
- Email delivery abuse or injection in notification content.

## Reporting

Send reports to `security@invoice-liquidity-network.local` or open a private GitHub Security Advisory for this repository.

Include as much as possible:

- Affected component and commit, tag, branch, or deployed contract ID.
- Steps to reproduce.
- Expected behavior and actual behavior.
- Impact assessment, including affected assets, users, or permissions.
- Proof-of-concept code, transaction XDR, logs, screenshots, or traces.
- Whether you believe the issue is actively exploitable.

Do not include live secrets, private keys, or personally identifiable information unless maintainers explicitly request a secure transfer method.

## Response Timelines

| Stage | Commitment |
|-------|------------|
| Acknowledgment | Within 48 hours. |
| Initial severity assessment | Within 5 business days. |
| Critical target fix window | Begin mitigation immediately; target patch or disabling mitigation within 7 days. |
| High target fix window | Target patch within 14 days. |
| Medium target fix window | Target patch within 30 days. |
| Low target fix window | Track for the next planned maintenance release or documentation update. |
| Public disclosure | Coordinated after a fix, mitigation, or maintainer-approved advisory timeline. |

Timelines can change if a fix requires third-party coordination, contract migration, or user action. Maintainers will keep reporters updated when timelines change.

## Severity Classification

| Severity | Description | Examples |
|----------|-------------|----------|
| Critical | Direct loss or theft of user funds, permanent protocol insolvency, or unauthenticated upgrade/admin takeover. | Unauthorized settlement, draining escrow, bypassing governance to upgrade contracts. |
| High | Material fund risk, broad data integrity failure, secret exposure, or reliable service compromise. | SDK signing bypass, incorrect contract call XDR, webhook HMAC bypass with sensitive impact, SQL injection that modifies indexed state. |
| Medium | Limited financial or operational impact, denial of service with recovery path, or scoped data exposure. | Localized invoice-state misreporting, rate-limit bypass, recoverable governance workflow disruption. |
| Low | Defense-in-depth issue, documentation security gap, low-impact information exposure, or hard-to-exploit edge case. | Misleading error message, missing hardening header, low-risk dependency advisory. |
| Informational | No immediate exploit path but useful for hardening. | Suggestions for stricter validation, logging improvements, or clearer runbooks. |

## Safe Harbor

We will not pursue legal action or request law-enforcement investigation for good-faith security research that:

- Avoids privacy violations, data destruction, extortion, and service disruption.
- Uses testnet, local deployments, or reporter-owned accounts whenever possible.
- Stops testing and reports promptly after discovering a plausible vulnerability.
- Does not move, drain, or lock funds that do not belong to the reporter.
- Gives maintainers reasonable time to investigate and remediate before public disclosure.

Safe harbor does not cover social engineering, phishing, physical attacks, spam, malware, or attacks against third-party services outside ILN's control.

## Maintainer Handling

1. Confirm receipt and assign a private tracking owner.
2. Reproduce the issue on a local, testnet, or isolated environment.
3. Assign severity using the table above.
4. Prepare mitigation, patch, test, and migration steps.
5. Coordinate disclosure with the reporter.
6. Publish advisory notes when appropriate, including affected versions, impact, fixed versions, and user actions.

## Comprehensive Security Audit Checklist

This checklist guides auditors and maintainers through a structured security review of contract, SDK, and infrastructure changes.

### Soroban Contract Security Audit

#### Authorization & Access Control
- [ ] All state-mutating functions explicitly check caller identity or role via `require_auth()`.
- [ ] Administrative functions (pause, fee updates, admin changes) are protected by a single-signature or multisig gate.
- [ ] LP and payer operations respect role isolation (LP cannot approve themselves without queue resolution, payers cannot modify terms).
- [ ] Insurance pool admin role is restricted to the configured contract address; no user can claim without admin authorization.
- [ ] All Soroban SDK method calls (`invoke_contract`, `transfer`, `invoke_host_function`) are preceded by caller validation.
- **Audit command**: `cargo test --manifest-path contracts/invoice_liquidity/Cargo.toml -- --nocapture | grep -E "(auth|unauthorized)"`

#### Arithmetic & Overflow
- [ ] All arithmetic operations that could overflow use checked methods or explicit bounds.
- [ ] Discount calculations clamp discount rate between 0 and max (configurable, default 10000 bps).
- [ ] LP yield and LP payout are bounded by invoice amount; no calculation can produce negative or zero-exceeding payouts.
- [ ] Premium and balance arithmetic in the insurance pool uses checked addition/subtraction.
- [ ] Score calculations bound results to 0-100 range; no overflow from weighting.
- **Audit command**: `cargo clippy --manifest-path contracts/invoice_liquidity/Cargo.toml -- -W clippy::arithmetic_side_effects`

#### Reentrancy & Cross-Contract Safety
- [ ] No external contract calls are made before state updates (checks-effects-interactions pattern).
- [ ] Invoice state transitions are atomic; partial updates roll back on error.
- [ ] LP yield claims and default refunds are processed in a single transaction; split claims are not possible.
- [ ] Recursive contract calls (e.g., nested `invoke_contract` in event handlers) are not made.
- [ ] Insurance pool claims cannot be re-triggered for the same invoice (`is_claimed` prevents double-processing).
- **Audit command**: `grep -r "invoke_contract" contracts/ | grep -v "tests" | wc -l`

#### Storage & State Collision
- [ ] Storage key structure avoids collisions (enums with address/ID suffixes for per-user keys).
- [ ] Storage lifetime (instance vs persistent) is appropriate (admins/config in instance; per-user in persistent).
- [ ] Ledger expiration is configured (TTL for persistent keys, instance keys are immortal).
- [ ] No parallel mutation of the same invoice state during queue resolution or funding.
- [ ] Stale storage reads are prevented by checking expected invariants (e.g., invoice must exist before update).
- **Audit command**: `rg "DataKey::" contracts/invoice_liquidity/src/ | sort | uniq -c | sort -rn`

#### Front-Running & Oracle Risks
- [ ] Discount rate calculations use a configured static max, not real-time oracle prices (oracle reads are not live pricing).
- [ ] Reputation score calculations are deterministic based on historical invoice state, not time-dependent.
- [ ] No timestamp-dependent price or exchange-rate assumptions in accounting (all payments are in native tokens).
- [ ] Fund queue resolution selects the highest-reputation LP in a single atomic transaction; no two LPs can be selected for the same invoice.
- [ ] Default detection does not rely on external oracle timestamps; invoices expire by absolute `dueDate`.
- **Audit command**: `grep -r "env.ledger\(\).timestamp\(\)" contracts/ | wc -l`

#### Oracle Integration & Manipulation
- [ ] Oracle calls (if any) are wrapped in error handlers that degrade gracefully.
- [ ] Pulled prices are checked against sane bounds (e.g., XLM price bounded 0.05-5 USD for testnet).
- [ ] Oracle endpoint changes are gated by governance (ProposalAction::UpdateOracle requires proposal + vote).
- [ ] Prices used in discount or settlement math are from a single consistent oracle call per transaction.
- **Audit command**: `grep -r "get_price\|oracle\|price_feed" contracts/ --include="*.rs" | grep -v "test" | wc -l`

#### Upgrade & Migration Safety
- [ ] Contract upgrade requires admin authorization via `set_admin()` and wasm upload proposal.
- [ ] Storage schema is versioned; upgrade code validates old state before mutation.
- [ ] No breaking changes to storage keys or enum discriminants without a migration step.
- [ ] Invoices in-flight during an upgrade maintain their state; no data is lost.
- [ ] Paused contracts cannot be upgraded; admin must explicitly unpause post-upgrade and validate state.
- **Audit command**: `grep -r "Migration\|Upgrade\|version" contracts/invoice_liquidity/src/ --include="*.rs" | head -20`

#### Settlement & Accounting
- [ ] Invoice amounts, LP yields, LP payouts, and default refunds sum to zero (conservation of funds).
- [ ] Partial payments increment `amountPaid` but do not change `amountFunded`; funding and payment are independent.
- [ ] Discount rate logic is deterministic: `effectiveYieldBps = max(discountRate, minYield) * (daysUntilDue / 365)` (no time-dependent rounding).
- [ ] Default compensation is bounded by coverage cap and pool balance.
- [ ] All settlement math uses integer arithmetic (stroops); decimal representation is in SDK, not contract.
- **Audit command**: `grep -A 10 "amountPaid\|amountFunded\|yield\|payout" contracts/invoice_liquidity/src/settlement.rs 2>/dev/null | head -30`

#### Emergency & Governance
- [ ] Pause/unpause operations can be called only by admin; no unpause delay.
- [ ] Governance proposals require a vote quorum and timeout; no single vote can pass.
- [ ] Rejected proposals cannot be re-executed or re-voted on.
- [ ] Admin changes emit an event; no silent handoff.
- [ ] Paused invoices cannot be paid, funded, or claimed; paused pool cannot process new premiums.
- **Audit command**: `grep -r "pause\|unpause" contracts/ --include="*.rs" | grep -v "test" | wc -l`

### SDK Security Audit

#### Transaction Construction & Signing
- [ ] Batch operations (if implemented) construct a single Soroban transaction envelope with multiple invoke operations.
- [ ] Network passphrase is validated against the RPC server before signing.
- [ ] XDR encoding of contract arguments (addresses, amounts, timestamps) is verified by decoding and re-checking.
- [ ] Signer is stored in client config and passed consistently; no global signer state.

#### Client-Side Validation
- [ ] Addresses are validated as valid Stellar G… format before submission.
- [ ] Amounts are checked for non-negative values and no overflow.
- [ ] Timestamps are reasonable (not in the distant past or future).
- [ ] Contract ID is validated as a Soroban contract address (not an account).

### Automated Checks

Run these commands regularly to catch common issues:

```bash
# Rust formatting and linting
cd contracts && cargo fmt --check && cargo clippy -- -D warnings

# Run all contract tests with coverage
cargo test --manifest-path contracts/invoice_liquidity/Cargo.toml --release

# Security-focused clippy rules
cargo clippy --manifest-path contracts/invoice_liquidity/Cargo.toml -- \
  -W clippy::arithmetic_side_effects \
  -W clippy::panicking_unwrap \
  -W clippy::unimplemented

# Check for common Soroban security issues
rg "unwrap\(\)|expect\(" contracts/ --type rust | grep -v test | wc -l
rg "env.events().publish\(" contracts/ --type rust | wc -l
rg "require_auth\(\)" contracts/ --type rust | grep -v test | wc -l

# Ensure all state mutations are guarded
rg "storage.*set\(" contracts/ --type rust | wc -l
rg "require_auth|assert" contracts/ --type rust | grep -v test | wc -l

# Validate SDK type definitions
cd sdk && npm run build && npm run test

# Lint and format TypeScript
cd sdk && npm run fmt:check && npm run lint
```

## Security Checklist For Releases

- Contract changes include authorization, storage layout, and state-transition review.
- SDK and CLI changes include transaction, signing, and network-passphrase tests.
- Indexer changes include input-validation and API-abuse review.
- Notifications changes include HMAC, SSRF, rate-limit, and circuit-breaker tests.
- CI confirms Rust tests, Node tests, formatting, linting where available, and coverage thresholds.
- All items in the [Comprehensive Security Audit Checklist](#comprehensive-security-audit-checklist) above are reviewed before mainnet release.
- Mainnet releases require the [Mainnet Launch Checklist](mainnet-launch-checklist.md) to be signed off.

## Reentrancy Analysis (Issue #535)

### Cross-Contract Call Matrix

| Function | External Call(s) | CEI Pattern | Guard | Risk |
|---|---|---|---|---|
| `fund_invoice` | `token.transfer(funder→contract)` | ✅ State check before | `lock_reentrancy` | Low — SAC has no callback |
| `fund_invoice` | `oracle.get_payer_data` | ✅ Read-only, before state | — | None — view only |
| `fund_invoice` | `token.transfer(contract→freelancer)` | ⚠️ Fixed: now after state update | `lock_reentrancy` | Low |
| `fund_invoice` | `distribution.accrue_lp` | ✅ After state save | — | Low — trusted contract |
| `mark_paid` | `token.transfer(payer→contract)` | ⚠️ Fixed: now after state update | `lock_reentrancy` | Low |
| `mark_paid` | `token.transfer(contract→admin)` | ⚠️ Fixed: now after state update | `lock_reentrancy` | Low |
| `mark_paid` | `token.transfer(contract→funder)` | ⚠️ Fixed: now after status update | `lock_reentrancy` | Low |
| `mark_paid` | `distribution.accrue_settlement` | ✅ After state save | — | Low — trusted contract |
| `cancel_invoice` | `token.transfer(contract→funder)` | ⚠️ Fixed: now after status update | `lock_reentrancy` | Low |
| `claim_default` | `token.transfer(contract→funder)` | ⚠️ Fixed: now after status update | `lock_reentrancy` | Low |
| `resolve_dispute` | `token.transfer(contract→funder)` | ⚠️ Fixed: now after status update | `lock_reentrancy` | Low |
| `execute_proposal` (governance) | `invoke_contract(iln_contract, ...)` | ⚠️ Note: status update after call | — | Low — governance trust boundary |

### Mitigations Applied

1. **Reentrancy guards** (`lock_reentrancy` / `unlock_reentrancy`): Added to `fund_invoice`, `mark_paid`, `cancel_invoice`, `claim_default`, and `resolve_dispute`. Uses a boolean instance storage lock; on error/panic the lock is automatically cleared by Soroban's revert semantics.

2. **CEI pattern enforcement**: All state updates in `mark_paid`, `claim_default`, `cancel_invoice`, and `resolve_dispute` now occur **before** external token transfers. Previously the status/amount updates were after token transfers, which could have allowed reentrant exploitation with exotic tokens.

3. **Oracle calls**: The `oracle.get_payer_data` call in `fund_invoice` is a read-only view and occurs only after auth checks and state validation. State mutation happens after the oracle returns.

4. **Distribution contract calls**: `notify_distribution_funding` and `notify_distribution_settlement` are informational updates to a trusted distribution contract. They are invoked after state is fully persisted.

### Residual Risk

- Governance `execute_proposal` in `iln_governance` invokes the ILN contract after changing `ProposalStatus::Passed` but before `ProposalStatus::Executed`. This is an accepted design choice because the ILN contract's admin functions are idempotent and guarded by `require_admin`.
- Soroban's host function isolation provides inherent reentrancy protection for SAC token transfers, so the guards are defense-in-depth.

## Rate Limiting (Issue #541)

Rate limiting is applied to sensitive admin functions to prevent griefing via rapid parameter changes. See `docs/access-control.md#6-rate-limiting-design-issue-541` for the full design, cooldown table, and implementation details.

Key design decisions:
- Cooldown is measured in **ledgers** (not timestamps), aligning with Soroban's deterministic execution model.
- Emergency functions (`pause`, `unpause`, `resolve_appeal`, `resolve_dispute`) are exempt.
- Rate limits are per-function, so calling `update_fee_rate` does not affect `update_max_discount`.
- Each rate-limited function is keyed by a `Symbol` in instance storage (`DataKey::RateLimit(Symbol)`).
