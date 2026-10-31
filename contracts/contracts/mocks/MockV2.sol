// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Local-only, minimal Uniswap-V2-shaped pair: just enough for mint/sync/getReserves.
contract MockV2Pair {
    address public token0;
    address public token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    uint256 private constant MINIMUM_LIQUIDITY = 1000;

    function initialize(address t0, address t1) external {
        require(token0 == address(0), "init");
        token0 = t0;
        token1 = t1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }

    function mint(address to) external returns (uint256 liquidity) {
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        uint256 a0 = b0 - reserve0;
        uint256 a1 = b1 - reserve1;
        if (totalSupply == 0) {
            liquidity = Math.sqrt(a0 * a1) - MINIMUM_LIQUIDITY;
            totalSupply = MINIMUM_LIQUIDITY;
            balanceOf[address(0)] = MINIMUM_LIQUIDITY;
        } else {
            liquidity = Math.min((a0 * totalSupply) / reserve0, (a1 * totalSupply) / reserve1);
        }
        require(liquidity > 0, "liq");
        totalSupply += liquidity;
        balanceOf[to] += liquidity;
        reserve0 = uint112(b0);
        reserve1 = uint112(b1);
    }

    function sync() external {
        reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20(token1).balanceOf(address(this)));
    }
}

/// @dev Local-only factory that deploys MockV2Pair with CREATE2, like Uniswap V2.
contract MockV2Factory {
    mapping(address => mapping(address => address)) public getPair;
    bytes32 public constant INIT_CODE_HASH = keccak256(type(MockV2Pair).creationCode);

    function createPair(address a, address b) external returns (address pair) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        require(getPair[t0][t1] == address(0), "exists");
        pair = address(new MockV2Pair{salt: keccak256(abi.encodePacked(t0, t1))}());
        MockV2Pair(pair).initialize(t0, t1);
        getPair[t0][t1] = pair;
        getPair[t1][t0] = pair;
    }
}
