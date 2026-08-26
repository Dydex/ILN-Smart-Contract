#![cfg(test)]

//! ADR-011 — reputation state is independent across contracts.
//!
//! Asserts the documented relationship: `invoice_liquidity` and
//! `reputation_bonus` each maintain their own reputation storage for the
//! same address. Updating one never mutates the other (no sync, no
//! double-counting of a single protocol event).

use super::*;
use crate::test::setup;
use reputation_bonus::{
    config::Config as RepBonusConfig, ReputationBonusContract, ReputationBonusContractClient,
};
use soroban_sdk::testutils::Address as _;

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

#[test]
fn test_reputation_state_is_independent_across_contracts() {
    let t = setup();
    let address = t.payer.clone();

    // ── Deploy standalone reputation_bonus (own storage domain) ──────────
    let bonus_id = t.env.register_contract(None, ReputationBonusContract);
    let bonus = ReputationBonusContractClient::new(&t.env, &bonus_id);
    let bonus_admin = Address::generate(&t.env);
    bonus.init(&bonus_admin);
    bonus.set_config(&RepBonusConfig {
        high_rep_threshold: 80,
        bonus_bps: 200,
        min_discount_rate_bps: 100,
    });

    // Baseline: ILN ReputationProfile is zeroed until activity; payer_score
    // defaults to 50. Bonus module starts empty.
    let iln_before = t.contract.get_reputation(&address);
    let bonus_before = bonus.get_reputation(&address);
    assert_eq!(t.contract.payer_score(&address), 50, "ILN default payer score");
    assert_eq!(iln_before.score, 0, "ILN profile unset until first write");
    assert_eq!(bonus_before.score, 0, "bonus module empty profile");
    assert_eq!(bonus_before.invoices_submitted, 0);
    assert_eq!(iln_before.invoices_submitted, 0);

    // ── Mutate ILN only (submit + fund + mark paid) ───────────────────────
    let now = t.env.ledger().timestamp();
    let due_date = now + DUE_DATE_OFFSET;
    let id = t.contract.submit_invoice(
        &t.freelancer,
        &address,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);

    let iln_after_protocol = t.contract.get_reputation(&address);
    let bonus_unchanged = bonus.get_reputation(&address);
    assert_eq!(iln_after_protocol.invoices_paid, 1);
    assert_eq!(t.contract.payer_score(&address), 51);
    assert_eq!(
        bonus_unchanged, bonus_before,
        "reputation_bonus must ignore ILN lifecycle events (ADR-011)"
    );

    // ── Mutate reputation_bonus only ─────────────────────────────────────
    let freelancer = Address::generate(&t.env);
    let bonus_invoice = bonus.submit_invoice(
        &freelancer,
        &address,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
    );
    bonus.mark_paid(&bonus_invoice.id);

    let bonus_after = bonus.get_reputation(&address);
    let iln_after_bonus = t.contract.get_reputation(&address);
    let iln_payer_score_after_bonus = t.contract.payer_score(&address);

    assert_eq!(bonus_after.invoices_submitted, 1);
    assert_eq!(bonus_after.invoices_paid, 1);
    assert_eq!(bonus_after.score, 100);
    assert_eq!(
        iln_payer_score_after_bonus, 51,
        "ILN reputation must ignore reputation_bonus lifecycle events (ADR-011)"
    );
    assert_eq!(
        iln_after_bonus.invoices_paid, iln_after_protocol.invoices_paid,
        "ILN counters must not absorb bonus-module invoices"
    );

    // Same address, two stores, intentionally divergent — documented SoT split.
    assert_ne!(
        iln_payer_score_after_bonus, bonus_after.score,
        "divergence is expected; there is no reconciliation between contracts"
    );
}
