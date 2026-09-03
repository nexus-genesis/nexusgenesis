# Awesome List PR Templates — NexusGenesis

Each PR targets a different awesome-list repo. Use the corresponding template below.
Every PR links to `https://github.com/nexus-genesis/nexusgenesis/blob/master/README.en.md`
as the canonical project description.

---

## 1. awesome-mcp-servers

**Repo:** `github.com/punkpeye/awesome-mcp-servers` (or the canonical awesome-mcp list)

**PR Title:** `Add nexusgenesis-agent-mcp — Agent Key Security & Coordination MCP`

**PR Body:**

```markdown
## NexusGenesis MCP Server

**Repository:** https://github.com/nexus-genesis/nexusgenesis/tree/master/mcp-server
**Install:** `npx nexusgenesis-agent-mcp`
**Category:** AI Agents / Security

NexusGenesis is a security-first standard for autonomous AI agents: post-quantum
self-custody keys (Dilithium2 / NIST FIPS 204), human takeover for compliance,
and a chain-agnostic coordination protocol. The MCP server exposes the security
and coordination tools as callable MCP tools.

### Tools exposed
- `generate_agent_keys` — create a self-sovereign agent identity (keys never leave the caller)
- `generate_keypair` — post-quantum keypair generation
- `verify_signature` — verify a Dilithium2 signature
- `validate_address` — validate an agent / chain address
- `check_spend` — enforce human-takeover spend limits
- `takeover_guard` — detect mid-operation control changes
- `register_agent` — register an agent in the coordination protocol
- `get_agents` / `get_agent` — discover registered agents
- `get_status` — protocol status

### Why this matters
This is an MCP server centered on **agent key security and human accountability** —
not a blockchain wrapper. Private keys never leave the calling process/browser.

### Compliance
- [x] Repository has a license (MIT)
- [x] Package published on npm (`nexusgenesis-agent-mcp`)
- [x] README includes install instructions for Claude Desktop / Cursor
- [x] Security audit published (docs/SECURITY_AUDIT_REPORT_2026-08-07.md)
```

---

## 2. awesome-ai-agents

**Repo:** `github.com/e2b-dev/awesome-ai-agents`

**PR Title:** `Add NexusGenesis — Agent Key Security & Coordination Standard`

**PR Body:**

```markdown
## NexusGenesis — Agent Key Security & Coordination Standard

**Repository:** https://github.com/nexus-genesis/nexusgenesis
**License:** MIT
**Category:** Agent Infrastructure / Security

NexusGenesis is an open security standard and reference implementation for
autonomous AI agents: self-custodied private keys that never leave the agent,
post-quantum signatures, and human takeover for compliance.

### What makes it different
- **Non-custodial keys**: agent private keys never leave the agent/browser
- **Quantum-resistant**: CRYSTALS-Dilithium2 (NIST FIPS 204) signatures
- **Human takeover**: spend limits + approval mode + control-change guard
- **Chain-agnostic**: derive EVM / Solana wallets from one PQC root identity
- **Zero runtime deps** in the core package
- **MCP-compatible**: `nexusgenesis-agent-mcp` for Claude / Cursor

### Packages
- `nexusgenesis-agent-keys` — security core
- `nexusgenesis-agent-sdk` — agent framework (keys + coordination)
- `nexusgenesis-chain-eth` / `chain-sol` / `chain-adapters` — chain adapters
- `nexusgenesis-agent-mcp` — MCP server

### Status
Stable, published on npm, test-covered, security-audited (2026-08-07).
```

---

## 3. awesome-llm-apps

**Repo:** `github.com/Shubhamsaboo/awesome-llm-apps`

**PR Title:** `Add NexusGenesis — LLM Agent Key Security & Coordination`

**PR Body:**

```markdown
## NexusGenesis — LLM Agent Key Security & Coordination

**Repository:** https://github.com/nexus-genesis/nexusgenesis
**Type:** Infrastructure / Agent Security

NexusGenesis gives LLM-powered agents the security primitives they currently
lack: self-custodied keys, post-quantum signatures, and human accountability.

### How LLM agents use it
1. Any agent (Claude, GPT, Gemini, Qwen) gets a self-sovereign identity
2. Private keys stay on the agent/browser — never on a server
3. Signs with post-quantum crypto (Dilithium2)
4. Human can take over control with spend limits / approval mode
5. Coordinates tasks/reputation over a chain-agnostic protocol

### LLM-specific integrations
- **MCP Server**: Claude Desktop / Cursor agents call it natively
- **JavaScript SDK**: self-sovereign identity + coordination
- **npm**: `nexusgenesis-agent-sdk`, `nexusgenesis-agent-mcp`

This is security infrastructure for agents — not a blockchain with an AI wrapper.
```

---

## 4. awesome-web3-ai / awesome-crypto-ai

**Repo:** The most active `awesome-web3-ai` or `awesome-crypto-ai` repo

**PR Title:** `Add NexusGenesis — Non-Custodial Post-Quantum Keys for AI Agents`

**PR Body:**

```markdown
## NexusGenesis — Non-Custodial Post-Quantum Keys for AI Agents

**Repository:** https://github.com/nexus-genesis/nexusgenesis
**Category:** Infrastructure / Agent Security
**Signatures:** CRYSTALS-Dilithium2 (NIST FIPS 204)
**Key custody:** Non-custodial (self-sovereign)

NexusGenesis is agent-first security infrastructure: AI agents hold their own
keys, sign with post-quantum crypto, and remain human-accountable.

### Web3 AI differentiators
- **Non-custodial**: no server, MPC service, or third party ever holds the keys
- **Post-quantum crypto**: Dilithium2 on all signatures
- **Human takeover**: spend limits, approval mode, control-change guard
- **Chain-agnostic**: one PQC root identity → EVM + Solana addresses
- **Open standard**: MIT, zero runtime deps in the core

### Comparison
| | NexusGenesis | Lit Protocol | Privy | Web3Auth |
|---|-------------|--------------|-------|----------|
| Custody | Self (non-custodial) | MPC / custodial | Custodial | MPC / custodial |
| Post-quantum | Dilithium2 | No | No | No |
| Human takeover | Built-in | No | No | No |
| Agent-native | Yes | No | No | No |
```

---

## 5. awesome-web3-security

**Repo:** The most active web3/security awesome list

**PR Title:** `Add NexusGenesis — Post-Quantum Key Security Standard for Agents`

**PR Body:**

```markdown
## NexusGenesis — Post-Quantum Key Security Standard for Agents

**Repository:** https://github.com/nexus-genesis/nexusgenesis
**License:** MIT
**Signature:** CRYSTALS-Dilithium2 (NIST FIPS 204)
**Encryption:** AES-256-GCM + PBKDF2-HMAC-SHA512 (310k iterations, OWASP 2023)
**Language:** JavaScript (Node.js 18+, ESM)

A security-first standard and reference implementation for autonomous AI agent
keys: self-custody, post-quantum signatures, and human takeover.

### Security highlights
- Dilithium2 signatures (NIST FIPS 204) via @noble/post-quantum
- AES-256-GCM at-rest encryption with PBKDF2 (OWASP-compliant)
- HKDF-SHA256 three-tier key derivation
- Human takeover with spend limits + approval mode + control-change guard
- Zero runtime dependencies in the core package
- Published security audit (2026-08-07)
```

---

## 6. awesome-decentralized-llm

**Repo:** The most active decentralized AI repo (e.g., `github.com/jmikedupont2/awesome-decentralized-llm` or similar)

**PR Title:** `Add NexusGenesis — Non-Custodial Key Security for Decentralized Agents`

**PR Body:**

```markdown
## NexusGenesis — Non-Custodial Key Security for Decentralized Agents

**Repository:** https://github.com/nexus-genesis/nexusgenesis
**Category:** Agent Security / Coordination Protocol

Most decentralized AI focuses on model serving or compute. NexusGenesis addresses
the trust layer: how do autonomous agents hold their own keys securely, sign with
quantum-resistant crypto, and remain accountable to a human?

### Decentralized primitives
- **Self-sovereign identity**: keys live on the agent/browser, never on a server
- **Post-quantum signatures**: Dilithium2 (NIST FIPS 204)
- **Human takeover**: spend limits, approval mode, control-change guard
- **Chain-agnostic coordination**: task/reputation over a pluggable transport

### Why this complements existing projects
Not a model-hosting layer — it's the security substrate agents need *between*
models. Any decentralized inference network (Bittensor, Ritual, etc.) could use
NexusGenesis to give its agents non-custodial, quantum-safe, human-accountable keys.
```

---

## 7. awesome-langchain

**Repo:** `github.com/kyrolabs/awesome-langchain`

**PR Title:** `Add nexusgenesis-agent-mcp — Agent Key Security for LangChain via MCP`

**PR Body:**

```markdown
## nexusgenesis-agent-mcp — Agent Key Security via MCP (LangChain-compatible)

**Repository:** https://github.com/nexus-genesis/nexusgenesis
**MCP Server:** https://github.com/nexus-genesis/nexusgenesis/tree/master/mcp-server
**Install:** `npx nexusgenesis-agent-mcp`

MCP tools that give LangChain agents self-sovereign keys, post-quantum signing,
human-takeover spend control, and coordination.

### Tools for LangChain agents
- `generate_agent_keys` → create a self-sovereign identity (keys never leave the caller)
- `generate_keypair` / `verify_signature` → post-quantum crypto
- `check_spend` / `takeover_guard` → human accountability
- `register_agent` / `get_agents` / `get_status` → coordination

### How LangChain agents use it
```python
# The MCP tools are callable from any MCP-compatible client.
# LangChain can consume MCP servers via langchain-mcp-adapters.
# Keys are generated and held on the caller — never on a server.
```

### Coming
Native LangChain tool package (`langchain-nexusgenesis`) for direct
`from langchain_community.tools import NexusGenesisKeyTool` usage.
```

---

## PR Submission Checklist

| # | Target List | PR Title | Status |
|---|-------------|---------|--------|
| 1 | awesome-mcp-servers | Add nexusgenesis-agent-mcp — Agent Key Security & Coordination MCP | ⬜ |
| 2 | awesome-ai-agents | Add NexusGenesis — Agent Key Security & Coordination Standard | ⬜ |
| 3 | awesome-llm-apps | Add NexusGenesis — LLM Agent Key Security & Coordination | ⬜ |
| 4 | awesome-web3-ai | Add NexusGenesis — Non-Custodial Post-Quantum Keys for AI Agents | ⬜ |
| 5 | awesome-web3-security | Add NexusGenesis — Post-Quantum Key Security Standard for Agents | ⬜ |
| 6 | awesome-decentralized-llm | Add NexusGenesis — Non-Custodial Key Security for Decentralized Agents | ⬜ |
| 7 | awesome-langchain | Add nexusgenesis-agent-mcp — Agent Key Security for LangChain via MCP | ⬜ |

### Common responses

If a maintainer asks about maturity:
```
This is a stable, published, test-covered security library with a public
security audit (docs/SECURITY_AUDIT_REPORT_2026-08-07.md). There is no token,
no fundraising, and no blockchain dependency for the core packages. The focus
is a reusable, auditable key-security standard for autonomous AI agents.
```
