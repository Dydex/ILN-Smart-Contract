# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the ILN Smart Contract.
ADRs capture the context, decision, alternatives considered, and consequences for major
design choices so that future contributors understand *why* the system is built the way it is.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](ADR-001-soroban-chain-choice.md) | Choice of Soroban / Stellar over Other Chains | Accepted |
| [ADR-002](ADR-002-single-contract-architecture.md) | Single-Contract Architecture | Accepted |
| [ADR-003](ADR-003-discount-rate-basis-points.md) | Discount Rate Represented in Basis Points | Accepted |
| [ADR-004](ADR-004-lazy-reputation-decay.md) | Lazy Reputation Decay | Accepted |
| [ADR-005](ADR-005-governance-timelock.md) | Governance Timelock Length (No Timelock in v1) | Accepted |
| [ADR-006](ADR-006-insurance-pool-design.md) | Insurance Pool Design | Accepted |
| [ADR-007](adr-007-nft-invoice-representation.md) | NFT Invoice Representation | Accepted |
| [ADR-008](adr-008-multisig-admin.md) | Multi-Signature Admin | Accepted |
| [ADR-009](ADR-009-quadratic-voting.md) | Quadratic Voting | Accepted |
| [ADR-010](ADR-010-oracle-registry.md) | Oracle Registry | Accepted |
| [ADR-011](ADR-011-reputation-state-source-of-truth.md) | Reputation State Source of Truth | Accepted |

## Template

Use [template.md](template.md) when writing a new ADR.

## Process

1. Copy `template.md` to `ADR-NNN-short-title.md`.
2. Fill in all sections.
3. Set status to `Proposed` and open a PR.
4. After team review, update status to `Accepted` (or `Rejected`).
5. If a later ADR supersedes this one, update the status to `Superseded by ADR-NNN`.
