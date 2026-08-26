# Mainnet Launch Checklist

This checklist tracks the minimum readiness requirements before ILN mainnet deployment. Status values are maintained manually during planning and automatically refreshed for rows that link to GitHub issues when those issues are closed or reopened.

Status legend: `Not started`, `In progress`, `Blocked`, `Complete`.

## Security

| Item | Description | Owner | Status | Link |
|------|-------------|-------|--------|------|
| External security audit | Complete an external audit of all Soroban contracts, deployment scripts, SDK transaction builders, indexer APIs, and notifications webhooks. | Security lead | Complete | [#298](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract/issues/298) |
| Coverage thresholds met | Enforce and publish coverage thresholds for contracts, SDK, indexer, and notifications before launch. | QA lead | In progress | [CI workflow](../.github/workflows/ci.yml) |
| Fuzz tests run | Run the `iln_fuzz` crate and contract property suites against launch candidates and archive results. | Contracts lead | In progress | [contracts/fuzz](../contracts/fuzz) |
| Threat model reviewed | Review protocol threats, update mitigations, and record unresolved accepted risks. | Security lead | In progress | [Threat Model](threat-model.md) |
| Security policy complete | Publish component-specific reporting, response, safe-harbor, and severity guidance. | Security lead | Complete | [#299](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract/issues/299) |

## Contracts

| Item | Description | Owner | Status | Link |
|------|-------------|-------|--------|------|
| Upgrade path tested | Test upload, deploy, migration, rollback decision points, and post-upgrade smoke checks. | Contracts lead | In progress | [Upgrade Guide](upgrade-guide.md) |
| Multi-sig admin configured | Configure production admin as a multi-sig account or equivalent governance-controlled authority. | Governance lead | Not started | [Access Control](access-control.md) |
| Storage layout frozen | Confirm storage keys, schema, and migration compatibility are launch-ready. | Contracts lead | In progress | [Storage Layout](storage-layout.md) |
| Insurance pool readiness | Ensure insurance pool contract has test coverage >= 95%, completed security audit, deployment verification, and SDK integration. | Contracts lead | Not started | [Insurance Pool](../contracts/insurance_pool) |
| Mainnet deployment runbook | Dry-run every deployment command and record final runbook approvals. | Release lead | Not started | [Developer Quickstart](developer-quickstart.md) |
| Contract IDs published | Publish verified mainnet contract IDs and SAC addresses after deployment. | Release lead | Not started | [README](../README.md) |

## Infrastructure

| Item | Description | Owner | Status | Link |
|------|-------------|-------|--------|------|
| Indexer deployed | Deploy production indexer with backup, restore, and replay procedures. | Infrastructure lead | In progress | [indexer](../indexer) |
| Monitoring configured | Configure health checks, alerting, log retention, and on-call routing for indexer and notifications. | Infrastructure lead | In progress | [monitoring-runbook.md](monitoring-runbook.md) |
| Notifications deployed | Deploy webhook/email notifications with HMAC signing, rate limiting, and SSRF controls verified. | Infrastructure lead | In progress | [notifications](../notifications) |
| Incident response runbook | Publish escalation, rollback, advisory, and user-communication steps. | Security lead | Not started | [Security Policy](security.md) |
| Deployment secrets reviewed | Confirm production secrets are stored in GitHub Actions or approved secret management only. | Release lead | In progress | [Deploy testnet workflow](../.github/workflows/deploy-testnet.yml) |

## Documentation

| Item | Description | Owner | Status | Link |
|------|-------------|-------|--------|------|
| Local development guide complete | Verify a fresh-machine local setup path for contracts, Docker, SDK, CLI, indexer, and notifications. | Docs lead | Complete | [#300](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract/issues/300) |
| Glossary complete | Publish protocol terminology for DeFi, invoice factoring, Stellar, and ILN-specific terms. | Docs lead | Complete | [#301](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract/issues/301) |
| SDK guide complete | Confirm SDK examples match current contract IDs, methods, and error handling. | SDK lead | In progress | [SDK Integration](sdk-integration.md) |
| Security docs linked | Link security policy from root, docs index, and release checklist. | Docs lead | In progress | [Security Policy](security.md) |
| User-facing launch notes | Prepare final mainnet usage, known limitations, and migration notes. | Release lead | Not started | [CHANGELOG](../CHANGELOG.md) |

## Community

| Item | Description | Owner | Status | Link |
|------|-------------|-------|--------|------|
| CONTRIBUTING up to date | Confirm contribution, review, testing, and local setup expectations are current. | Community lead | In progress | [CONTRIBUTING](../CONTRIBUTING.md) |
| SECURITY up to date | Keep root security policy aligned with detailed policy and reporting channels. | Security lead | In progress | [SECURITY](../SECURITY.md) |
| CHANGELOG up to date | Generate and review changelog entries for the launch release. | Release lead | Not started | [CHANGELOG](../CHANGELOG.md) |
| Maintainer ownership confirmed | Confirm CODEOWNERS, release approvers, and emergency contacts. | Community lead | In progress | [CODEOWNERS](../.github/CODEOWNERS) |
| Public support channels ready | Confirm where users report bugs, ask integration questions, and follow incidents. | Community lead | Not started | [Issue templates](../.github/ISSUE_TEMPLATE) |

## Maintainer Sign-off

Mainnet launch requires sign-off from core maintainers after all blocking items are complete.

| Maintainer | Area | Signed off | Date | Notes |
|------------|------|------------|------|-------|
| TBD | Contracts | No | TBD | Pending audit and upgrade dry run. |
| TBD | Security | No | TBD | Pending advisory process and incident runbook review. |
| TBD | Infrastructure | No | TBD | Pending production monitoring and deployment runbook. |
| TBD | Documentation | No | TBD | Pending final guide review. |
| TBD | Community | No | TBD | Pending support channel confirmation. |

## Automation

Rows that include GitHub issue links are updated by `.github/workflows/mainnet-checklist-sync.yml`:

- Closed linked issue: status becomes `Complete`.
- Reopened linked issue: status becomes `In progress`.
- Unlinked rows remain manually maintained.
