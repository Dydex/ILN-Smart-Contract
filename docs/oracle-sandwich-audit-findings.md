# Oracle Sandwich Attack Audit Findings

**Date:** August 27, 2026  
**Branch:** docs/sandwich-attack-oracle-audit  
**Issue Reference:** Issue 39 - Threat model re-review

## Executive Summary

An audit was conducted to identify all oracle-dependent code paths in the ILN Smart Contract system and assess their vulnerability to sandwich attacks. The audit found two distinct oracle usage patterns with different risk profiles:

1. **Identity Verification Oracle (OracleFeedType::Identity)** - Used for payer creditworthiness verification in `fund_invoice()`
2. **Price Oracle (OracleFeedType::Price)** - Used for USD volume normalization in contract statistics

Both oracle types are configured via the governance-controlled oracle registry (Issue #532).

## Findings

### 1. Identity Verification Oracle

**Usage Location:** `fund_invoice()` function (line ~500 in `lib.rs`) when `require_oracle_verification=true`

**Source Type:** **OFF-CHAIN** (payer identity/creditworthiness data)

**Sandwich Attack Risk:** **LOW**

**Analysis:**
- The identity oracle verifies payer creditworthiness using off-chain data (KYC, financial records)
- Oracle data is updated via `update_verification()` calls by the oracle operator
- The oracle interface (`oracle_interface.rs`) defines `VerificationResult` with `verified` (bool) and `timestamp` (u64)
- No price-sensitive operations depend on this oracle - it's a simple boolean check
- Data staleness is checked against `max_oracle_age_ledgers` (default ~24 hours)

**Code Path:**
```rust
// In fund_invoice()
if require_oracle_verification {
    if let Some(oracle_addr) =
        oracle_registry::resolve_oracle(&env, OracleFeedType::Identity, &invoice.token)
    {
        let response: OracleVerificationResponse = env.invoke_contract(
            &oracle_addr,
            &Symbol::new(&env, "get_payer_data"),
            vec![&env, invoice.payer.clone().into_val(&env)],
        );
        // Staleness check and verification logic...
    }
}
```

### 2. Price Oracle (USD Normalization)

**Usage Location:** `get_contract_stats()` function via `get_price_from_oracle()` in `invoice.rs`

**Source Type:** **MOCK IMPLEMENTATION** in tests, **SOURCE UNDEFINED** in production

**Sandwich Attack Risk:** **MEDIUM-HIGH** (if using on-chain DEX prices)

**Analysis:**
- Used to normalize token volumes to USD for statistical reporting
- Current implementation shows only mock/test oracles (`MockPriceOracle` in tests)
- Production source is undefined - depends on which oracle provider is registered
- If using on-chain DEX/AMM prices: HIGH sandwich risk
- If using off-chain price feeds (Chainlink, Pyth): LOW sandwich risk

**Code Path:**
```rust
// In get_price_from_oracle() in invoice.rs
fn get_price_from_oracle(env: &Env, token: &Address) -> Option<i128> {
    let config = crate::storage::get_config(env)?;
    let oracle = config.price_oracle?;
    let args = soroban_sdk::vec![env, token.clone().into_val(env)];
    Some(env.invoke_contract::<i128>(&oracle, &Symbol::new(env, "get_price"), args))
}

// Used in get_contract_stats():
if let Some(price_bps) = get_price_from_oracle(env, &token) {
    total_volume_usd_normalized = total_volume_usd_normalized
        .checked_add(volume.checked_mul(price_bps).unwrap_or(0) / 10_000)
        .unwrap_or(total_volume_usd_normalized);
}
```

### 3. Oracle Registry Architecture (Issue #532)

**Implementation:** `oracle_registry.rs` with `OracleFeedType` enum
- `Price` - Token/asset price feed for USD normalization
- `Identity` - Payer identity verification (legacy `price_oracle` fallback)
- `Credit` - Payer credit scoring (future use)

**Resolution Priority:**
1. Per-token override for feed type
2. Feed-type-wide default
3. Legacy `Config.price_oracle` field (Identity feed only)

**Governance Control:** Oracle registration is admin/governance controlled via `register_oracle()` and `register_token_oracle()`

## Risk Assessment

### High-Risk Scenario
If a **Price** feed oracle uses **on-chain DEX/AMM prices**:
1. Attacker observes pending `fund_invoice()` transaction
2. Attacker front-runs with large swap to manipulate DEX price
3. Price oracle reads manipulated price
4. USD volume normalization reports incorrect statistics
5. While not directly financial (only statistics), this could affect:
   - Protocol analytics and monitoring
   - LP decision-making based on volume metrics
   - Potential governance decisions based on volume stats

### Low-Risk Scenario  
If **Price** feed uses **off-chain price feeds** (Chainlink, Pyth, etc.):
- Sandwich attack not feasible as prices come from signed off-chain data
- Risk reduces to oracle provider reliability/centralization

### No-Risk Scenario
**Identity** verification oracle:
- No price-sensitive operations
- Simple boolean verification
- Staleness checks prevent old data usage

## Recommendations

### Immediate Actions

1. **Document Oracle Source Requirements:** Update `oracle-provider-vetting.md` to explicitly require:
   - **Price** feed oracles must use manipulation-resistant sources (TWAP, off-chain feeds)
   - Prohibits DEX spot price oracles without TWAP protection

2. **Add Threat Model Section:** Document sandwich attack risk in threat model under "Oracle Manipulation Attacks"

3. **Governance Policy:** Establish governance policy that only approves price oracles with:
   - TWAP (Time-Weighted Average Price) mechanisms
   - Off-chain signed price feeds
   - Multi-source aggregation with outlier rejection

### Technical Recommendations

1. **TWAP Implementation:** If DEX prices are needed, implement or require:
   ```rust
   // Example TWAP interface
   fn get_price_twap(env: Env, token: Address, window_seconds: u64) -> i128;
   ```

2. **Oracle Health Monitoring:** Enhance existing `check_oracle_health()` to track:
   - Price volatility within time windows
   - Deviation from other price sources
   - Manipulation detection heuristics

3. **Fallback Mechanisms:** Consider multiple price oracle redundancy with:
   - Primary: Off-chain signed feed
   - Secondary: TWAP-protected DEX oracle
   - Tertiary: Governance-controlled emergency price

### Documentation Updates Required

1. **Threat Model:** Add section "D3. Price Oracle Sandwich Attacks"
2. **Oracle Provider Vetting:** Add sandwich attack resistance criteria
3. **Governance Guidelines:** Add oracle approval checklist item for price manipulation resistance
4. **Developer Documentation:** Warn against using spot DEX prices without TWAP

## Conclusion

The ILN system currently has **LOW exposure** to oracle sandwich attacks because:
1. Identity verification oracle uses off-chain data (no price sensitivity)
2. Price oracle usage is limited to statistical reporting (not financial operations)
3. Current test implementations use mock data

However, **future integrations could introduce HIGH risk** if:
- Price oracles are used for financial calculations (e.g., collateral valuation)
- DEX spot prices are used without TWAP protection
- Oracle providers don't implement manipulation-resistant mechanisms

**Recommendation:** Implement governance controls now to prevent high-risk oracle integrations before they occur.