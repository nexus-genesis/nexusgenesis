# HackerNews "Show HN" — NexusGenesis

## Posting Strategy

- **Day:** Tuesday or Wednesday
- **Time:** 08:00–10:00 PT (11:00–13:00 ET / 23:00–01:00 Beijing)
- **Account:** Use a real GitHub-linked HN account with prior activity
- **Follow-up:** Monitor for 24h, reply to every top-level comment within 30 min

---

## Title

```
Show HN: NexusGenesis — Post-quantum self-custody keys for AI agents, with human takeover
```

**Alternatives (if too long):**
```
Show HN: NexusGenesis — Quantum-resistant key security for autonomous AI agents
```
```
Show HN: NexusGenesis — Private keys that never leave your AI agent
```

---

## Post Body

```markdown
HN,

I built NexusGenesis — an open security standard + reference implementation for
autonomous AI agents. The core idea is deliberately simple and, I think,
under-addressed by every agent framework out there:

**An agent's private keys should never leave the agent. And a human should
always be able to take control back.**

**What it does right now (published on npm):**

- `nexusgenesis-agent-keys` — the security core. Post-quantum signatures
  (CRYSTALS-Dilithium2, NIST FIPS 204), AES-256-GCM at-rest encryption,
  three-tier key derivation, and a **human takeover** mechanism with spend
  limits and an approval mode.
- `nexusgenesis-agent-sdk` — a framework wrapping that core: self-sovereign
  agent identity + a chain-agnostic task/reputation coordination protocol.
- `nexusgenesis-chain-eth` / `nexusgenesis-chain-sol` / `nexusgenesis-chain-adapters`
  — derive an EVM (secp256k1) or Solana (ed25519) wallet from one PQC root identity.
- `nexusgenesis-agent-mcp` — an MCP server so Claude / Cursor can create keys, sign,
  and coordinate directly.

**Why this exists:**

Most agent frameworks (AgentKit, Olas, Fetch, LangChain) hold agent private keys
on a server or in process memory. That's a single point of compromise and it
gives the operator control over the agent. NexusGenesis flips that: keys are
generated and stored on the agent/browser, **never leave the caller**, and use
post-quantum signatures so they survive the transition to a quantum-threat world.
The human-takeover layer exists because full autonomy without an escape hatch is
both dangerous and (in many regulated settings) non-compliant.

**How to try it (3 paths):**

1. npm:
   `npm install nexusgenesis-agent-sdk`
2. MCP (Claude Desktop / Cursor):
   `npx nexusgenesis-agent-mcp`
3. Read the code / docs:
   https://github.com/nexus-genesis/nexusgenesis

**Stack:**
- CRYSTALS-Dilithium2 post-quantum signatures (NIST FIPS 204) via @noble/post-quantum
- AES-256-GCM + PBKDF2-HMAC-SHA512 (310k iterations, OWASP 2023)
- HKDF-SHA256 three-tier key derivation
- HMAC-SHA256 short-lived custody tokens
- Zero runtime dependencies in the core package

**Honest state:**
This is a security library + framework, not a network. There is no token, no
fundraising, and no blockchain dependency for the core packages — the L1 testnet
that originally hosted this now runs as a devnet/demo. The focus is on a
reusable, auditable key-security standard.

Repo: https://github.com/nexus-genesis/nexusgenesis

I'd love feedback on:
- Is the "human takeover" model the right escape hatch for autonomous agents?
- Should spend controls be policy-driven (declarative) or code-driven?
- What chain or framework should I integrate next after EVM + Solana + MCP?
```

---

## Comment Response Templates

Pre-written responses for common HN comment patterns. Adapt tone to match the
commenter's style.

### "Why post-quantum? That's years away."

```
Fair question. Two reasons:
1. Long-lived value: keys signed today with Ed25519/Secp256k1 become breakable
   the day a large-enough quantum computer exists. Signatures are meant to last
   for years, so hardening now is cheap insurance.
2. Dilithium2 is already a finalized NIST standard (FIPS 204), and @noble is a
   well-audited reference. There's no reason not to use it for new systems.
It costs almost nothing to be forward-safe, so we are.
```

### "How is this different from a normal keychain / HSM?"

```
The difference is in what an AI agent needs:
- Agent private keys are used at runtime by software, not by a human. So the
  threat model is an autonomous process, not a stolen laptop.
- The keys must be usable in a browser and in an agent process with zero
  infrastructure, so a hardware HSM is often not an option.
- We add a human-takeover layer on top: spend limits + approval mode + a guard
  that detects if control changed mid-operation. That's the autonomy-with-
  accountability piece generic keychains don't have.
```

### "How is this different from WebAuthn / passkeys?"

```
WebAuthn is excellent for human authentication. This targets machine identity:
agents acting autonomously with no human at the keyboard. WebAuthn is tied to a
browser/authenticator and a relying party; agent keys need to be portable,
derivable across chains, and signable headlessly (CLI, MCP, SDK). Different
threat model, different ergonomics.
```

### "What stops a malicious agent from just sending its own keys to itself?"

```
This is the fundamental autonomy trade-off. No crypto can stop an agent that
is intentionally malicious — crypto protects against external adversaries, not
a compromised process.

What the human-takeover layer addresses is the *policy* side:
- Spend limits cap damage even if the agent is compromised.
- Approval mode requires a human for above-threshold actions.
- The takeover guard detects control changes mid-operation so a transfer isn't
  committed after the human has already revoked autonomy.

It's defense-in-depth, not a silver bullet. Open to stronger models.
```

### "Why not just use a hardware wallet / TPM?"

```
Those are great for humans holding assets. They're impractical as the default
for autonomous agents running in containers, serverless functions, or browsers
where you can't attach hardware. Our model keeps the private key in the agent's
own trusted enclave (its process/browser) and offers an optional path to HSM/TPM
backing for higher-security deployments. Software-first, hardware-optional.
```

### "How is this different from Lit / Privy / Web3Auth?"

```
Those are custodial/MPC *key management services* — the keys live with a third
party or across multiple parties. NexusGenesis is explicitly non-custodial:
the agent generates and holds its own keys, and no service ever sees them.
We also add post-quantum signatures and a human-takeover layer, which those
services don't center on.
```

### "I want to try it. Where do I start?"

```
Quickest:
1. `npm install nexusgenesis-agent-sdk`
2. `node -e "import('nexusgenesis-agent-sdk').then(m => m.createAgentIdentity({password:'x'}))"`
3. Or `npx nexusgenesis-agent-mcp` and ask Claude to "create me an agent identity"
Full docs: https://github.com/nexus-genesis/nexusgenesis
```

### "Where's the technical spec / audit?"

```
- Security audit (2026-08-07): docs/SECURITY_AUDIT_REPORT_2026-08-07.md
- Security policy: SECURITY.md
- Design docs: docs/human-takeover-mechanism.md, docs/GOVERNANCE_SPEC.md
- All in the repo: https://github.com/nexus-genesis/nexusgenesis
```

### Generic "Cool project" / positive comment

```
Thanks! If you're building agent infrastructure, I'd genuinely love to know what
security primitives your agents actually need — that's the exact feedback this
is trying to collect.
```

### Generic "I don't get it" / confused

```
Totally understandable. The shortest version:

Right now, if you want an AI agent to own something or sign something, most
frameworks put its private key on a server you control. NexusGenesis instead
keeps the key on the agent, signs with post-quantum crypto, and gives a human a
reliable way to take control back if the agent misbehaves.

Security-first, non-custodial, quantum-safe, human-accountable. That's it.
```

---

## What NOT to do

- ❌ Don't vote-ring (ask friends to upvote)
- ❌ Don't post at weird hours (stick to PT morning)
- ❌ Don't get defensive on criticism — HN respects "fair point, here's my take"
- ❌ Don't mention "token", "ICO", or "L1 testnet" — those are deprecated directions
- ❌ Don't ignore comments — reply to everything in the first 6 hours
