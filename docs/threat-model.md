# ILN Smart Contract Threat Model

**Document Version:** 1.0  
**Date:** May 2024  
**Status:** Pre-Audit  

## Executive Summary

The Invoice Liquidity Network (ILN) contract enables freelancers to monetize unpaid invoices through liquidity providers (LPs) who purchase discounted claims. This threat model identifies potential attack vectors, trust assumptions, and existing mitigations for the Soroban smart contract implementation.

**Scope:** Core `invoice_liquidity` contract and integrated `reputation_bonus` contract  
**Out of Scope:** Frontend, RPC endpoints, custodial systems, off-chain governance

---

## Trusted Parties

### 1. **Admin**
- **Role:** Central authority for contract configuration and dispute resolution
- **Capabilities:** 
  - Update governance parameters (decay rates, reputation thresholds, fee rates)
  - Manage token registry (add/remove approved tokens)
  - Pause/unpause contract
  - Resolve appeals and disputes
  - Set primary distribution contract

**Risk:** Admin key compromise would allow:
- Unilateral parameter manipulation (high reputation requirements, excessive decay)
- Freezing of contract via pause
- Adding malicious tokens
- Forced resolution of disputes in admin's favor

**Mitigation:** 
- Multi-sig governance recommended (outside contract scope)
- Time-locks on critical parameters (outside contract scope)
- Public governance events logged on-chain for transparency

### 2. **Soroban Runtime & Stellar Network**
- **Assumptions:**
  - Soroban executor is bug-free
  - Stellar consensus is honest (Byzantine fault tolerance)
  - Cryptographic primitives (SHA-256, Ed25519) are collision-resistant
  - Ledger state is immutable once finalized

**Risk:** Network-level attacks (51% attacks, consensus failures) are outside contract scope but catastrophic if realized.

### 3. **Token Contracts (USDC, EURC, XLM)**
- **Assumptions:**
  - Tokens implement Stellar Asset Contract standard correctly
  - Token transfers are atomic and final
  - Tokens have no hidden transfer hooks that could fail unexpectedly

**Risk:** Malicious or buggy token implementation could:
- Revert transfers unexpectedly, leaving invoices in inconsistent states
- Front-run token transfers via hooks
- Violate token balance invariants

**Mitigation:**
- Admin controls token registry (whitelist only trusted tokens)
- Contract validates token approval before use
- No recursive calls to token contracts

---

## Attack Surfaces & Threats

### A. REENTRANCY ATTACKS

#### A1. Cross-Contract Reentrancy via Token Transfers

**Description:**  
When the contract transfers tokens to users (e.g., `fund_invoice()`, `claim_default()`), the destination address could be a malicious contract that calls back into ILN during the transfer.

**Attack Scenario:**
```
1. Attacker deploys malicious contract as LP
2. Attacker calls fund_invoice() with attacker contract as funder
3. Token transfer to attacker contract triggers callback
4. Callback calls mark_paid() or another state-mutating function
5. Contract state could be manipulated (double-spending LP funds)
```

**Current Mitigation:**
- ✅ **Checks-Effects-Interactions Pattern:** Contract updates `invoice.amount_funded` **before** calling token transfer
- ✅ **Single Transfer Per TX:** Token transfer is the final external call
- ✅ **No Delegate Calls:** Soroban has no delegate call primitive

**Code Evidence:** [fund_invoice() in lib.rs](contracts/invoice_liquidity/src/lib.rs#L634-L730)
```rust
// UPDATE STATE FIRST (effects)
invoice.amount_funded += amount;
save_invoice(&env, &invoice);

// THEN EXTERNAL CALL (interactions)
token.transfer(...);
```

**Residual Risk:** ⚠️ **LOW-MEDIUM**
- Token contract behavior during transfer is unpredictable
- If token has custom hooks, callbacks could occur
- Mitigation assumes no nested ILN calls during transfer (unproven for all token implementations)

**Recommendation:**
- Audit specific USDC/EURC implementations for callback hooks
- Consider mutex-style guard state variable (set flag before transfer, check on re-entry)

---

#### A2. Reentrancy via Appeal/Dispute Resolution

**Description:**  
The `resolve_appeal()` and `resolve_dispute()` functions are called by admin and modify invoice state. If admin is a contract, callbacks could occur during execution.

**Current Mitigation:**
- ✅ **Admin-Only Access:** Only the contract admin can call these functions
- ✅ **Admin Key is Trusted:** Assumes admin key is secure (not a DAO or contract initially)

**Residual Risk:** ⚠️ **MEDIUM**
- If governance transitions to a DAO contract, DAO could be reentered
- The contract does not prevent admin from being a contract

**Recommendation:**
- Document that admin should be a secure EOA (multi-sig) for the beta phase
- Future governance upgrade should include reentrancy protections (e.g., state flags)

---

### B. FRONT-RUNNING ATTACKS

#### B0. Ordinary `fund_invoice()` Front-Running (Issue #707)

**Description:**
`tests_mev_mitigation.rs` covers the priority-queue path (B1 below) for genuinely
simultaneous funding attempts, but ordinary (non-queued) `fund_invoice()` calls have no
dedicated analysis: could a validator or searcher observing a pending `fund_invoice()`
transaction front-run it the way an EVM searcher front-runs a profitable mempool
transaction?

**Stellar's transaction ordering model, and why it doesn't map onto EVM-style MEV:**
- Stellar uses the Stellar Consensus Protocol (SCP), a federated Byzantine agreement
  scheme — there is no single block proposer/miner per ledger close who unilaterally
  orders transactions the way an Ethereum block builder does. Validators nominate
  candidate transaction sets and vote to converge on one per ~5s ledger close.
- Within a ledger close, transaction ordering across the included set is not an open
  priority-fee auction a searcher can win by outbidding — Stellar's fee model
  (base fee + optional inclusion fee under surge pricing) determines *whether* a
  transaction is included under network congestion, not an arbitrary reordering
  priority a searcher can exploit to insert a transaction ahead of a specific target
  once both are in the candidate set.
- There is no widely-deployed, EVM-Flashbots-equivalent private-orderflow/searcher
  infrastructure for Stellar today that would let a party reliably observe a pending
  `fund_invoice()` call and construct a transaction guaranteed to land immediately
  before it.

**Why `fund_invoice()` specifically isn't a profitable front-running target even where
ordering *could* be influenced:**
- Classic EVM front-running/sandwich attacks extract value from a **price-sensitive**
  operation (an AMM swap with slippage) — the victim's trade moves a price the
  front-runner can arbitrage. `fund_invoice()` has no such mechanism: the invoice's
  discount rate, fee, and terms are fixed at invoice-creation time and read verbatim
  by whichever transaction executes, in whichever order. A front-runner who funds
  first gets the same fixed terms the original caller would have gotten — there is no
  slippage, no price impact, and nothing to extract *from* the original caller's
  transaction. The only thing at stake is which of two willing LPs funds the invoice
  first, a race condition, not value extraction.

**Residual Risk:** ✅ **LOW** — Stellar's consensus model doesn't expose the
block-builder-controlled reordering that EVM front-running relies on, and even if a
transaction's relative position could be influenced, `fund_invoice()` has no
price-sensitive state for a front-runner to extract value from. This differs from the
genuine (LOW-MEDIUM) risk already documented for the priority-queue path in B1, where
multiple LPs *competing* for the same invoice via `join_fund_queue()`/
`resolve_fund_queue()` do have a real (if narrow) tie-breaking-predictability concern —
see Issue #708.

**Recommendation:** No mitigation needed for ordinary `fund_invoice()` calls given the
above. If Stellar's transaction ordering model changes materially (e.g. a future
protocol upgrade introduces proposer-controlled reordering), this analysis should be
revisited.

---

#### B1. LP Queue Position Manipulation

**Description:**  
LPs call `join_fund_queue()` to register intent before `resolve_fund_queue()` selects the winner. A front-runner could:

1. Observe pending `join_fund_queue()` TX
2. Front-run with higher reputation snapshot
3. Win the funding right by being selected first

**Attack Scenario:**
```
1. LP1 calls join_fund_queue(invoice_id) with reputation 45
2. Front-runner observes TX in mempool
3. Front-runner calls resolve_fund_queue() immediately after
4. If mempool order favors front-runner's join TX, front-runner wins
```

**Current Mitigation:**
- ✅ **Reputation Scoring:** Resolution selects highest reputation LP at selection time
- ✅ **Decentralized Mempool:** Stellar/Soroban mempool is not ordered by gas (unlike Ethereum)
- ✅ **Queue Snapshot:** Each queue entry stores reputation at join time

**Code Evidence:** [resolve_fund_queue() in lib.rs](contracts/invoice_liquidity/src/lib.rs#L810-L880)
```rust
// Select LP with highest reputation snapshot
let best_candidate = queue.iter()
    .max_by_key(|entry| entry.reputation_score)
    .cloned();
```

**Residual Risk:** ✅ **LOW** (was ⚠️ LOW-MEDIUM)
- **Resolved (Issue #708):** ties among equal-reputation LPs are no longer
  first-in-queue-deterministic — `resolve_fund_queue` now selects uniformly at
  random among all tied top-score entries via `env.prng()`, Soroban's
  network-seeded PRNG. See `contracts/invoice_liquidity/src/lib.rs`'s
  `resolve_fund_queue` and the fairness tests in `tests_mev_mitigation.rs`.
- Stellar's random sequence of validators makes pure front-running hard
- LPs observing pending TXs could still delay their own join to improve
  position, but can no longer guarantee a win by being first among ties

**Recommendation:**
- Monitor queue resolution patterns for anomalies in off-chain analytics
- Soroban's PRNG is validator-seeded, not a secret-entropy source (see the
  crate's own `prng` module docs) — acceptable here since nothing security-
  critical (funds custody, auth) depends on the outcome, only which of
  several already-eligible LPs is selected

**Clarification — post-resolution transfer is NOT a fairness bypass (Issue #712):**
`transfer_lp_position()` lets a funded invoice's LP hand their position to any
other address, with no check against funding-queue history. This means a
queue winner can immediately transfer their position to the address that
*lost* the same queue resolution — functionally equivalent to a private
side arrangement where the "loser" ends up funding the invoice anyway. This
is **intentional, documented secondary-market behavior**, not an accidental
bypass of the queue's fairness guarantee:
- The queue's fairness guarantee is specifically about *who gets first
  crack at funding the invoice* (reputation-weighted, randomized on ties
  per Issue #708) — it says nothing about what either party does with the
  resulting position afterward.
- `transfer_lp_position()` already exists as a general-purpose position
  handoff mechanism used elsewhere in the protocol, independent of whether
  the position originated from a queue resolution, a direct `fund_invoice()`
  call, or anything else — restricting it specifically for queue-originated
  positions would be an arbitrary carve-out with no clear security benefit,
  since the two parties could achieve the same economic outcome through an
  off-chain side payment regardless.
- See `test_queue_winner_can_transfer_position_to_queue_loser` in
  `tests_mev_mitigation.rs` for a test confirming this works exactly as
  `transfer_lp_position` intends elsewhere in the protocol.

---

#### B2. Discount Rate Manipulation via Reputation Decay

**Description:**  
Freelancers could front-run `mark_paid()` or `claim_default()` with decay-triggering transactions to change effective discount rates.

**Attack Scenario:**
```
1. Freelancer has reputation score 70 (high-rep threshold 60, discount -100 bps)
2. Freelancer observes pending LP funding TX
3. Freelancer calls market_paid() on unrelated invoice to trigger decay
4. Decay drops reputation to 59
5. Incoming LP funding now uses full discount_rate instead of reduced rate
```

**Current Mitigation:**
- ✅ **Decay Applied on Read:** Reputation decay is calculated lazily when score is retrieved
- ✅ **Snapshot at Submission:** Invoice stores discount_rate at submission time (not recalculated)

**Code Evidence:** [submit_invoice() in lib.rs](contracts/invoice_liquidity/src/lib.rs#L250-L270)
```rust
let invoice = Invoice {
    // ... other fields ...
    discount_rate,  // Frozen at submission time
};
```

**Residual Risk:** ⚠️ **LOW**
- Discount rate on invoice is immutable once submitted
- Only affects future invoices, not in-flight ones
- Attack has no direct benefit to attacker (only affects payer, not freelancer revenue)

**Recommendation:**
- Document that discount rates are locked at submission
- Monitor reputation scores for abnormal decay patterns

---

### C. TIMESTAMP MANIPULATION ATTACKS

#### C1. `due_date` Bypass via Clock Manipulation

**Description:**  
The contract checks `env.ledger().timestamp()` against invoice `due_date` to determine payment status. A validator or sequencer could manipulate ledger timestamp.

**Attack Scenario:**
```
1. Invoice is due at timestamp T
2. Validator produces a block with timestamp T-10 (just before due date)
3. Payer fails to mark invoice as paid
4. Validator produces next block with timestamp T+100 (after due date)
5. Payer marked as defaulter despite paying in time
```

**Current Mitigation:**
- ✅ **Stellar Consensus:** Ledger timestamp is set by consensus (median of validator votes)
- ✅ **Timestamp Monotonicity:** Soroban enforces `new_timestamp >= previous_timestamp`
- ✅ **Validator Incentives:** 51% of validators would need to collude (Byzantine assumption)

**Code Evidence:** [Validation in lib.rs](contracts/invoice_liquidity/src/lib.rs#L280-L295)
```rust
if env.ledger().timestamp() >= invoice.due_date {
    // Invoice is overdue
}
```

**Residual Risk:** ⚠️ **MEDIUM**
- Attacks require 51% validator collusion (network-level risk, not contract-specific)
- Small timestamp drifts (10-60 seconds) are hard to exploit deterministically
- Validator incentives are misaligned with manipulation

**Recommendation:**
- Document timestamp assumptions (Stellar consensus, 51% honest validators)
- Recommend generous grace periods for critical deadlines (24-hour payment windows, not seconds)
- Monitor Stellar validator consensus for anomalies

#### C2. Appeal Window Bypass

**Description:**  
The `appeal_default()` function enforces a 30-day appeal window from `due_date`. A payer could attempt to appeal after the window via timestamp manipulation.

**Attack Scenario:**
```
1. Invoice defaults (due_date = T, 30-day window until T+30 days)
2. Payer waits until day 29
3. Payer calls appeal_default() before day 30
4. Attacker validator delays block inclusion until day 35
5. Appeal is accepted despite being outside 30-day window (if timestamps used incorrectly)
```

**Current Mitigation:**
- ✅ **Ledger Sequence Used:** Windows are measured in ledger sequence, not timestamp
- ✅ **Monotonic Ledger Sequence:** Impossible to go backwards in ledger height

**Code Evidence:** [appeal_default() validation](contracts/invoice_liquidity/src/lib.rs#L1410)
```rust
let appeal_window_ledgers = 30 * 24 * 60 * 10; // 30 days in ledger units
if env.ledger().sequence() > invoice.due_date_ledger + appeal_window_ledgers {
    return Err(ContractError::AppealWindowClosed);
}
```

**Residual Risk:** ✅ **LOW**
- Ledger sequence is cryptographically protected
- Cannot be manipulated without breaking Stellar consensus

---

### D. ORACLE MANIPULATION ATTACKS

> **⚠️ Pending re-review (Issue #39):** D1/D2 below predate the payer-verification
> oracle interface and governance-controlled oracle registry (Issue #93/#532) —
> D2 in particular states "no integration with external credit oracles," which
> is no longer accurate now that `oracle_interface.rs`/`oracle_registry.rs`
> exist and are live in `fund_invoice`. A full re-review of this section is
> tracked as Issue #39. In the meantime, see
> [**D3 below**](#d3-payer-verification-oracle-manipulation-economic-model)
> and [`docs/oracle-attack-economics.md`](oracle-attack-economics.md) for a
> quantified cost/benefit model of manipulating the oracle that actually ships
> today.

#### D1. Reputation Score Manipulation

**Description:**  
The reputation system relies on the contract's internal tracking of scores. If reputation calculations are wrong, LPs could game the system.

**Attack Scenario:**
```
1. Attacker submits and immediately defaults on 100 invoices
2. Attacker reputation drops from 50 to 0 (crude model)
3. Attacker waits for decay to slowly increase reputation back
4. Attacker repeats with another identity
5. Network creates many low-reputation identities
```

**Current Mitigation:**
- ✅ **Decay Mechanism:** Scores decay over time if inactive (removes incentive to collect accounts)
- ✅ **Fixed Penalties:** Defaults incur `-5` score penalty (not %-based)
- ✅ **Score Floor:** Scores are capped at 0-100 range
- ✅ **Admin Oversight:** Admin can monitor patterns and pause if needed

**Code Evidence:** [get_payer_score() in invoice.rs](contracts/invoice_liquidity/src/invoice.rs#L227-L250)
```rust
if u64::from(ledgers_since_activity) >= decay_config.decay_period_ledgers {
    let periods_passed = u64::from(ledgers_since_activity) / decay_config.decay_period_ledgers;
    for _ in 0..periods_passed {
        let decay_amount = (decayed_score * decay_config.decay_rate_bps as u64) / 10_000;
        decayed_score = decayed_score.saturating_sub(decay_amount);
    }
}
```

**Residual Risk:** ⚠️ **MEDIUM**
- Reputation is centralized in contract; no external data feed
- Decay mechanism is configurable by admin (potential misuse)
- No on-chain evidence of off-chain reputation events (defaults, appeals)
- LPs must trust admin did not artificially inflate/deflate scores

**Recommendation:**
- Publish reputation change events for off-chain verification
- Document reputation model as **not cryptographically proven** (trust-based on contract execution)
- Recommend frequent reputation audits by independent parties
- Consider reputation delegation (querying other protocols like Lens, etc.)

#### D2. Missing External Oracle for Payer Creditworthiness

**Description:**  
The contract has no integration with external credit oracles. Payer reputation is purely based on payment history in ILN, not broader financial trustworthiness.

**Attack Scenario:**
```
1. Attacker is highly reputable in ILN (always pays)
2. Attacker is insolvent off-chain (high bankruptcy risk)
3. LPs see high reputation and fund invoices
4. Attacker defaults on-chain (ILN sees it as unpredictable)
5. LPs lose capital despite on-chain metrics seeming good
```

**Current Mitigation:**
- ✅ **Governance Awareness:** Admin can manually verify payer identity (outside contract)
- ✅ **LP Risk Assessment:** LPs can independently verify payer creditworthiness
- ✅ **Discount Rates:** High-risk payers should offer higher discounts

**Residual Risk:** ⚠️ **HIGH**
- No cryptographic proof of payer creditworthiness
- Purely trust-based system for initial payer reputation
- LPs bear 100% of credit risk

**Recommendation:**
- Document ILN as a **reputation layer**, not a credit substitute
- Recommend LP due diligence on payers (KYC checks, external credit reports)
- Consider integration with Stellar-native identity protocols in future versions
- Publish recommended LP risk management guidelines

#### D3. Price Oracle Sandwich Attacks (Issue 39)

**Description:**  
The contract uses price oracles for USD volume normalization in contract statistics. Any operation that reads an oracle price and then acts on it within the same or adjacent transactions could be sandwiched if the oracle price derives from an on-chain DEX rather than an off-chain feed.

**Attack Scenario:**
```
1. Price oracle uses on-chain DEX spot prices (e.g., Stellar DEX, AMM pools)
2. Attacker observes pending `get_contract_stats()` or other price-dependent operation
3. Attaker front-runs with large swap to manipulate DEX price
4. Oracle reads manipulated price for USD normalization
5. Contract statistics report incorrect USD volume
6. While not directly financial, this affects:
   - Protocol analytics and monitoring accuracy
   - LP decision-making based on volume metrics
   - Potential governance decisions based on incorrect stats
```

**Current Mitigation:**
- ✅ **Statistical Use Only:** Price oracle currently used only for volume normalization in `get_contract_stats()`
- ✅ **No Financial Dependence:** No financial operations (funding, payments) depend on price oracle
- ✅ **Governance Control:** Oracle registration is governance-controlled via `register_oracle()`
- ✅ **Provider Vetting:** `oracle-provider-vetting.md` provides criteria for evaluating oracle providers

**Code Evidence:** [get_price_from_oracle() in invoice.rs](contracts/invoice_liquidity/src/invoice.rs#L874-L880)
```rust
fn get_price_from_oracle(env: &Env, token: &Address) -> Option<i128> {
    let config = crate::storage::get_config(env)?;
    let oracle = config.price_oracle?;
    let args = soroban_sdk::vec![env, token.clone().into_val(env)];
    Some(env.invoke_contract::<i128>(&oracle, &Symbol::new(env, "get_price"), args))
}
```

**Residual Risk:** ⚠️ **MEDIUM-HIGH** (if using on-chain DEX prices)
- Current test implementations use mock data (`MockPriceOracle` in tests)
- Production oracle source undefined - depends on governance-approved providers
- **HIGH risk** if price oracle uses DEX spot prices without TWAP protection
- **LOW risk** if using off-chain signed price feeds (Chainlink, Pyth, etc.)
- Future protocol expansions could introduce price-dependent financial operations

**Recommendation:**
- **Mandatory:** Update `oracle-provider-vetting.md` to explicitly require:
  - Price feed oracles must use manipulation-resistant sources (TWAP, off-chain feeds)
  - Prohibits DEX spot price oracles without TWAP protection
- **Governance Policy:** Establish that only price oracles with these properties are approved:
  - TWAP (Time-Weighted Average Price) mechanisms for any DEX-based oracle
  - Off-chain signed price feeds with multi-signer aggregation
  - Multi-source aggregation with outlier rejection
- **Technical Implementation:** If DEX prices are needed, require TWAP interface:
  ```rust
  // Example TWAP interface for oracle providers
  fn get_price_twap(env: Env, token: Address, window_seconds: u64) -> i128;
  ```
- **Monitoring:** Enhance `check_oracle_health()` to track price volatility and manipulation detection

---

### E. GOVERNANCE ATTACKS

#### E1. Admin Key Compromise

**Description:**  
The admin key controls critical functions: token registry, parameter updates, dispute resolution, pause/unpause.

**Attack Scenario:**
```
1. Admin private key is compromised
2. Attacker calls pause() and freezes all operations
3. Attacker calls resolve_dispute() in their favor (fraudulent)
4. Attacker adds malicious token to registry
5. Attacker updates parameters to favor their accounts
```

**Current Mitigation:**
- ✅ **Require Auth:** All admin functions require `require_auth()` (signature verification)
- ✅ **Public Events:** Critical admin actions emit events (pause, parameter changes)
- ✅ **Community Oversight:** On-chain events can be monitored by users

**Code Evidence:** [set_admin() in lib.rs](contracts/invoice_liquidity/src/lib.rs#L130)
```rust
pub fn set_admin(env: Env, admin: Address) -> Result<(), ContractError> {
    let current_admin = get_admin(&env)?;
    current_admin.require_auth();  // Must sign with current key
    // ...
    set_admin_in_storage(&env, &admin);
}
```

**Residual Risk:** ⚠️ **CRITICAL**
- Single point of failure if admin key is compromised
- Events are emitted **after** state changes (vulnerable to race conditions)
- No time-lock mechanism for critical upgrades
- No multi-sig requirement

**Recommendation:**
- **Mandatory:** Transition to multi-sig admin (2-of-3 or 3-of-5 typical)
- **Mandatory:** Implement time-locks (24-48 hours) for parameter changes
- Consider DAO governance for decentralized admin (future upgrade)
- Publish security policy for key management (rotate keys regularly, HSM storage)

#### E2. Governance Parameter Misconfiguration

**Description:**  
Admin can update reputation thresholds, decay rates, and discount rates. Incorrect parameters could break economic incentives.

**Attack Scenario:**
```
1. Admin sets decay_rate_bps = 10000 (100% decay per period!)
2. All reputation scores drop to 0 instantly
3. LPs can no longer find qualified invoices
4. Protocol becomes non-functional
```

**Current Mitigation:**
- ✅ **Validation Constraints:** Some parameters have bounds checks (bonus_bps <= 500)
- ✅ **Public Events:** All config changes emit events for monitoring

**Code Evidence:** [update_config() in config.rs](contracts/invoice_liquidity/src/config.rs#L28-L42)
```rust
if bonus_bps > MAX_BONUS_BPS {
    return Err(ConfigError::InvalidBonusBps);
}
if min_discount_rate_bps == 0 {
    return Err(ConfigError::InvalidMinDiscountRate);
}
```

**Residual Risk:** ⚠️ **MEDIUM**
- Not all parameters have bounds checks (e.g., `decay_rate_bps` can be any u32)
- No validation that parameters are "economically sane"
- Admin can set conflicting parameters (high_rep_threshold = 200, which is impossible)

**Recommendation:**
- Add comprehensive validation for all parameters:
  - `high_rep_threshold` must be 0-100
  - `decay_rate_bps` must be 0-500 (max 5% per period)
  - `decay_period_ledgers` must be > 0
- Document safe parameter ranges in governance policy
- Require test runs on testnet before mainnet updates

---

#### E3. Flash-Loan Balance Manipulation (Vote-Snapshotting)

**Description:**
Governance token balances determine voting weight in the ILN contract. To prevent users from voting and transferring tokens to double-vote, the contract uses a lazy-snapshot mechanism (Issue #738). However, this snapshot is taken dynamically at the exact time `cast_vote()` is called for most voters (only the proposer's balance is snapshotted at `create_proposal()`).

**Attack Scenario:**
```
1. A lending protocol on Stellar offers flash loans for the ILN governance token.
2. An attacker borrows a massive amount of governance tokens via a flash loan.
3. In the same transaction, the attacker calls `cast_vote()` on a target proposal.
4. The lazy-snapshot logic observes the artificially inflated balance, permanently recording it as their snapshotted weight for that proposal.
5. The attacker repays the flash loan.
```

**Residual Risk:** ⚠️ **HIGH**
Since Soroban lacks a native historical state-proof or checkpointing mechanism, the lazy-snapshot technique leaves the contract vulnerable to flash-loan manipulation if the token becomes composable in DeFi. Quadratic voting reduces the impact but does not eliminate it.

**Recommendation:**
If the governance token becomes widely flash-loanable, the protocol must transition to a staking-based governance model (e.g., locking tokens in an escrow vault for the duration of the proposal) or integrate with an oracle that provides cryptographic proofs of historical ledger balances prior to proposal creation.


### F. TOKEN TRANSFER EDGE CASES

#### F1. Token Transfer Fails, But State Is Updated

**Description:**  
The contract updates state before calling `token.transfer()`. If transfer fails, state inconsistency occurs.

**Attack Scenario:**
```
1. LP calls fund_invoice() for 1000 USDC
2. Contract sets invoice.amount_funded = 1000
3. Token transfer fails (token is paused, LP balance insufficient, etc.)
4. Function reverts due to failed transfer
5. But state rollback is incomplete (ledger reverts, but off-chain listeners might see partial state)
```

**Current Mitigation:**
- ✅ **Atomic Transactions:** Soroban transactions are atomic (all-or-nothing)
- ✅ **Checks-Effects-Interactions Pattern:** State updated before external calls
- ✅ **Explicit Error Handling:** Contract doesn't silently swallow errors

**Code Evidence:** [fund_invoice() in lib.rs](contracts/invoice_liquidity/src/lib.rs#L700-L730)
```rust
invoice.amount_funded += amount;
save_invoice(&env, &invoice);
token.transfer(&funder, &freelancer, &amount)?;  // If this fails, TX reverts
```

**Residual Risk:** ✅ **LOW**
- Soroban ensures all-or-nothing execution
- State changes are rolled back if any call fails
- Token transfer is final external call (safe pattern)

**Recommendation:**
- Document assumption of atomic transactions (rely on Soroban)
- Continue checks-effects-interactions pattern for all external calls

#### F2. Token Allowance Not Set

**Description:**  
The contract calls `token.transfer()`, which requires the sender to have approved the amount. If approval is missing, transfer fails.

**Attack Scenario:**
```
1. LP calls fund_invoice() without first approving ILN contract
2. token.transfer() fails due to insufficient allowance
3. TX reverts, but LP may not understand why
4. User experience is poor
```

**Current Mitigation:**
- ✅ **Documentation:** Off-chain UI should guide users to approve first
- ✅ **Clear Error Messages:** Contract returns `Unauthorized` if transfer fails

**Residual Risk:** ⚠️ **LOW**
- Not a security issue (user error, not exploit)
- Affects UX but not contract integrity

**Recommendation:**
- Add helper functions for checking allowance
- Publish integration guide with approval steps

#### F3. Partial Token Transfer Success

**Description:**  
Some token implementations allow partial transfers. If token transfers less than requested, contract state is inconsistent.

**Attack Scenario:**
```
1. LP calls fund_invoice() for 1000 USDC
2. Token contract only transfers 999 USDC (token deduction/fee logic)
3. Contract records invoice.amount_funded = 1000 (incorrect!)
4. Freelancer receives only 999 USDC but invoice shows 1000 funded
```

**Current Mitigation:**
- ✅ **Token Specification:** Stellar Asset Contract standard requires full amount or revert
- ✅ **Immutable Token Code:** Once a token is deployed, its behavior is fixed (no upgrade without governance)

**Code Evidence:** All token transfers assume Stellar Asset Contract standard behavior.

**Residual Risk:** ⚠️ **LOW-MEDIUM**
- Only applies if a non-standard token is added to registry
- Admin controls token registry (can prevent malicious tokens)
- Recommendation: Only whitelist well-audited tokens (USDC, EURC, native XLM)

**Recommendation:**
- Admin should conduct token audit before whitelisting
- Document token requirements (no fee-on-transfer, standard interface)
- Consider adding token validation helper (test transfer of 1 stroop to verify behavior)

---

### G. INSURANCE POOL SPECIFIC THREATS

#### G1. Premium Manipulation

**Description:**  
The insurance pool allows members to deposit premiums. If premium calculations are incorrect or the admin can manipulate premium rates, members may overpay or underfund the pool.

**Attack Scenario:**
```
1. Admin calls update_premium_rate() with inflated rate (e.g. 50% instead of 5%)
2. Members attempting to enroll see high premium cost
3. Members are priced out of insurance
4. Pool remains underfunded or fills slowly
5. When claims occur, pool cannot cover losses
```

**Current Mitigation:**
- ✅ **Configurable Parameters:** Premium rates are set via governance (admin-controlled)
- ✅ **Public Events:** Premium rate changes emit events for monitoring
- ✅ **Enrollment Validation:** Members must explicitly approve premium amounts

**Residual Risk:** ⚠️ **MEDIUM**
- Admin can unilaterally set premium rates
- No bounds checking on premium_rate_bps (could be set to 100%+ of pool coverage)
- Members may not understand premium mechanics (off-chain communication required)
- No automatic premium rate discovery mechanism (rates are hardcoded by admin)

**Recommendation:**
- Add parameter bounds: `premium_rate_bps` should be capped at reasonable % (e.g., <= 1000 bps or 10%)
- Document premium model and member communication (expected rates, annual yield)
- Consider gradual premium increases (no step changes > 100 bps per update)
- Monitor enrollment trends for drop-offs after rate increases

#### G2. Claim Fraud & Moral Hazard

**Description:**  
Members can submit claims on defaults. Without proper verification, a member could coordinate with a payer to fraudulently claim insurance (moral hazard attack).

**Attack Scenario:**
```
1. Member A and Payer B collude
2. Member A submits invoice to Payer B (high amount, reasonable terms)
3. Member A and Payer B stage a default (Payer B intentionally doesn't pay)
4. Member A claims insurance for full invoice amount
5. Pool pays out fraudulent claim
6. Payer B and Member A split the payout off-chain
```

**Current Mitigation:**
- ✅ **Enrollment Verification:** Pool can verify member address and require KYC (off-chain)
- ✅ **Invoice History:** Claims are tied to actual invoice_liquidity defaults (immutable on-chain)
- ✅ **Admin Review:** Admin can investigate claims and contest fraud
- ✅ **Payer Reputation:** Payers with low default history are less incentivized to stage defaults

**Residual Risk:** ⚠️ **HIGH**
- No cryptographic proof of member legitimacy or payer creditworthiness
- Admin review is manual and subjective
- Repeated small defaults by same payer pair may not be detected
- Pool does not validate that invoice terms are "reasonable" (collusion incentives opaque)

**Recommendation:**
- **Implement Claims Adjudication:** Require admin or DAO multi-sig approval for large claims (> threshold)
- **Fraud Detection:** Monitor for patterns:
  - Same member + same payer submitting multiple defaults in short window
  - Member submitting claims shortly after enrollment
  - Payer default rate >> average default rate in system
- **Claim Dispute Window:** Allow community to dispute claims for X days before payout
- **Proof of Loss:** Require evidence (invoice, evidence of payment attempt) off-chain
- **KYC for High-Value Claims:** Require identity verification for claims > pool balance threshold

#### G3. Pool Drainage / Insolvency Risk

**Description:**  
The pool accepts claims up to enrolled capacity. If claim frequency exceeds projections, the pool may become insolvent and unable to cover all claims.

**Attack Scenario:**
```
1. Pool enrolls $10M in coverage with $1M premiums
2. Unexpectedly high default rate in ILN network (10% vs expected 2%)
3. Members submit $2M in claims in one week
4. Pool only has $1M in premiums + interest ($100k) = $1.1M available
5. Pool is insolvent; claims are partially paid or stuck in queue
6. Later claims are rejected due to insufficient funds
```

**Current Mitigation:**
- ✅ **Capacity Tracking:** Pool tracks total coverage committed and premium collected
- ✅ **Funding Mechanism:** Premiums accumulate in pool for payout reserves
- ✅ **Admin Oversight:** Admin can pause claims or enroll new members if capacity is exceeded
- ✅ **Transparent Reserves:** On-chain balance is queryable (members can check solvency)

**Residual Risk:** ⚠️ **HIGH**
- No automatic trigger to halt enrollment if claims exceed safe reserves
- Premium rates may be too low to cover expected default rates
- Pool has no reinsurance mechanism (no capital backstop)
- Economic incentives misaligned: member wants low premiums, pool needs high premiums for safety
- No automatic claim rejection or payout reduction if pool depletes

**Recommendation:**
- **Dynamic Premium Adjustment:** Link premium_rate_bps to pool utilization ratio:
  - If utilization > 80%, increase premiums 10-20% automatically
  - If utilization < 20%, decrease premiums to attract members
- **Claim Prioritization:** Implement priority queue:
  - Small claims (<$10k) processed immediately
  - Large claims (>$100k) queued and processed over time
  - First-in-first-out or pro-rata payout if insolvent
- **Insurance Reserve Requirement:** Admin must maintain minimum reserve (e.g., 50% of enrolled coverage)
- **Stop-Loss Mechanism:** Auto-pause enrollment if reserves fall below threshold
- **Reinsurance or Backstop:** Establish partnership with external insurer or maintain DAO treasury reserve
- **Clear Communication:** Publish pool solvency ratio to members, warn if approaching danger zone

---

## Summary of Mitigations & Residual Risks

| Threat | Severity | Mitigation | Residual Risk |
|--------|----------|-----------|---------------|
| **Reentrancy (Token Transfers)** | HIGH | Checks-effects-interactions pattern | LOW-MEDIUM (token hooks unpredictable) |
| **Reentrancy (Dispute Resolution)** | HIGH | Admin-only access | MEDIUM (if admin is DAO) |
| **LP Queue Front-Running** | MEDIUM | Reputation snapshot, Stellar mempool randomness, randomized PRNG tie-breaking (Issue #708) | LOW (tie-breaking no longer predictable) |
| **`fund_invoice()` Front-Running (non-queue)** | LOW | No price-sensitive state to extract from; no EVM-style proposer-controlled reordering on Stellar (Issue #707) | LOW |
| **Discount Rate Manipulation** | MEDIUM | Rate frozen at submission | LOW (no benefit to attacker) |
| **Timestamp Manipulation** | MEDIUM | Consensus-based timestamp, ledger sequences | MEDIUM (51% validator attack) |
| **Appeal Window Bypass** | MEDIUM | Ledger sequence windows | LOW (cryptographically protected) |
| **Reputation Sybil Attack** | MEDIUM | Decay mechanism, admin oversight | MEDIUM (no external oracle) |
| **Missing Credit Oracle** | HIGH | None (design limitation) | HIGH (LPs assume all risk) |
| **Payer-Verification Oracle Manipulation (D3)** | HIGH | Opt-in verification, freshness window, `pause()`, governance-gated registration | HIGH (no oracle stake/quorum, no max invoice cap — see [oracle-attack-economics.md](oracle-attack-economics.md)) |
| **Admin Key Compromise** | CRITICAL | Require auth, public events | CRITICAL (single point of failure) |
| **Parameter Misconfiguration** | MEDIUM | Bounds checks (partial) | MEDIUM (incomplete validation) |
| **Token Transfer Failure** | MEDIUM | Atomic transactions | LOW (Soroban guarantees) |
| **Token Allowance Missing** | LOW | Documentation, error handling | LOW (UX issue, not security) |
| **Partial Token Transfer** | MEDIUM | Token specification, admin control | LOW-MEDIUM (requires rogue token) |
| **Premium Manipulation** | MEDIUM | Configurable rates, public events | MEDIUM (no bounds checking) |
| **Claim Fraud & Moral Hazard** | HIGH | Enrollment KYC, invoice immutability, admin review | HIGH (manual verification required) |
| **Pool Drainage / Insolvency** | HIGH | Capacity tracking, transparent reserves | HIGH (no automatic safeguards) |

---

## Risk Recommendations (Priority Order)

### 🔴 Critical (Pre-Audit)
1. **Implement Multi-Sig Admin** (2-of-3 minimum)  
   - Reduces single-point-of-failure risk from CRITICAL to MEDIUM
   - Requires Soroban multi-sig contract integration

2. **Add Time-Locks for Parameter Changes**  
   - Prevents instant governance attacks
   - Allows community reaction time to malicious changes

3. **Validate All Configuration Parameters**  
   - Enforce bounds: `high_rep_threshold` in 0-100, `decay_rate_bps` <= 500
   - Catch configuration bugs before deployment

### 🟡 High (Before Mainnet)
4. **Implement Reentrancy Guard State Flag**  
   - Add `is_locked` boolean to prevent nested external calls
   - Apply to `fund_invoice()`, `claim_default()`, `resolve_*()` functions

5. **Document Trusted Assumptions**  
   - Publish security model: "LPs assume 100% credit risk"
   - Clarify Stellar validator assumptions, token standards

6. **Conduct Token Audit**  
   - Verify USDC, EURC implementations for unexpected callbacks
   - Establish token whitelist policy

### 🟢 Medium (Post-Launch)
7. **Implement Reputation Audit Trail**  
   - Emit event for each reputation change (not just on demand)
   - Enable off-chain verification and anomaly detection

8. ✅ **Add Randomness to Queue Tie-Breaking** — Resolved (Issue #708)
   - Soroban's `env.prng()` (network-seeded CSPRNG, available since well
     before this workspace's soroban-sdk 27.x) now selects uniformly among
     all top-score-tied LPs in `resolve_fund_queue`, instead of always the
     first to join. See B1's residual-risk entry above.

9. **Publish LP Risk Management Guide**  
   - Recommend KYC procedures, portfolio diversification, default rate monitoring
   - Educate users on credit risk assumptions

---

## Future Upgrade Considerations

- **Decentralized Governance:** DAO-based admin to remove single point of failure
- **External Credit Oracles:** Integration with Stellar-native identity/credit protocols
- **Automated Parameter Adjustment:** Formula-based reputation thresholds based on network statistics
- **Rollback Mechanism:** Snapshot and recovery points for emergency scenarios
- **Insurance Pool:** Mutual insurance fund for LP losses (requires new contract)

---

## Conclusion

The ILN contract has **sound architectural foundations** with proper state management (checks-effects-interactions) and access control. However, **critical risks remain**:

1. **Admin single point of failure** – must be mitigated before mainnet
2. **No external credit oracle** – by design, but LPs must understand full risk
3. **Parameter misconfiguration possible** – needs tighter validation
4. **Reentrancy guards incomplete** – consider state flags for defense-in-depth

**Recommendation:** Conduct formal security audit focusing on:
- Admin key management and governance upgrade path
- Reentrancy in complex scenarios (multi-token, distribution integration)
- Parameter validation and safe configuration bounds
- External token behavior (USDC/EURC callback hooks, if any)

---

**Document Prepared By:** Security Review Team  
**Next Steps:** Address critical recommendations, then proceed to formal audit
