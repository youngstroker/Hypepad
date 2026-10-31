// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {HyperPumpToken} from "./HyperPumpToken.sol";
import {IWHYPE, IUniswapV2Factory, IUniswapV2Pair} from "./interfaces/IDex.sol";

/// @title HyperPumpFactory
/// @notice Launches fixed-supply tokens on HyperEVM and trades each one on a
/// constant-product bonding curve priced in HYPE. When a curve sells out it is
/// marked complete, and anyone may call `migrate` to move the raised HYPE plus
/// the reserved token supply into a Uniswap-V2-style pair. The LP tokens are
/// sent to a dead address, so that liquidity is locked for good.
///
/// The owner can tune fees (hard-capped), curve parameters for FUTURE launches,
/// who may launch, and whether launches are paused. The owner has no function
/// that moves curve reserves, pauses trading, or touches anyone's tokens.
contract HyperPumpFactory is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Params {
        uint256 virtualHype;   // initial virtual HYPE reserve (wei)
        uint256 virtualToken;  // initial virtual token reserve (wei)
        uint256 curveSupply;   // tokens sold through the curve (wei)
        uint256 totalSupply;   // total minted; the rest seeds DEX liquidity
    }

    struct Curve {
        uint256 virtualHype;
        uint256 virtualToken;
        uint256 realHype;
        uint256 realToken;
        uint256 liquidityTokens;
        address creator;
        bool complete;
        bool migrated;
    }

    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_TRADE_FEE_BPS = 200;     // 2% combined
    uint256 public constant MAX_MIGRATION_FEE_BPS = 500; // 5% of raised HYPE
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable tokenImplementation;
    address public immutable whype;
    IUniswapV2Factory public immutable v2Factory;
    bytes32 public immutable pairInitCodeHash;

    Params public params;
    address public feeRecipient;
    uint16 public protocolFeeBps;
    uint16 public creatorFeeBps;
    uint16 public migrationFeeBps;
    bool public openLaunches;
    bool public launchesPaused;

    mapping(address => bool) public launchers;
    mapping(address => Curve) public curves;
    mapping(address => uint256) public accruedFees;
    address[] public allTokens;

    event TokenCreated(
        address indexed token,
        address indexed creator,
        address indexed launcher,
        string name,
        string symbol,
        string uri,
        address pair,
        uint256 virtualHype,
        uint256 virtualToken,
        uint256 curveSupply,
        uint256 totalSupply
    );
    event Trade(
        address indexed token,
        address indexed trader,
        address indexed recipient,
        bool isBuy,
        uint256 hypeAmount,
        uint256 tokenAmount,
        uint256 fee,
        uint256 virtualHype,
        uint256 virtualToken,
        uint256 realHype,
        uint256 realToken
    );
    event CurveCompleted(address indexed token);
    event Migrated(address indexed token, address indexed pair, uint256 hypeAmount, uint256 tokenAmount, uint256 liquidity, uint256 fee);
    event FeesClaimed(address indexed account, uint256 amount);
    event ParamsUpdated(Params params);
    event FeesUpdated(address feeRecipient, uint16 protocolFeeBps, uint16 creatorFeeBps, uint16 migrationFeeBps);
    event LauncherUpdated(address indexed launcher, bool allowed);
    event LaunchSettingsUpdated(bool openLaunches, bool launchesPaused);

    error NotLauncher();
    error LaunchesPaused();
    error InvalidMetadata();
    error InvalidAddress();
    error InvalidParams();
    error FeeTooHigh();
    error UnknownToken();
    error CurveIsComplete();
    error CurveNotComplete();
    error AlreadyMigrated();
    error ZeroAmount();
    error Slippage();
    error PairMismatch();
    error TransferFailed();

    constructor(
        address owner_,
        address whype_,
        address v2Factory_,
        bytes32 pairInitCodeHash_,
        Params memory params_,
        address feeRecipient_,
        uint16 protocolFeeBps_,
        uint16 creatorFeeBps_,
        uint16 migrationFeeBps_
    ) Ownable(owner_) {
        if (whype_ == address(0) || v2Factory_ == address(0)) revert InvalidAddress();
        tokenImplementation = address(new HyperPumpToken());
        whype = whype_;
        v2Factory = IUniswapV2Factory(v2Factory_);
        pairInitCodeHash = pairInitCodeHash_;
        _setParams(params_);
        _setFees(feeRecipient_, protocolFeeBps_, creatorFeeBps_, migrationFeeBps_);
    }

    // ------------------------------------------------------------------ launch

    /// @notice Deploys a token and its curve. Any HYPE sent is spent as the
    /// first buy in the same transaction, so nobody can trade ahead of it.
    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata uri,
        address creator,
        address buyRecipient,
        uint256 minTokensOut
    ) external payable nonReentrant returns (address token) {
        if (launchesPaused) revert LaunchesPaused();
        if (!openLaunches && !launchers[msg.sender]) revert NotLauncher();
        if (creator == address(0)) revert InvalidAddress();
        uint256 nameLen = bytes(name).length;
        uint256 symbolLen = bytes(symbol).length;
        if (nameLen == 0 || nameLen > 32 || symbolLen == 0 || symbolLen > 10 || bytes(uri).length > 256) revert InvalidMetadata();

        Params memory p = params;
        token = Clones.clone(tokenImplementation);
        address pair = pairFor(token);
        HyperPumpToken(token).initialize(name, symbol, p.totalSupply, pair);

        curves[token] = Curve({
            virtualHype: p.virtualHype,
            virtualToken: p.virtualToken,
            realHype: 0,
            realToken: p.curveSupply,
            liquidityTokens: p.totalSupply - p.curveSupply,
            creator: creator,
            complete: false,
            migrated: false
        });
        allTokens.push(token);

        emit TokenCreated(token, creator, msg.sender, name, symbol, uri, pair, p.virtualHype, p.virtualToken, p.curveSupply, p.totalSupply);

        if (msg.value > 0) {
            address to = buyRecipient == address(0) ? creator : buyRecipient;
            if (to == pair) revert InvalidAddress();
            _buy(token, msg.value, minTokensOut, to);
        }
    }

    // ------------------------------------------------------------------ trading

    function buy(address token, uint256 minTokensOut, address recipient) external payable nonReentrant returns (uint256 tokensOut) {
        if (recipient == address(0) || recipient == HyperPumpToken(token).pair()) revert InvalidAddress();
        tokensOut = _buy(token, msg.value, minTokensOut, recipient);
    }

    function sell(address token, uint256 tokenAmount, uint256 minHypeOut, address recipient) external nonReentrant returns (uint256 hypeOut) {
        if (recipient == address(0)) revert InvalidAddress();
        if (tokenAmount == 0) revert ZeroAmount();
        Curve storage c = _activeCurve(token);

        (uint256 gross, uint256 fee, uint256 newVirtualHype) = _sellMath(c, tokenAmount);
        hypeOut = gross - fee;
        if (hypeOut < minHypeOut || hypeOut == 0) revert Slippage();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);

        c.virtualHype = newVirtualHype;
        c.virtualToken += tokenAmount;
        c.realHype -= gross;
        c.realToken += tokenAmount;
        _accrueTradeFee(c.creator, fee);

        _sendHype(recipient, hypeOut);
        emit Trade(token, msg.sender, recipient, false, hypeOut, tokenAmount, fee, c.virtualHype, c.virtualToken, c.realHype, c.realToken);
    }

    /// @notice Moves a completed curve's liquidity into the DEX pair. Anyone
    /// may call this so liquidity can never be held back.
    function migrate(address token) external nonReentrant {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (!c.complete) revert CurveNotComplete();
        if (c.migrated) revert AlreadyMigrated();
        c.migrated = true;

        address pair = HyperPumpToken(token).pair();
        address existing = v2Factory.getPair(token, whype);
        if (existing == address(0)) existing = v2Factory.createPair(token, whype);
        if (existing != pair) revert PairMismatch();

        uint256 raised = c.realHype;
        uint256 fee = (raised * migrationFeeBps) / BPS;
        uint256 hypeAmount = raised - fee;
        uint256 tokenAmount = c.liquidityTokens + c.realToken;
        c.realHype = 0;
        c.realToken = 0;
        c.liquidityTokens = 0;
        if (fee > 0) accruedFees[feeRecipient] += fee;

        HyperPumpToken(token).markGraduated();
        IWHYPE(whype).deposit{value: hypeAmount}();
        IERC20(whype).safeTransfer(pair, hypeAmount);
        IERC20(token).safeTransfer(pair, tokenAmount);
        uint256 liquidity = IUniswapV2Pair(pair).mint(DEAD);

        emit Migrated(token, pair, hypeAmount, tokenAmount, liquidity, fee);
    }

    function claimFees() external nonReentrant {
        uint256 amount = accruedFees[msg.sender];
        if (amount == 0) revert ZeroAmount();
        accruedFees[msg.sender] = 0;
        _sendHype(msg.sender, amount);
        emit FeesClaimed(msg.sender, amount);
    }

    // ------------------------------------------------------------------ views

    function quoteBuy(address token, uint256 hypeAmount) external view returns (uint256 tokensOut, uint256 fee, uint256 refund) {
        Curve storage c = _activeCurve(token);
        (tokensOut, , fee, refund, ) = _buyMath(c, hypeAmount);
    }

    function quoteSell(address token, uint256 tokenAmount) external view returns (uint256 hypeOut, uint256 fee) {
        Curve storage c = _activeCurve(token);
        uint256 gross;
        (gross, fee, ) = _sellMath(c, tokenAmount);
        hypeOut = gross - fee;
    }

    /// @notice Initial-buy quote for a token that does not exist yet.
    function quoteLaunchBuy(uint256 hypeAmount) external view returns (uint256 tokensOut) {
        Params memory p = params;
        Curve memory c = Curve(p.virtualHype, p.virtualToken, 0, p.curveSupply, 0, address(1), false, false);
        (tokensOut, , , , ) = _buyMathMem(c, hypeAmount, tradeFeeBps());
    }

    function tradeFeeBps() public view returns (uint256) {
        return uint256(protocolFeeBps) + uint256(creatorFeeBps);
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice The CREATE2 address the DEX factory will give this token's pair.
    function pairFor(address token) public view returns (address) {
        (address t0, address t1) = token < whype ? (token, whype) : (whype, token);
        return address(uint160(uint256(keccak256(abi.encodePacked(
            hex"ff", address(v2Factory), keccak256(abi.encodePacked(t0, t1)), pairInitCodeHash
        )))));
    }

    // ------------------------------------------------------------------ admin

    function setParams(Params calldata p) external onlyOwner {
        _setParams(p);
    }

    function setFees(address feeRecipient_, uint16 protocolFeeBps_, uint16 creatorFeeBps_, uint16 migrationFeeBps_) external onlyOwner {
        _setFees(feeRecipient_, protocolFeeBps_, creatorFeeBps_, migrationFeeBps_);
    }

    function setLauncher(address launcher, bool allowed) external onlyOwner {
        launchers[launcher] = allowed;
        emit LauncherUpdated(launcher, allowed);
    }

    function setLaunchSettings(bool openLaunches_, bool launchesPaused_) external onlyOwner {
        openLaunches = openLaunches_;
        launchesPaused = launchesPaused_;
        emit LaunchSettingsUpdated(openLaunches_, launchesPaused_);
    }

    // ------------------------------------------------------------------ internals

    function _buy(address token, uint256 gross, uint256 minTokensOut, address recipient) internal returns (uint256 tokensOut) {
        if (gross == 0) revert ZeroAmount();
        Curve storage c = _activeCurve(token);

        (uint256 out, uint256 hypeIn, uint256 fee, uint256 refund, bool completes) = _buyMath(c, gross);
        if (out == 0 || out < minTokensOut) revert Slippage();

        c.virtualHype += hypeIn;
        c.virtualToken -= out;
        c.realHype += hypeIn;
        c.realToken -= out;
        if (completes) c.complete = true;
        _accrueTradeFee(c.creator, fee);

        IERC20(token).safeTransfer(recipient, out);
        if (refund > 0) _sendHype(msg.sender, refund);

        emit Trade(token, msg.sender, recipient, true, hypeIn + fee, out, fee, c.virtualHype, c.virtualToken, c.realHype, c.realToken);
        if (completes) emit CurveCompleted(token);
        return out;
    }

    function _buyMath(Curve storage c, uint256 gross)
        internal
        view
        returns (uint256 out, uint256 hypeIn, uint256 fee, uint256 refund, bool completes)
    {
        return _buyMathMem(c, gross, tradeFeeBps());
    }

    function _buyMathMem(Curve memory c, uint256 gross, uint256 feeBps)
        internal
        pure
        returns (uint256 out, uint256 hypeIn, uint256 fee, uint256 refund, bool completes)
    {
        fee = (gross * feeBps) / BPS;
        hypeIn = gross - fee;
        uint256 k = c.virtualHype * c.virtualToken;
        out = c.virtualToken - _ceilDiv(k, c.virtualHype + hypeIn);

        if (out >= c.realToken) {
            // Last buy: take only what is left and refund the rest.
            out = c.realToken;
            hypeIn = _ceilDiv(k, c.virtualToken - out) - c.virtualHype;
            fee = (hypeIn * feeBps) / (BPS - feeBps);
            if (hypeIn + fee > gross) fee = gross - hypeIn;
            refund = gross - hypeIn - fee;
            completes = true;
        }
    }

    function _sellMath(Curve storage c, uint256 tokenAmount) internal view returns (uint256 gross, uint256 fee, uint256 newVirtualHype) {
        uint256 k = c.virtualHype * c.virtualToken;
        newVirtualHype = _ceilDiv(k, c.virtualToken + tokenAmount);
        gross = c.virtualHype - newVirtualHype;
        if (gross > c.realHype) gross = c.realHype; // rounding guard; never pay out more than was paid in
        fee = (gross * tradeFeeBps()) / BPS;
    }

    function _activeCurve(address token) internal view returns (Curve storage c) {
        c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.complete) revert CurveIsComplete();
    }

    function _accrueTradeFee(address creator, uint256 fee) internal {
        if (fee == 0) return;
        uint256 total = tradeFeeBps();
        uint256 creatorPart = (fee * creatorFeeBps) / total;
        if (creatorPart > 0) accruedFees[creator] += creatorPart;
        accruedFees[feeRecipient] += fee - creatorPart;
    }

    function _sendHype(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _setParams(Params memory p) internal {
        if (
            p.virtualHype == 0 || p.curveSupply == 0 || p.totalSupply < p.curveSupply ||
            p.virtualToken <= p.curveSupply || p.totalSupply > 1e36 || p.virtualHype > 1e30 ||
            // keep at least 5% of supply for the DEX pool, or migration has nothing to pair with
            p.totalSupply - p.curveSupply < p.totalSupply / 20
        ) revert InvalidParams();
        params = p;
        emit ParamsUpdated(p);
    }

    function _setFees(address feeRecipient_, uint16 protocolFeeBps_, uint16 creatorFeeBps_, uint16 migrationFeeBps_) internal {
        if (feeRecipient_ == address(0)) revert InvalidAddress();
        if (uint256(protocolFeeBps_) + creatorFeeBps_ > MAX_TRADE_FEE_BPS || migrationFeeBps_ > MAX_MIGRATION_FEE_BPS) revert FeeTooHigh();
        feeRecipient = feeRecipient_;
        protocolFeeBps = protocolFeeBps_;
        creatorFeeBps = creatorFeeBps_;
        migrationFeeBps = migrationFeeBps_;
        emit FeesUpdated(feeRecipient_, protocolFeeBps_, creatorFeeBps_, migrationFeeBps_);
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
