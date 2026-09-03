# Status — Agent Key-Custody & Authorization Standard Layer

> Current: 2026-09-02. The original NexusGenesis **independent L1 testnet has
> been archived** (see [`archive/L1/`](archive/L1/)). All active development,
> CI, and npm publishing target the agent security layer below.

## Active deliverables

| Area | Package / Path | Status |
|---|---|---|
| Security core (PQC keys, custody, takeover) | `packages/agent-keys` | Stable, 133 tests pass |
| Agent framework | `packages/agent-sdk` | Stable |
| EVM / Solana / multi-chain adapters | `packages/chain-eth`, `chain-sol`, `chain-adapters` | Stable |
| MCP integration | `mcp-server` | Stable, 262 tests pass |
| KMS provider (GAP-001) | `mcp-server/src/kms-provider.js` | In place |
| Remote-signer / Keeper (GAP remote signing) | `mcp-server/src/remote-signer*.js` | In place, staging verified |
| Tamper-evident audit (GAP-002) | `mcp-server/src/audit-*.js` | In place |

## Test baseline

- `packages/agent-keys`: 133 pass
- `packages/agent-sdk`: 108 pass
- `mcp-server`: 262 pass

## Honest boundaries

The upper-layer composition is **not yet third-party audited** (see
`SECURITY_GAP_ANALYSIS.md`). Do not market any package as production-ready until
the outstanding audit (Phase 2 of the pivot roadmap) completes. NGEN / the legacy
L1 carries no economic value and there is no fundraising.