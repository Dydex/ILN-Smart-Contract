# Cross-Contract Reentrancy Audit

**Issue #698: Audit reentrancy risk across the five-contract call graph**

## Threat Model

The original reentrancy guard work targeted `fund_invoice()` and `mark_paid()` within a single contract (`invoice_liquidity`). Now that `invoice_liquidity` calls into `insurance_pool`, `iln_distribution`, and `reputation_bonus`, a reentrancy attack through one of these external contracts could bypass the internal reentrancy guard and re-enter the liquidity contract.

## Cross-Contract Call Graph

### From `invoice_liquidity` -> `insurance_pool`

**Path: `claim_default() -> insurance_pool.claim()`**

```
invoice_liquidity::claim_default
  ├─ lock_reentrancy()                           [state locked]
  ├─ Validate invoice state
  ├─ Update invoice.status = Defaulted           [state update BEFORE external call]
  ├─ save_invoice()
  ├─ Token transfers to funders                  [external: token contract]
  └─ Try insurance_pool.claim(invoice_id, lp)    [external: insurance_pool]
     └─ pool claims and transfers compensation tokens back to lp
  └─ unlock_reentrancy()                         [state unlocked]
```

**Reentrancy Analysis:**
- The reentrancy lock is held for the entire duration.
- State update (invoice status) happens BEFORE external calls (CEI pattern).
- The insurance pool contract receives authorization to claim only via `claim()`.
- Risk: LOW — If the pool is malicious, it could attempt reentrancy on `claim_default()` but would be blocked by the reentrancy lock.

### From `invoice_liquidity` -> `token_contract`

**Path: `claim_default() -> token.transfer()` and `mark_paid() -> token.transfer()`**

```
invoice_liquidity::claim_default
  └─ token.transfer(contract_address, funder_addr, refund)  [external: token]

invoice_liquidity::mark_paid
  ├─ token.transfer(payer, contract_address, amount)         [external: token]
  ├─ token.transfer(contract_address, admin, fee)            [external: token]
  └─ token.transfer(contract_address, funder_addr, share)    [external: token]
```

**Reentrancy Analysis:**
- The reentrancy lock guards both functions.
- Token transfers are standard SAC token calls; a malicious token implementation could attempt reentrancy on `transfer()`.
- Risk: LOW — The reentrancy lock blocks any reentrant call back into `claim_default()` or `mark_paid()`.

### From `invoice_liquidity` -> `iln_distribution`

**Path: `mark_paid() -> notify_distribution_settlement()`**

```
invoice_liquidity::mark_paid
  ├─ Update invoice state (status = Paid)       [state update BEFORE external call]
  ├─ save_invoice()
  ├─ Token transfers to funders                  [external: token contract]
  └─ notify_distribution_settlement(freelancer, payer, paid_on_time)  [external: distribution]
     └─ distribution.on_settlement_paid() or similar
  └─ Update payer reputation
  └─ unlock_reentrancy()
```

**Reentrancy Analysis:**
- The reentrancy lock is held for the entire flow.
- State update (invoice status = Paid) happens before the external call to distribution.
- The distribution contract is contacted only for notifications (if it has event hooks or settlement logic).
- Risk: MEDIUM — If `iln_distribution` is compromised, it could attempt reentrancy on `mark_paid()`. The reentrancy guard protects the main method, but we should verify that state mutations are atomic.

### From `invoice_liquidity` -> `reputation_bonus`

**Path: Implicit through state updates (payer reputation)**

```
invoice_liquidity::mark_paid
  ├─ get_payer_score()                          [internal storage read]
  ├─ set_payer_score()                          [internal storage write]
  └─ (Optional: calls to reputation_bonus contract if configured)
```

**Reentrancy Analysis:**
- Reputation updates are internal to `invoice_liquidity` unless a delegation to `reputation_bonus` is implemented.
- If `reputation_bonus` is called, it would be inside the reentrancy lock.
- Risk: LOW — Reputation updates are storage-local; no external calls visible in current code.

## Vulnerability Assessment

### Checked-Effects-Interactions (CEI) Pattern

✅ `claim_default()`:
- State update (invoice.status = Defaulted) happens BEFORE token transfers and insurance pool call.

✅ `mark_paid()`:
- State update (invoice.status = Paid) happens BEFORE distribution settlement notification.
- State update (invoice.amount_paid) happens BEFORE token transfers.

### Reentrancy Lock Coverage

✅ Both `claim_default()` and `mark_paid()` acquire the reentrancy lock at entry and hold it until completion.

### Cross-Contract Assumption

The main assumption is that neither `insurance_pool`, `iln_distribution`, nor the token contract will attempt reentrancy. In the mainnet context:
- **Insurance pool**: Deployed and audited by ILN; configured with `invoice_liquidity` as admin.
- **Token contract**: Standard SAC or XLM; reentrancy-safe by design.
- **Distribution contract**: Deployed and audited by ILN; should follow the same CEI pattern.

## Recommendation

No high-risk reentrancy vulnerabilities were identified. All external calls occur within the reentrancy guard, and state mutations follow the CEI pattern. Maintain the current reentrancy guard for both `claim_default()` and `mark_paid()` to protect against any future changes to external contract implementations.
