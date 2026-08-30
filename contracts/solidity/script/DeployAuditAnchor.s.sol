// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { AuditAnchor } from "../src/AuditAnchor.sol";

/**
 * @title DeployAuditAnchor — audit hash-chain anchoring deployment (Sprint 8 GAP-002 Ⅲ)
 * @notice Deploys the append-only AuditAnchor ledger. The BROADCASTER becomes
 *         the on-chain anchoringKey — use the server-side operation key
 *         (e.g. the relayer EOA configured as CHAIN_RELAYER_PK in mcp-server)
 *         so the mcp-server anchoring service can append.
 *
 * Usage (see foundry.toml [rpc_endpoints] for named networks):
 *   forge script script/DeployAuditAnchor.s.sol:DeployAuditAnchor \
 *       --rpc-url <rpc_url> --broadcast --private-key <anchoring_key_pk>
 *
 * Then point mcp-server at it:
 *   AUDIT_ANCHOR_CONTRACT=<deployed address>
 *   AUDIT_ANCHOR_INTERVAL_MS=60000
 */
contract DeployAuditAnchor is Script {
    function run() external returns (AuditAnchor deployed) {
        vm.startBroadcast();
        deployed = new AuditAnchor();
        vm.stopBroadcast();

        console2.log("AuditAnchor deployed at:", address(deployed));
        console2.log("  anchoringKey (broadcaster):", deployed.anchoringKey());
        console2.log("Set in mcp-server: AUDIT_ANCHOR_CONTRACT=", address(deployed));
    }
}
