// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AuditAnchor — append-only on-chain anchoring for the audit hash-chain
 * @notice GAP-002 Ⅲ (external anchoring): the mcp-server audit log is a
 *         hash-chain (prevHash/hash per record, see audit-log.js). A local
 *         hash-chain detects in-place edits, but an attacker with file write
 *         access can truncate the tail or rewrite the whole chain. Anchoring
 *         the chain TAIL hash on-chain makes the entire committed prefix
 *         tamper-evident: every later hash transitively commits to every
 *         earlier record, so any rewrite breaks every anchored hash that
 *         covers the changed region.
 *
 * APPEND-ONLY BY CONSTRUCTION:
 *   - No delete, no update, no admin path. `count` is monotonic.
 *   - Only `anchoringKey` (the deployer) may append. An attacker who
 *     compromises the server can re-anchor a rewritten chain, but the
 *     rewrite stays VISIBLE: the on-chain ledger now holds an extra anchor
 *     (index jump) that no honest collector expected — the verifier
 *     (audit-anchor.js verifyAuditAgainstAnchors) treats an unexpected
 *     index/entryCount regression as an alarm, not as success.
 *
 * VERIFICATION MODEL (see mcp-server/src/audit-anchor.js):
 *   Each anchor stores (tailHash, entryCount) where entryCount is the audit
 *   prefix length covered. The verifier replays the local audit file and
 *   requires runningHash[entryCount] == tailHash for every anchor. Position
 *   binding (not just set membership) also detects inserted records.
 */
contract AuditAnchor {
    struct Anchor {
        bytes32 tailHash; // audit hash-chain tail at anchor time
        uint256 entryCount; // total audit records covered (prefix length)
        uint64 anchoredAt; // block timestamp (seconds)
    }

    /// @dev index → anchor (append-only)
    mapping(uint256 => Anchor) private _anchors;

    /// @dev number of anchors; monotonic, append-only
    uint256 public count;

    /// @dev the only address allowed to append (the deployer)
    address public immutable anchoringKey;

    event Anchored(uint256 indexed index, bytes32 tailHash, uint256 entryCount, uint64 anchoredAt);

    error NotAnchoringKey();

    constructor() {
        anchoringKey = msg.sender;
    }

    /**
     * @notice Append one anchor for the current audit chain tail.
     * @param tailHash    32-byte audit chain tail hash (sha256 of the last record)
     * @param entryCount  total audit records committed by this prefix
     * @return index the index assigned to this anchor
     */
    function anchor(bytes32 tailHash, uint256 entryCount) external returns (uint256 index) {
        if (msg.sender != anchoringKey) revert NotAnchoringKey();
        index = count;
        uint64 at = uint64(block.timestamp);
        _anchors[index] = Anchor(tailHash, entryCount, at);
        unchecked {
            count = index + 1;
        }
        emit Anchored(index, tailHash, entryCount, at);
    }

    /**
     * @notice Read one anchor by index.
     * @dev out-of-range indices return the zero anchor (tailHash 0, count 0).
     */
    function getAnchor(uint256 index)
        external
        view
        returns (bytes32 tailHash, uint256 entryCount, uint64 anchoredAt)
    {
        Anchor storage a = _anchors[index];
        return (a.tailHash, a.entryCount, a.anchoredAt);
    }

    /**
     * @notice Latest anchor (the current chain tail commitment).
     * @dev empty ledger → zero anchor.
     */
    function latest()
        external
        view
        returns (bytes32 tailHash, uint256 entryCount, uint64 anchoredAt)
    {
        uint256 c = count;
        if (c == 0) {
            return (bytes32(0), 0, 0);
        }
        Anchor storage a = _anchors[c - 1];
        return (a.tailHash, a.entryCount, a.anchoredAt);
    }
}
