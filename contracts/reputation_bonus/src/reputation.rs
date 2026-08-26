//! Independent reputation counters for the `reputation_bonus` module only.
//!
//! **Source of truth:** this crate's persistent `ReputationKey` map — *not*
//! `invoice_liquidity`'s `ReputationProfile` / payer scores.
//!
//! The two contracts never sync. Scores for the same address may diverge.
//! Protocol funding / default logic must read ILN reputation; this module's
//! scores apply only to invoices submitted via `reputation_bonus`.
//! See `docs/adr/ADR-011-reputation-state-source-of-truth.md`.

use soroban_sdk::{contracttype, symbol_short, Address, Env, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationScore {
    pub invoices_submitted: u32,
    pub invoices_paid: u32,
    pub invoices_defaulted: u32,
    pub score: u32,
}

#[contracttype]
pub enum ReputationKey {
    Reputation(Address),
}

const REPUTATION_UPDATED: Symbol = symbol_short!("REP_UPD");

impl ReputationScore {
    pub fn new() -> Self {
        ReputationScore {
            invoices_submitted: 0,
            invoices_paid: 0,
            invoices_defaulted: 0,
            score: 0,
        }
    }

    pub fn recalculate_score(&mut self) {
        let divisor = self.invoices_submitted.max(1);
        self.score = (self.invoices_paid as u64)
            .checked_mul(100)
            .and_then(|v| v.checked_div(divisor as u64))
            .map(|v| v as u32)
            .unwrap_or(0)
            .min(100);
    }
}

impl Default for ReputationScore {
    fn default() -> Self {
        Self::new()
    }
}

pub fn read_reputation(env: &Env, address: &Address) -> ReputationScore {
    env.storage()
        .persistent()
        .get(&ReputationKey::Reputation(address.clone()))
        .unwrap_or_default()
}

// env.events().publish() is deprecated in favour of #[contractevent];
// migrating this crate is out of scope here.
#[allow(deprecated)]
pub fn write_reputation(env: &Env, address: &Address, mut reputation: ReputationScore) {
    reputation.recalculate_score();
    env.storage()
        .persistent()
        .set(&ReputationKey::Reputation(address.clone()), &reputation);

    env.events().publish(
        (REPUTATION_UPDATED, address.clone()),
        (
            reputation.invoices_submitted,
            reputation.invoices_paid,
            reputation.invoices_defaulted,
            reputation.score,
        ),
    );
}
