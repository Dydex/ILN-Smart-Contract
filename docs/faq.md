# Frequently Asked Questions (FAQ)

This document addresses common questions about the Invoice Liquidity Network (ILN). For more in-depth technical details, please refer to our [Architecture](Architecture.md) and [Developer Quickstart](developer-quickstart.md) guides.

## General

### 1. What is the Invoice Liquidity Network (ILN)?
The ILN is a two-sided decentralized protocol built on Stellar's Soroban smart contracts. It acts as a trustless escrow connecting invoice holders (SMEs, freelancers) who need early liquidity with liquidity providers (LPs) who fund invoices at a discount. All payment terms are strictly enforced on-chain. For a detailed breakdown of the money flow, see our [Architecture](Architecture.md).

### 2. Who can use the ILN protocol?
The protocol is designed for freelancers, small to medium-sized enterprises (SMEs), payers (clients), and liquidity providers (LPs). Anyone with a compatible Stellar wallet can interact with the smart contracts. See our [Access Control](access-control.md) guide for details on roles and authentication.

### 3. How does the escrow mechanism work?
When an invoice is submitted, it enters a `Pending` state. Once funded by an LP, the funds are routed to the freelancer, and the invoice becomes `Funded`. The smart contracts hold state and route final payments when the payer settles the debt, ensuring trustless execution. Read more in the [Architecture](Architecture.md) documentation.

### 4. Is ILN a decentralized application?
Yes, ILN is fully decentralized with no backend server controlling state transitions. All transitions are driven by signed on-chain invocations and governed by the `iln_governance` contract. Discover how proposals and voting work in the [Governance](governance.md) guide.

### 5. Are there any restrictions on geographic locations?
As a permissionless protocol on the Stellar network, the ILN smart contracts do not enforce geographic restrictions. However, users must ensure they comply with their local jurisdictions regarding cryptocurrency usage and taxation. For compliance tools, you might explore integrating an [Oracle](oracle-integration.md).

---

## For Freelancers

### 6. How do I submit an invoice to the network?
Freelancers can submit an invoice by calling the `submit_invoice` function on the `invoice_liquidity` contract. You'll need to specify the invoice amount, expected payment date, and the requested discount rate. You can find hands-on examples in the [First Invoice Tutorial](tutorials/first-invoice.md).

### 7. What are the minimum and maximum invoice amounts?
The protocol parameters, including minimum and maximum invoice amounts, are controlled dynamically via the on-chain governance system. This ensures the network can adapt to varying liquidity and economic conditions. Check the current parameters by reading the [Governance](governance.md) documentation.

### 8. What happens if my invoice is not funded?
If your invoice does not attract an LP within a reasonable time, it remains in the `Pending` state. You have the option to cancel it or leave it open for future funding. The [Contract ABI](contract-abi.md) details the `cancel_invoice` function used for this purpose.

### 9. Can I cancel an invoice after submission?
Yes, you can cancel an invoice as long as it is still in the `Pending` state and has not been funded by an LP. Once it is partially or fully funded, the invoice is locked into the escrow terms. Refer to the [Contract ABI](contract-abi.md) for execution details.

### 10. How does the reputation bonus affect my discount rate?
A high reputation score can grant you a reputation-based discount bonus, making your invoices more attractive to LPs or allowing you to retain more principal. The system tracks your successful on-chain history and adjusts your score dynamically. Learn about the scoring formula in the [Reputation Model](reputation-model.md).

---

## For LPs (Liquidity Providers)

### 11. How does yield generation work for Liquidity Providers?
LPs fund invoices at a discount (e.g., funding 90 USDC for a 100 USDC invoice). When the payer settles the full invoice amount, the LP receives their principal plus the yield (the 10 USDC difference). The exact payout logic is explained in the [Architecture](Architecture.md) document.

### 12. What are the risks of default on funded invoices?
If a payer fails to settle the invoice by the due date, the invoice may default. In such cases, the LP absorbs the loss, though future protocol upgrades may introduce insurance or fractional recovery mechanisms. Please review the [Threat Model](threat-model.md) for a comprehensive list of risks.

### 13. When can I withdraw my funds from a funded invoice?
Funds are locked in the escrow contract until the payer calls `mark_paid` or the invoice undergoes a formal default or dispute resolution. There is no premature withdrawal for LPs to ensure the freelancer has guaranteed liquidity. See the [Events](events.md) page to learn how to track settlement.

### 14. Can I partially fund an invoice?
The protocol supports transitioning an invoice to a `PartiallyFunded` state if the LP does not cover the full requested amount. This allows multiple LPs to pool resources for larger invoices. You can test this flow using our [SDK Integration Guide](sdk-integration.md).

### 15. How are rewards and incentives distributed?
Beyond standard yield, LPs may receive additional token rewards distributed via the `iln_distribution` contract to bootstrap network liquidity. These incentives are tied to the governance token. Details on claiming rewards are available in the [Governance](governance.md) guide.

---

## For Payers

### 16. Why should I pay invoices on-chain?
Paying on-chain provides an immutable, transparent, and instantly verifiable proof of payment. It also builds your on-chain reputation, which can lead to better terms for the freelancers you work with. The technical flow is outlined in the [Architecture](Architecture.md) document.

### 17. What happens if there is a dispute regarding the work?
If the delivered work is unsatisfactory, payers or freelancers can trigger a dispute state, halting automated settlement. The resolution process is managed on-chain, often requiring a designated arbiter or governance vote. Read about the `Disputed` state in the [Contract ABI](contract-abi.md).

### 18. How do I mark an invoice as paid?
Payers call the `mark_paid` function on the `invoice_liquidity` contract, transferring the required tokens (e.g., USDC) into the escrow, which then automatically routes them to the LP. An example script for this is provided in the [First Invoice Tutorial](tutorials/first-invoice.md).

### 19. Does paying early improve my reputation score?
Yes, consistent and early payments positively impact your payer reputation score. Protocol reputation is tracked by `invoice_liquidity` (the source of truth for funding gates, defaults, and appeals). The separate `reputation_bonus` contract maintains its own counters only for invoices submitted through that module — the two stores are intentionally independent (see [ADR-011](adr/ADR-011-reputation-state-source-of-truth.md)). Discover the exact weighting in the [Reputation Model](reputation-model.md).

### 20. Do I need to hold crypto to pay an invoice?
Currently, payments must be made using supported Stellar network tokens (such as USDC or XLM). However, many ecosystem wallets and anchors provide seamless fiat on-ramps to convert traditional currency to USDC instantly. Check the [Multi-Token Support](multi-token.md) guide for details.

---

## Technical

### 21. Which wallets are supported by ILN?
ILN is compatible with any Stellar wallet that supports Soroban smart contract invocations, such as Freighter. We recommend using our official SDK to easily integrate wallet connections into your frontend. Examples can be found in the [SDK Usage Guide](../sdk/README.md).

### 22. What tokens are supported for invoice funding and settlement?
The contracts primarily support Stellar Asset Contracts (SAC) representing stablecoins like USDC and native XLM. The list of allowed tokens is governed by the `invoice_liquidity` contract. You can review the token configuration in the [Multi-Token Support](multi-token.md) document.

### 23. Is the protocol currently available on the Stellar Mainnet?
Currently, ILN is extensively tested and deployed on the Stellar Testnet for developer integration and testing. Mainnet deployment will follow after comprehensive security audits. You can find testnet contract IDs in the [Developer Quickstart](developer-quickstart.md).

### 24. What are the transaction fees for using ILN contracts?
Because ILN is built on Stellar, transaction fees (gas) for invoking Soroban contracts are exceptionally low, typically costing fractions of a cent in XLM. For a detailed breakdown of resource consumption, refer to our [Benchmarks](benchmarks.md).

### 25. How do I integrate my application with the ILN contracts?
Developers can use our `@iln/sdk` NPM package, which provides heavily typed TypeScript wrappers for all contract functions. We provide complete setup and usage examples in the [SDK Integration Guide](sdk-integration.md).
