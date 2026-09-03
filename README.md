# NexusGenesis

> **Agent Autonomous Security & Coordination Standard Layer** — the security-first
> foundation for AI agents: self-custodied private keys, quantum-resistant signatures,
> and human takeover for compliance. **Private keys never leave the agent or browser.**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/nexus-genesis/nexusgenesis/actions/workflows/ci.yml/badge.svg)](https://github.com/nexus-genesis/nexusgenesis/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-818cf8)](https://modelcontextprotocol.io)

> 📊 [Status → STATUS.md](STATUS.md) · [Security → SECURITY.md](SECURITY.md) · [Governance Spec → docs/GOVERNANCE_SPEC.md](docs/GOVERNANCE_SPEC.md) · 🔒 [Security Audit (2026-08-07) → docs/SECURITY_AUDIT_SUMMARY_2026-08-07.md](docs/SECURITY_AUDIT_SUMMARY_2026-08-07.md)

**Keywords:** AI Agents · Autonomous Agents · Key Management · Post-Quantum Cryptography · Self-Custody · Human Takeover · Agent Security · Agent Coordination · MCP · Multi-Agent System · Dilithium2 · FIPS 204

---

## Quickstart — 5 lines to an Agent identity

Give your AI agent a **self-custodied, quantum-resistant identity** in 5 lines:

```bash
npm install nexusgenesis-agent-keys
```

```js
import { generateKeyPair, sign, verify } from 'nexusgenesis-agent-keys';

const { publicKey, privateKey } = await generateKeyPair(); // Dilithium2, FIPS 204
const sig = await sign('payload', privateKey);             // sign a message
const ok  = await verify('payload', sig, publicKey);       // true — verifiable
```

The private key is generated **on your side** and never leaves the process — no server, no cloud wallet, no key escrow. A human can always take control back via the takeover mechanism.

> 🚀 See the full API in [`nexusgenesis-agent-keys`](packages/agent-keys) or the [SDK](packages/agent-sdk) for task/reputation coordination.

---

## What is this?

NexusGenesis is an **open standard and reference implementation** for securing autonomous AI agents. Most agent frameworks hold an agent's private keys on a server or in process memory. NexusGenesis implements the opposite model:

- **Self-custody** — private keys are generated and stored on the agent/browser and **never leave the caller**.
- **Quantum-resistant** — signatures use CRYSTALS-Dilithium2 (NIST FIPS 204) via `@noble/post-quantum`.
- **Human takeover** — a human can always regain control of an autonomous agent, with spend limits and an approval mode, for compliance and accountability.

On top of this security core, a lightweight **coordination protocol** lets agents publish tasks, build reputation, and collaborate — chain-agnostic over a pluggable transport.

---

## The problem NexusGenesis solves

| Concern | Typical agent frameworks | NexusGenesis |
|---------|--------------------------|--------------|
| Where do keys live? | Server / in-memory | **On the agent/browser** (self-custody) |
| Quantum threat | Not addressed | **Dilithium2 (FIPS 204)** signatures |
| Human oversight | Little or none | **Human takeover** + spend limits + approval mode |
| At-rest security | Often plaintext | **AES-256-GCM + PBKDF2** encryption |
| Coordination | Proprietary / siloed | **Open, chain-agnostic** protocol |

---

## Published Packages (npm)

| Package | Purpose |
|---------|---------|
| [`nexusgenesis-agent-keys`](packages/agent-keys) | Security core: PQC keys, encryption, derivation, custody, takeover |
| [`nexusgenesis-agent-sdk`](packages/agent-sdk) | Agent framework: self-sovereign identity + coordination |
| [`nexusgenesis-chain-eth`](packages/chain-eth) | EVM adapter: derive secp256k1 wallet from PQC root identity |
| [`nexusgenesis-chain-sol`](packages/chain-sol) | Solana adapter: derive ed25519 wallet from PQC root identity |
| [`nexusgenesis-chain-adapters`](packages/chain-adapters) | One PQC root identity → addresses on every supported chain |
| [`nexusgenesis-agent-mcp`](mcp-server) | MCP server exposing the security & coordination tools |

```bash
# Install the framework (pulls agent-keys automatically)
npm install nexusgenesis-agent-sdk
```

---

## Repository Layout

This repository intentionally contains three different layers of code:

### 1. Current released packages

These are the packages aligned with npm publishing, CI, and the GitHub landing page:

- [`packages/agent-keys`](packages/agent-keys)
- [`packages/agent-sdk`](packages/agent-sdk)
- [`packages/chain-eth`](packages/chain-eth)
- [`packages/chain-sol`](packages/chain-sol)
- [`packages/chain-adapters`](packages/chain-adapters)
- [`mcp-server`](mcp-server)

### 2. Archived legacy code

The original L1 chain and its companion files have been cut and moved to
[`archive/L1/`](archive/L1/) (see ARCHIVED-L1.md). They are retained **only** for
historical reference and are **not** part of the security-standard layer, CI, or npm
publishing. No new development targets `archive/`.

### 3. Internal experimental packages

These are useful for internal testing or future packaging work, but they are **not**
part of the current npm release set and are not part of the public package matrix:

- [`packages/agent-keys-cli`](packages/agent-keys-cli)
- [`packages/agent-keys-mcp`](packages/agent-keys-mcp)
- [`examples`](examples)

CI and npm publish are intentionally aligned to the **current released packages** only.

---

## Quick start

### 1. Create a self-sovereign agent identity

```javascript
import { createAgentIdentity, signAsAgent } from 'nexusgenesis-agent-sdk';

const identity = await createAgentIdentity({ password: 'agent-secret-123' });
// { address: 'ng1...', publicKeyHex, envelope, keyModel: 'self-sovereign' }

// Private key is encrypted and NEVER leaves the caller.
```

### 2. Sign with post-quantum keys

```javascript
import { generateKeyPair, sign, verify } from 'nexusgenesis-agent-keys';

const { publicKey, privateKey } = await generateKeyPair();
const sig = await sign('payload', privateKey);
const ok = await verify('payload', sig, publicKey); // true
```

### 3. Human takeover for compliance

```javascript
import { takeoverGuard, checkSpendAllowed, SPEND_MODES } from 'nexusgenesis-agent-keys';

const before = { type: SPEND_MODES.UNLIMITED };
// ...after an autonomous operation, verify control didn't change:
if (takeoverGuard(before, { type: SPEND_MODES.UNLIMITED })) {
  // safe to commit the value transfer
}
```

### 4. Use the MCP server

```bash
npx nexusgenesis-agent-mcp
# Adds agent identity, key generation, and coordination tools to Claude / Cursor
```

---

## Security properties

- **Signatures** — CRYSTALS-Dilithium2 (NIST FIPS 204) via `@noble/post-quantum`
- **At-rest encryption** — AES-256-GCM + PBKDF2-HMAC-SHA512 (310,000 iterations, OWASP 2023)
- **Key derivation** — HKDF-SHA256, deterministic per-(agent, version) operation keys
- **Custody tokens** — HMAC-SHA256, short-lived (24h), bound to a public-key fingerprint
- **Human takeover** — spend limits + require-approval mode + mid-operation control-change guard

See [SECURITY.md](SECURITY.md) and the [security audit report](docs/SECURITY_AUDIT_REPORT_2026-08-07.md).

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│            NexusGenesis Security Standard           │
├─────────────────────────────────────────────────────┤
│  agent-keys (security core)                         │
│    ├── PQC signatures (Dilithium2 / FIPS 204)       │
│    ├── AES-256-GCM at-rest encryption               │
│    ├── Three-tier key derivation (HKDF)             │
│    └── Human takeover + spend controls              │
├─────────────────────────────────────────────────────┤
│  agent-sdk (framework)                              │
│    ├── keys — self-sovereign identity               │
│    └── coordination — chain-agnostic task/reputation│
├─────────────────────────────────────────────────────┤
│  chain-adapters (one root → many chains)            │
│    ├── chain-eth  (secp256k1 / EIP-191)             │
│    └── chain-sol  (ed25519 / base58)                │
└─────────────────────────────────────────────────────┘
```

---

## Documentation

| Resource | Link |
|----------|------|
| **Agent keys** | [packages/agent-keys/README.md](packages/agent-keys/README.md) |
| **Agent SDK** | [packages/agent-sdk/README.md](packages/agent-sdk/README.md) |
| **MCP server** | [mcp-server/README.md](mcp-server/README.md) |
| **Security policy** | [SECURITY.md](SECURITY.md) |
| **Security audit (2026-08-07)** | [docs/SECURITY_AUDIT_REPORT_2026-08-07.md](docs/SECURITY_AUDIT_REPORT_2026-08-07.md) |
| **Governance spec** | [docs/GOVERNANCE_SPEC.md](docs/GOVERNANCE_SPEC.md) |
| **Human takeover design** | [docs/human-takeover-mechanism.md](docs/human-takeover-mechanism.md) |
| **LLMs.txt** | [llms.txt](llms.txt) |

---

## Status

The security standard layer is **stable and published**. The released package set is:
`nexusgenesis-agent-keys`, `nexusgenesis-agent-sdk`, `nexusgenesis-chain-eth`,
`nexusgenesis-chain-sol`, `nexusgenesis-chain-adapters`, and
`nexusgenesis-agent-mcp`. These packages ship independently, are test-covered,
and are the packages targeted by CI and npm publish.

The original NexusGenesis **independent L1 testnet** has been **archived** (see
`archive/L1/`). It operated as a single-node devnet and carried no economic value.
Ongoing development and all published packages focus exclusively on the agent
key-custody / authorization layer above.

---

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before opening issues or pull requests.

---

## License

MIT
