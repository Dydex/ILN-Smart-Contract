# Documentation Index

Start here when you are looking for ILN protocol, contract, service, or contributor documentation.

## Getting Started

| Document | Description |
|----------|-------------|
| [Developer Quickstart](developer-quickstart.md) | Rust, Stellar CLI, contract build, tests, and testnet deployment. |
| [Local Development Guide](local-development.md) | Full local stack setup for contracts, Docker services, SDK, CLI, indexer, and notifications. |
| [First Invoice Tutorial](tutorials/first-invoice.md) | End-to-end invoice lifecycle walkthrough. |
| [Glossary](glossary.md) | Protocol terminology for DeFi, invoice factoring, Stellar, and ILN-specific concepts. |

## Architecture And Protocol

| Document | Description |
|----------|-------------|
| [Architecture](Architecture.md) | Actors, money flow, state machine, and component boundaries. |
| [Contract ABI](contract-abi.md) | Public contract functions and error codes. |
| [Events](events.md) | Contract event topics and payloads. |
| [Governance](governance.md) | Proposal lifecycle, voting, quorum, and timelocks. |
| [Multi-Token Support](multi-token.md) | SAC, USDC, XLM, and supported token configuration. |
| [Storage Layout](storage-layout.md) | Contract storage keys and data structures. |

## Security And Operations

| Document | Description |
|----------|-------------|
| [Security Policy](security.md) | Vulnerability classes, reporting, response timelines, severity, and safe harbor. |
| [Threat Model](threat-model.md) | Trust assumptions, risks, and mitigations. |
| [Access Control](access-control.md) | Roles and authorization rules. |
| [Upgrade Guide](upgrade-guide.md) | Contract upgrade procedure and safeguards. |
| [Mainnet Launch Checklist](mainnet-launch-checklist.md) | Launch-readiness checklist with owners, statuses, and sign-off. |
| [Pre-Audit Checklist](pre-audit-checklist.md) | Audit preparation tasks. |

## Integrations

| Document | Description |
|----------|-------------|
| [SDK Integration Guide](sdk-integration.md) | TypeScript examples for contract interactions. |
| [SDK README](../sdk/README.md) | Package usage for `@iln/sdk`. |
| [Oracle Design](oracle-design.md) | Optional payer-verification oracle model. |
| [Oracle Integration](oracle-integration.md) | Deploying and registering compatible oracles. |
| [Oracle Provider Vetting](oracle-provider-vetting.md) | Governance vetting criteria and proposal template for approving oracle providers. |
| [Oracle Attack Economics](oracle-attack-economics.md) | Cost/benefit model of oracle manipulation at current parameters, with recommendations. |

## Project Process

| Document | Description |
|----------|-------------|
| [Architecture Decision Records](adr/README.md) | ADR list and decision history. |
| [CI/CD](ci-cd.md) | Continuous integration and deployment workflows. |
| [Code Freeze Procedure](code-freeze-procedure.md) | Release freeze process. |
| [Benchmarks](benchmarks.md) | Gas and resource usage tracking. |
