// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// Reads the Stake 2.0 view in both argument orders so the probe can record what resourceV2 returns and in which unit.
/// Resource type 1 is ENERGY. Deployed by hand on Nile only (docs/verification/nile-lock.md); read by `nile-probe read`.
contract ResourceProbe {
    function delegated(address receiver, address from) external view returns (uint256) {
        return receiver.resourceV2(from, 1);
    }
    function reverse(address receiver, address from) external view returns (uint256) {
        return from.resourceV2(receiver, 1);
    }
}
