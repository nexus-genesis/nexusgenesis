# Your AI Agent's Private Key Is Someone Else's — Here's How to Fix It

> **TL;DR:** Every mainstream AI agent framework stores private keys in plaintext in server memory, uses pre-quantum cryptography, and gives humans no way to take back control from a compromised agent. We built a pure-JS solution that fixes all three — with Dilithium2 (FIPS 204), memory-sharded secrets, process-isolated signing, and hierarchical spend policies that let humans stay in command. The code is on npm today.

---

## 1. An Uncomfortable Truth

Ask yourself: *who actually holds my agent's private key?*

If you're using LangChain, AutoGPT, CrewAI, ElizaOS, or any of the dozens of agent frameworks that have sprung up in the past 18 months, the answer is almost certainly: **someone else**. Nearly every mainstream framework provides no native memory-safe key management — keys end up in plaintext in server memory, env files, or process heaps.

- **Cloud-hosted agents** (the majority): your agent's key lives on a server you don't control. The provider holds the key material. You hold a session token. This is custodial — you don't own your agent.
- **Self-hosted agents with a wallet SDK**: your key is in an environment variable, a `.env` file, or a plaintext JSON on disk. At runtime, it sits as a contiguous byte buffer in the process heap, readable by anyone who can trigger a core dump, read `/proc/$pid/mem`, or scan swap.
- **MPC/MPC-as-a-service**: your key is split across multiple parties — but you're still trusting their nodes, their network, and their key-generation ceremony. And the underlying crypto is still ECDSA.

The deeper problem isn't just custody. It's **what happens when the agent is compromised**.

A prompt injection, a supply-chain attack on a dependency, or a configuration mistake — any of these can give an attacker read access to the agent's memory. Once they have the private key, they can drain every wallet the agent controls. There is no time lock, no human-in-the-loop, no circuit breaker. The agent has full autonomy, and that autonomy is a single point of failure.

This is not a theoretical concern. In 2024-2025, we saw:

- **Supply-chain attacks** on npm packages that exfiltrated environment variables (including `PRIVATE_KEY`)
- **Prompt injection** that tricked agents into signing malicious transactions
- **Core dumps** from crashed Node.js processes that exposed private keys in plaintext
- **Swap scanning** that recovered keys long after the process had exited

The industry response has been fragmented: "use a hardware wallet" (impractical for autonomous agents), "use MPC" (still trusted third parties), "use a TEE" (requires specific hardware, still early).

We took a different approach. **What if you could hold your agent's key in pure JavaScript — with memory safety, process isolation, and fine-grained spend policies that let humans stay in control?**

This article shows how we built exactly that, and why it matters for the future of autonomous agents.

---

## 2. Why Dilithium2? (A Post-Quantum Detour)

Before we talk about key management, we need to talk about the key itself.

In August 2024, NIST published **FIPS 204** — the final standard for the Module-Lattice-Based Digital Signature Algorithm (ML-DSA), better known as **Dilithium**. This is the first post-quantum signature standard, alongside FIPS 205 (SLH-DSA, aka Sphincs+).

Why does this matter for agent keys? Because an agent's on-chain identity needs to outlast the agent itself. If you deploy an agent today with ECDSA keys, and a quantum computer large enough to break elliptic curve cryptography arrives within its operational lifetime (5-10 years for a long-lived agent), all of that agent's historical signatures become forgeable.

"But quantum computers are years away" — yes, and we're already in the "harvest now, decrypt later" era. State-level actors are collecting encrypted traffic today, waiting for the capability to decrypt it. The same applies to signatures: collect signed messages today, forge new ones tomorrow.

### The Performance Question

The most common objection to Dilithium2 is performance. Let's put numbers on it.

We benchmarked Dilithium2 against ECDSA P-256 and Ed25519 on a standard laptop (Node.js 24, 100 iterations each):

| Metric | Dilithium2 (FIPS 204) | ECDSA P-256 | Ed25519 |
|--------|----------------------|-------------|---------|
| Key Generation | **1.68 ms** | 0.06 ms | 0.05 ms |
| Signing | **6.30 ms** | 0.06 ms | 0.05 ms |
| Verification | **1.68 ms** | 0.01 ms | 0.13 ms |
| Public Key | **1,312 B** | 91 B | 44 B |
| Private Key | **2,560 B** | 138 B | 48 B |
| Signature | **2,420 B** | 64 B | 64 B |

Dilithium2 signing is ~100x slower than ECDSA. But consider what an agent actually spends its time on:

```
Agent cycle:
  ┌─────────────────────────────────────────────────┐
  │  LLM inference: 1,000-30,000 ms                 │
  │  →  Tool selection: 5-50 ms                     │
  │  →  Transaction signing: 6.30 ms (Dilithium2)   │
  │  →  On-chain submission: 1,000-5,000 ms         │
  └─────────────────────────────────────────────────┘
```

The signing is lost in the noise. **The real bottleneck is the LLM, not the signature algorithm.** A 6.3ms signing delay (vs 0.06ms for ECDSA) is irrelevant when the agent spends 1-30 seconds per inference call.

The real costs of Dilithium2 are **signature size** (2,420 bytes vs 64 bytes — matters for on-chain gas) and **key size** (1,312 bytes for a public key, vs 44 bytes for Ed25519). These are genuine trade-offs, but they're manageable.

### Trust Chain

We use `@noble/post-quantum` as the Dilithium2 implementation. The @noble family of cryptographic libraries is the most widely audited JS crypto stack:

- **`@noble/hashes`**: 12M+ weekly npm downloads, used by MetaMask, ethers.js, Ethereum consensus clients
- **`@noble/curves`**: 5M+ weekly downloads
- **`@noble/post-quantum`**: implements FIPS 204 and FIPS 205; newer, carries fewer formal audit cycles
- The underlying `@noble/hashes` and `@noble/curves` libraries have been independently audited by **Cure53**

**Important caveat**: the underlying @noble libraries have been independently audited. **Our composition layer (ShardedSecret, Signer IPC, session keys, tiered policies) has NOT been independently audited** — we plan to run a Code4rena competitive audit once the ecosystem is ready. Read the trust chain statement in `src/pqc.js` for the exact boundary.

---

## 3. Memory Safety: The Private Key That Leaves No Trace

Here's the problem with JavaScript and secrets.

```javascript
// This is how most frameworks handle keys:
const privateKey = Buffer.from(process.env.PRIVATE_KEY, 'hex');
// Now privateKey sits on the heap, as a contiguous byte buffer.
// Even after you delete the reference, the V8 GC may not sweep it
// for seconds or minutes. In the meantime, any of these can read it:
//   - A core dump (kill -SIGABRT, process crash)
//   - /proc/<pid>/mem (if you have the right permissions)
//   - A swap partition (the OS may page out the heap)
```

The problem is not just that the key is in memory. It's that it's in memory as a **contiguous, recoverable sequence of bytes**. A single core dump gives you the entire key.

### The solution: ShardedSecret

Instead of storing the private key as a single contiguous buffer, we split it into two non-contiguous shards using XOR:

```
privateKey = shard₁ ⊕ shard₂
(2560 bytes)    (2560 bytes)    (2560 bytes)
```

The two shards live at different heap addresses. When a signature is needed, they're XOR'd together temporarily, used, and then the result is zeroed immediately. After the operation, each shard exists independently — neither one alone contains the key.

```javascript
import { ShardedSecret } from 'nexusgenesis-agent-keys';

// The constructor zeroes the input buffer after sharding
const sharded = new ShardedSecret(privateKey);
// At this point, `privateKey` is all zeros.
// The key exists only as two non-contiguous shards.

// Sign: transient reassembly, zeroed after use
const sig = sharded.use(pk => signSync(hash, pk));
// `pk` is zeroed before `use()` returns.
// The shards remain, each useless without the other.

// Destroy: zero both shards
sharded.destroy();
```

The `use()` method is the only way to access the full key. It takes a callback, reconstructs the key, calls the callback, and zeroes the reconstructed buffer before returning. The callback runs synchronously, so there's no async gap where the key could be leaked.

### The heap snapshot test

We wanted to verify this empirically. Here's the test design:

1. **Parent process** generates a random 32-byte secret
2. **Child process** receives the secret (via a temp file, not argv/env — no hex string in the child's memory), shards it, forces a transient reassembly (the exact operation that would leave residue), destroys the shards, runs 5 full V8 GC cycles, and writes a complete heap snapshot to disk
3. **Parent process** scans the snapshot for both the binary secret and its ASCII hex representation

The result: **zero hits**. No contiguous plaintext secret, no hex representation, in a full heap dump after GC.

This test validates the mechanism under controlled conditions (32-byte secret, forced GC, immediate snapshot). Real-world heap layouts under sustained load may vary, which is why process isolation is added as a second, independent layer of defense in the next section.

This is not a proof of "perfect security" — it's a proof of "our mechanism works as designed under the V8 garbage collector." The known boundaries are documented in the code: pure software cannot defend against DMA attacks, cold boot attacks, or JTAG/chip decapping. Those belong in the TEE or hardware wallet domain.

### Additional hardening

- **`secureZero(buf)`**: deterministic `Buffer.fill(0)` — not `buf = null` (which leaves the old buffer on the heap), not `delete buf` (which doesn't exist). The function also adds a `memset_s`-style compiler barrier via `buf.length` access to prevent the optimizer from eliding the zero.
- **`disableCoreDumps()`**: calls `prctl(PR_SET_DUMPABLE, 0)` on Linux (POSIX) to prevent core dumps from the process. Falls back silently on unsupported platforms.
- **`PQCWallet.destroy()`**: lifecycle method that zeroes the private key, public key, and all derived material. Call this when the wallet is no longer needed.

---

## 4. Process Isolation: The Signer Subprocess

Memory safety protects against passive attacks (core dumps, swap scanning). But what about active attacks? If the parent process is compromised — through a dependency vulnerability, a prompt injection that executes arbitrary code, or a malicious plugin — the attacker can read any memory in the process.

The standard defense is process isolation: put the private key in a separate process, and communicate only through a narrow, well-defined interface.

### Architecture

```
┌──────────────────────┐     JSON-line IPC (stdin/stdout)      ┌──────────────────────────┐
│   Parent Process     │ ──────────────────────────────────────→ │   Signer Child Process   │
│   (Agent / App)      │     { "type": "sign",                   │                          │
│                      │       "hash": "0xdead...",             │   • ShardedSecret        │
│                      │       "requestId": 42 }                │   • No network access    │
│                      │                                         │   • No file system       │
│                      │ ←────────────────────────────────────── │   • Idle timeout         │
│                      │     { "type": "signature",              │   • Privilege downgrade  │
│                      │       "requestId": 42,                  │                          │
│                      │       "sig": "0xbeef..." }             └──────────────────────────┘
└──────────────────────┘
```

### Key design decisions

**1. stdio IPC, not TCP or Unix sockets.**
Why? Because stdio is the simplest possible communication channel — no port to bind, no socket file to manage permissions for, no network stack involved. The child process never opens a listening socket. This eliminates an entire class of attack surface (port scanning, socket hijacking, man-in-the-middle on localhost).

**2. Fixed-size message limit (1 MiB).**
The parent's data handler enforces a maximum message size. This prevents a compromised parent from flooding the child with oversized payloads — a common technique for triggering buffer-overflow-style vulnerabilities.

**3. Password via stdin, not argv or env.**
The envelope password is written to the child's stdin as part of the `init` message. It never appears in `/proc/pid/cmdline` (visible to all users on the system) or `/proc/pid/environ` (leaked by many monitoring tools).

**4. Idle timeout (default 5 minutes).**
If the child receives no requests for 5 minutes, it exits gracefully. This limits the window during which the key material is resident in the child's memory. Each new signing request resets the timer.

**5. Privilege downgrade (POSIX).**
When `NGX_SIGNER_DOWNGRADE=1` is set and the process is launched as root, the child immediately drops privileges to `nobody` before processing any key material. If the downgrade fails, the child refuses to continue (fail-closed).

**6. Reference seccomp profile.**
We provide a reference seccomp profile at `deploy/seccomp/signer-seccomp.json` with `defaultAction: SCMP_ACT_ERRNO` — meaning any syscall not in the whitelist is denied. The whitelist includes only the syscalls needed for stdio IPC, memory management, and signal handling. This is deploy-time, not enforced in the code itself (seccomp is Linux-specific), but it's a recommended hardening step for containerized deployments.

### The amount-hash gap

There's a deliberate limitation in this design: the Signer process **does not verify** that the amount it's told to enforce matches the hash being signed. Here's why:

In the IPC protocol, the parent sends `{ type: "sign", hash, amount }`. The child checks the amount against the spend policy, but it has no way to verify that `amount` is the actual amount of the transaction being signed. The hash commits to the transaction data, but the amount is a separate field that the parent provides.

**The same limitation applies to contract addresses, method selectors, and chain IDs**: the signer cannot independently verify these properties from the transaction hash alone. These dimensions are enforced at the session key layer before the request reaches the signer. A compromised parent would need to bypass both the session key validation and the signer's amount check.

This is a **known limitation** — we document it in the source code. The mitigations are:

1. **Session key layer validation**: the session key enforces amount limits, contract whitelists, and method restrictions *before* the signing request reaches the Signer. A compromised parent would need to bypass both the session key check AND the Signer check.
2. **Large amounts require human approval**: in the tiered policy system, amounts above the threshold trigger a "requires human approval" response, bypassing the automated signing path entirely.
3. **Future ZK**: a zero-knowledge proof that the full transaction (amount, contract, method, chain) matches the hash could close this gap entirely. This is a research direction, not yet implemented.

### Usage

```javascript
import { spawnSigner } from 'nexusgenesis-agent-keys';

// Spawn a signer subprocess
const signer = await spawnSigner({
  envelope,           // encrypted private key (AES-256-GCM)
  password,          // decryption password (sent via stdin)
  policy: {          // spend policy enforced in the child
    type: 'limit',
    maxPerTx: '100',
    maxDaily: '1000',
  },
});

// Sign a hash (amount is checked against policy in the child)
const sig = await signer.sign({
  hash: '0x' + 'ab'.repeat(32),
  amount: '50',      // child checks: 50 <= 100 → allowed
});

// Amount exceeding policy → rejects with reason
const rejected = await signer.sign({
  hash: '0x' + 'ab'.repeat(32),
  amount: '500',     // child checks: 500 > 100 → denied
});
// rejected → { error: 'exceeds maxPerTx 100' }

// No amount provided → fail-closed (requires human approval)
const closed = await signer.sign({
  hash: '0x' + 'ab'.repeat(32),
  // amount omitted → fail-closed rejected
});
// closed → { error: 'requires human approval' }

// Clean shutdown
signer.close();
```

---

## 5. Session Keys: Five-Dimensional Permissions

Process isolation protects the key from a compromised parent. But what if the agent itself is compromised through a prompt injection — not executing arbitrary code, but being tricked into signing malicious transactions?

The standard defense is **spend limits** — a maximum per-transaction amount. But in practice, a single limit is too coarse. A compromised agent could issue many small transactions (each under the limit) to drain the wallet, or it could interact with a malicious contract that's technically "allowed" but shouldn't be.

### Five dimensions of control

We model permissions as a five-dimensional space:

```javascript
const session = createSessionKey(masterKey, {
  agentId: 'my-agent',
  allowedContracts: ['0xA1b2...', '0xC3d4...'],  // contract whitelist
  allowedMethods: ['swap', 'transfer'],            // method whitelist
  allowedChains: ['ethereum', 'polygon'],          // chain whitelist
  maxPerTx: '100',                                 // per-transaction ceiling
  maxDaily: '1000',                                // daily cumulative ceiling
  ttl: 24 * 60 * 60 * 1000,                       // time-to-live (24h)
});
```

Each dimension narrows the attack surface. A leaked session key that's limited to `['swap']` on `['ethereum']` with `maxPerTx: '10'` can't drain the wallet — it can only swap small amounts on a single chain.

### Monotonic narrowing: privileges only go down

Once a session key is issued, any **derived** session must be a strict subset of the parent's privileges. This is enforced by `narrowSession()`:

```javascript
const parent = createSessionKey(masterKey, {
  agentId: 'agent-narrow',
  allowedContracts: ['0xA', '0xB'],
  allowedMethods: ['transfer', 'approve'],
  maxPerTx: '100',
  ttl: 86400000,
});

// This succeeds: all dimensions are subsets
const child = narrowSession(parent, {
  agentId: 'agent-narrow',          // must match
  allowedContracts: ['0xA'],        // subset of ['0xA', '0xB']
  allowedMethods: ['transfer'],     // subset of ['transfer', 'approve']
  maxPerTx: '50',                   // <= 100
  ttl: 3600000,                     // <= 86400000 (clamped to parent expiry)
}, masterKey);

// This throws: widening any dimension is rejected
narrowSession(parent, {
  agentId: 'agent-narrow',
  allowedContracts: ['0xC'],        // NOT a subset of parent
  maxPerTx: '50',
  ttl: 3600000,
}, masterKey);
// → Error: allowedContracts widening rejected

// This also throws: explicit '0' (unlimited) under a limited parent
narrowSession(parent, {
  agentId: 'agent-narrow',
  allowedContracts: ['0xA'],
  maxPerTx: '0',                    // '0' = unlimited, under limited parent = widening
  ttl: 3600000,
}, masterKey);
// → Error: maxPerTx widening rejected
```

The rule is: **omitted dimensions inherit the parent's value** (no change, not a widening), **explicit empty arrays or `'0'` mean "unrestricted"** — which under a limited parent is an escalation and is rejected.

This is useful for delegation patterns. A parent session can issue a child session to a sub-agent with narrower privileges, and be certain that the child can never escalate its own permissions.

### Access control at runtime

```javascript
const check = checkSessionAccess(session, {
  contract: '0xA1b2...',
  method: 'swap',
  chain: 'ethereum',
  amount: '30',
});

if (check.allowed) {
  // proceed with signing
} else {
  console.log(`Blocked: ${check.reason}`);
  // → "Blocked: exceeds maxPerTx 100" (if amount > 100)
  // → "Blocked: Contract not whitelisted" (if contract not in list)
  // → "Blocked: Session expired" (if TTL passed)
}
```

### Signature verification

The session key is signed by the master key. The `verifySessionSignature()` function checks that the session's scope hasn't been tampered with:

```javascript
const isValid = await verifySessionSignature(session, publicKey);
if (!isValid) {
  throw new Error('Session key has been tampered with');
}
```

Any tampering with the session's fields (amount limits, contract lists, expiry) invalidates the signature. This means a compromised agent can't modify its own session key to bypass restrictions — it would need the master key to re-sign.

---

## 6. Spend Policies: Three Tiers of Authorization

The session key system controls *what* an agent can do. The spend policy system controls *how much* an agent can spend autonomously. Together, they form a two-layer defense.

### Three-tier authorization

Rather than a single "allow/deny" switch, we use a gradient:

| Tier | Amount Threshold | Behavior | Delay |
|------|-----------------|----------|-------|
| **Small (auto)** | < 10 NGEN | Automatic signing | 0 |
| **Medium (timelock)** | 10-100 NGEN | 24h reversible delay | 24h |
| **Large (require-approval)** | ≥ 100 NGEN | Requires human master key signature | Indefinite |

```javascript
import { resolveTier, checkSpendAllowedTiered } from 'nexusgenesis-agent-keys';

// Check which tier a transaction falls into
resolveTier('5');    // → { tier: 'small-auto', threshold: 10 }
resolveTier('50');   // → { tier: 'medium-timelock', threshold: 100 }
resolveTier('500');  // → { tier: 'large-require-approval', threshold: Infinity }

// Check against a policy configuration
const result = checkSpendAllowedTiered(
  { type: 'tiered', smallThreshold: '10', mediumThreshold: '100' },
  { amount: '50' }
);
// → { allowed: false, reason: 'requires timelock', timelockMs: 86400000 }
```

The medium tier is deliberately designed to be **reversible**. A pending transaction at this level publishes a `Timelocked until <timestamp>` response. The human operator has 24 hours to review and revoke the transaction before it auto-executes. This is not a rate limit — it's a **circuit breaker with a delay**.

### Policy time lock: 48-hour change delay

The most dangerous attack vector for an autonomous agent is not a single large transaction. It's the attacker modifying the agent's spend policy to remove all limits, then draining the wallet.

To prevent this, any policy change goes through a mandatory 48-hour time lock:

```javascript
import { PolicyTimelock } from 'nexusgenesis-agent-keys';

const timelock = new PolicyTimelock(48 * 60 * 60 * 1000); // 48 hours

// Schedule a policy change
const { changeId, effectiveAt } = timelock.scheduleChange('agent-1', {
  type: 'unlimited',  // attacker wants to remove limits
});
// effectiveAt = now + 48h

// During the 48-hour window, a human can revoke
timelock.revokeChange(changeId);
// → { revoked: true }
```

The time lock is accompanied by an alerting system:

```javascript
const timelock = new PolicyTimelock(48 * 60 * 60 * 1000, {
  webhookUrl: process.env.POLICY_WEBHOOK_URL || 'https://alerting.example.com',
});

// Or register a custom notifier
timelock.addNotifier((event) => {
  console.log(`[ALERT] Policy change ${event.event}:`, event.agentId, event.newPolicy);
});
```

For on-chain deployments, policy changes can also be emitted as immutable on-chain events, creating a permanent, tamper-proof audit trail with zero additional infrastructure cost.

The notifier receives four event types:

| Event | Triggered When |
|-------|---------------|
| `policy_change_scheduled` | A new policy change is registered |
| `policy_change_revoked` | A pending change is cancelled |
| `policy_change_effective` | A timelock expires and the change takes effect |
| `policy_changes_cleared` | All pending changes are cleared (emergency reset) |

This completes the **detect → delay → respond** loop. The time lock gives you a window; the alert tells you to look; the revoke function lets you act.

---

## 7. Complete Example: From Key Generation to Signed Transaction

Here's a complete, end-to-end example that ties everything together:

```javascript
import {
  generateKeyPair,
  createSessionKey,
  checkSessionAccess,
  verifySessionSignature,
  spawnSigner,
  resolveTier,
  checkSpendAllowedTiered,
} from 'nexusgenesis-agent-keys';

// 1. Generate a Dilithium2 key pair
const { publicKey, privateKey } = await generateKeyPair();
console.log('PQC Key pair generated');
console.log(`  Public key: ${publicKey.toString('hex').slice(0, 32)}...`);
console.log(`  Private key: ${privateKey.length} bytes`);

// 2. Create a session key for the agent
const session = createSessionKey(privateKey, {
  agentId: 'demo-agent',
  allowedContracts: ['0xTokenSwap', '0xStakingPool'],
  allowedMethods: ['swap', 'stake', 'unstake'],
  allowedChains: ['ethereum'],
  maxPerTx: '50',
  maxDaily: '200',
  ttl: 24 * 60 * 60 * 1000, // 24 hours
});
console.log('Session key created (expires in 24h)');

// 3. Verify the session signature (detect tampering)
const valid = await verifySessionSignature(session, publicKey);
console.log(`Session signature valid: ${valid}`);

// 4. Derive a narrower session for a sub-task
const subTask = narrowSession(session, {
  agentId: 'demo-agent',          // must match parent
  allowedContracts: ['0xTokenSwap'],
  allowedMethods: ['swap'],
  maxPerTx: '10',                 // narrower limit
  ttl: 60 * 60 * 1000,           // 1 hour, clamped to parent
}, privateKey);
console.log('Narrowed session derived (1h, 10 NGEN max, swap only)');

// 5. Check if a proposed transaction is allowed
const context = {
  contract: '0xTokenSwap',
  method: 'swap',
  chain: 'ethereum',
  amount: '15',
};

const access = checkSessionAccess(subTask, context);
console.log(`Access check: ${access.allowed ? '✅' : '❌'} ${access.reason || ''}`);

// 6. Check the spend tier
const tier = resolveTier(context.amount);
console.log(`Spend tier for ${context.amount} NGEN: ${tier.tier}`);

// 7. Spawn a signer subprocess and sign
const signer = await spawnSigner({
  envelope: encryptedEnvelope,     // pre-encrypted key material
  password: process.env.KEY_PASSWORD,
  policy: {
    type: 'tiered',
    smallThreshold: '10',
    mediumThreshold: '100',
  },
});

const sig = await signer.sign({
  hash: '0x' + 'ab'.repeat(32),
  amount: context.amount,
});
console.log(`Signature: ${sig.sig ? sig.sig.slice(0, 32) + '...' : 'DENIED'}`);
if (sig.timelockMs) {
  console.log(`  Timelocked until: ${new Date(Date.now() + sig.timelockMs).toISOString()}`);
}

signer.close();
```

---

## 8. Comparison with Existing Approaches

| Dimension | NexusGenesis | LangChain + Wallet | Lit Protocol | Web3Auth |
|-----------|-------------|-------------------|-------------|----------|
| **Key Ownership** | Self-custody (user holds key) | Custodial (provider holds key) | MPC shards | Custodial |
| **Cryptography** | Dilithium2 (PQC, FIPS 204) | ECDSA (pre-quantum) | ECDSA (pre-quantum) | ECDSA (pre-quantum) |
| **Memory Safety** | ShardedSecret (XOR sharding, heap snapshot verified) | None | None | None |
| **Process Isolation** | Signer subprocess (stdio IPC, seccomp profile) | None | MPC nodes (network) | None |
| **Permission Granularity** | 5 dimensions (contracts, methods, chains, per-tx, daily) | Per-tx limit only | Contract-level | User-level |
| **Policy Time Lock** | 48h delay + webhook alert | None | None | None |
| **Human Takeover** | 3-tier gradient + monotonic narrowing | None | Requires MPC reconfiguration | Requires provider approval |
| **License** | MIT (full open source) | MIT | Partial source available | Proprietary |
| **Audit Status** | Composition layer pending audit | Audited | Audited | Audited |

The trade-offs are clear:

- **NexusGenesis** is the only self-custody option with PQC, memory safety, process isolation, and granular permissions. The cost is that the composition layer has not yet been independently audited — this is a priority for the next phase.
- **LangChain + Wallet** is the simplest option but gives you custodial key management, pre-quantum crypto, and no memory safety.
- **Lit Protocol** provides MPC-based key management but still relies on a network of nodes, and the crypto is ECDSA.
- **Web3Auth** is the simplest to integrate but is fully custodial — your users don't hold their keys.

---

## 9. What's Next

This is not a finished product — it's a foundation. Here's what's on the roadmap:

**Immediate** (weeks):
- Independent security audit (Code4rena competitive audit, budget proposed via on-chain governance)
- First technical deep-dive article (you're reading it)
- npm provenance (sigstore) for supply-chain transparency
- Agent Runtime SDK (Node.js daemon template for unattended agents)

**Short-term** (1-2 months):
- Hardware wallet integration (cold master key → hot session key architecture)
- Multi-instance high-availability for the signer process
- Session key revocation list (jti-based)

**Medium-term** (3-6 months):
- Zero-knowledge proofs for the amount-hash gap
- TEE integration (Intel SGX / AMD SEV) for hardware-backed signing
- Cross-chain support (the session key model is chain-agnostic)

### Try it today

```bash
# Install the library
npm install nexusgenesis-agent-keys

# CLI for quick experiments
npx nexusgenesis-agent-keys-cli tier 50
# → { "tier": "medium-timelock", "threshold": 100 }

# Generate a key pair
npx nexusgenesis-agent-keys-cli generate-key
# → { "publicKey": "0x...", "envelope": { ... } }

# Claude Desktop / Cursor integration
npm install nexusgenesis-agent-keys-mcp
```

### The conversation we need to have

This article is intentionally provocative. The thesis is:

> **If your agent's private key is on a server you don't control, or in a memory region you can't protect, you don't own your agent. You're renting it.**

We believe the future of autonomous agents requires self-custody key management — not because centralized options are always bad, but because the very premise of an "autonomous agent" is that it acts on your behalf, and you can't have an agent that acts on your behalf if you've given up control of its identity.

The open questions are:

1. **Signature size**: Dilithium2's 2.4KB signatures are expensive on-chain. Can we optimize through transaction batching or compressed verification?
2. **Pure JS vs WASM**: We chose pure JS for auditability (no build step, no WASM binary, no native bindings). Does the performance cost (6.3ms vs 0.06ms for signing) justify the transparency benefit?
3. **Process isolation in serverless**: The signer subprocess model works on bare metal, VMs, and containers. Does it make sense in serverless/edge environments where forking is restricted?

These are the discussions we need to have as a community. The code is open source. The npm package is live. The test suite is 121 tests and counting. Come build with us.

---

*NexusGenesis is an open-source agent coordination protocol. The agent-keys package is the security-only core, decoupled from any chain. Repository: [github.com/nexus-genesis/nexusgenesis](https://github.com/nexus-genesis/nexusgenesis). For security vulnerabilities, please follow the responsible disclosure process outlined in the repository's `SECURITY.md`.*