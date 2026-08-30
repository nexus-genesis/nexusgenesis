// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AuditAnchor security test suite — Sprint 8 GAP-002 Ⅲ
 * @notice On-chain append-only anchoring for the audit hash-chain:
 *         - deployer is the only anchoring key (NotAnchoringKey otherwise)
 *         - anchors append-only: count monotonic, no overwrite path
 *         - getAnchor/latest read back exactly what was anchored
 *         - Anchored event carries (index, tailHash, entryCount, anchoredAt)
 */
import { Test } from "forge-std/Test.sol";
import { AuditAnchor } from "../src/AuditAnchor.sol";

contract AuditAnchorTest is Test {
    address internal constant ATTACKER = address(0xBEEF);

    AuditAnchor internal anchorLedger;

    bytes32 internal constant TAIL_A =
        0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 internal constant TAIL_B =
        0x2222222222222222222222222222222222222222222222222222222222222222;

    function setUp() public {
        anchorLedger = new AuditAnchor(); // this test contract = anchoringKey
    }

    // ── access control ───────────────────────────────────────────────────

    function test_DeployerIsAnchoringKey() public view {
        assertEq(anchorLedger.anchoringKey(), address(this));
        assertEq(anchorLedger.count(), 0);
    }

    function test_NonAnchoringKeyReverts() public {
        vm.prank(ATTACKER);
        vm.expectRevert(AuditAnchor.NotAnchoringKey.selector);
        anchorLedger.anchor(TAIL_A, 10);
    }

    // ── append-only semantics ────────────────────────────────────────────

    function test_AnchorAppendsAndCountIsMonotonic() public {
        uint256 idx0 = anchorLedger.anchor(TAIL_A, 42);
        assertEq(idx0, 0, "first anchor gets index 0");
        assertEq(anchorLedger.count(), 1);

        uint256 idx1 = anchorLedger.anchor(TAIL_B, 99);
        assertEq(idx1, 1, "second anchor gets index 1");
        assertEq(anchorLedger.count(), 2);

        // entryCount may only grow on an honest chain: re-anchoring an
        // equal or LOWER entryCount is the rewrite alarm the JS verifier
        // treats as tampering (not enforced here — the ledger is a dumb
        // append-only fact store; interpretation lives off-chain).
        uint256 idx2 = anchorLedger.anchor(TAIL_A, 5);
        assertEq(idx2, 2);
        assertEq(anchorLedger.count(), 3);
    }

    function test_GetAnchorReadsBackExactly() public {
        anchorLedger.anchor(TAIL_A, 42);
        (bytes32 h, uint256 n, uint64 at) = anchorLedger.getAnchor(0);
        assertEq(h, TAIL_A);
        assertEq(n, 42);
        assertEq(at, uint64(block.timestamp));
    }

    function test_GetAnchorOutOfRangeIsZeroAnchor() public view {
        (bytes32 h, uint256 n, uint64 at) = anchorLedger.getAnchor(0);
        assertEq(bytes32(h), bytes32(0));
        assertEq(n, 0);
        assertEq(at, 0);
    }

    function test_LatestTracksLastAnchor() public {
        // empty ledger → zero anchor
        (bytes32 h0, uint256 n0,) = anchorLedger.latest();
        assertEq(bytes32(h0), bytes32(0));
        assertEq(n0, 0);

        anchorLedger.anchor(TAIL_A, 42);
        anchorLedger.anchor(TAIL_B, 99);
        (bytes32 h, uint256 n,) = anchorLedger.latest();
        assertEq(h, TAIL_B);
        assertEq(n, 99);
    }

    // ── events ───────────────────────────────────────────────────────────

    function test_AnchoredEventCarriesAllFields() public {
        vm.warp(1_700_000_000);
        vm.expectEmit(true, true, true, true);
        emit AuditAnchor.Anchored(0, TAIL_A, 42, uint64(1_700_000_000));
        anchorLedger.anchor(TAIL_A, 42);
    }
}
