// Runs launch -> curve -> migration against the REAL HyperEVM-mainnet bytecode
// of WHYPE and the HyperSwap V2 factory (and therefore its real pair code),
// installed at their mainnet addresses on the local chain.
// Refresh the snapshot with: node scripts/snapshot-mainnet-dex.js
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const snap = require("./fixtures/hyperswap-v2.json");

const E = (n) => ethers.parseEther(String(n));
const DEAD = "0x000000000000000000000000000000000000dEaD";
const PARAMS = { virtualHype: E(10), virtualToken: E(1_066_666_667), curveSupply: E(800_000_000), totalSupply: E(1_000_000_000) };
const PAIR_ABI = [
    "function getReserves() view returns (uint112, uint112, uint32)",
    "function token0() view returns (address)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function mint(address) returns (uint256)",
    "function sync()",
    "function swap(uint256, uint256, address, bytes)",
];
const V2_ABI = ["function getPair(address, address) view returns (address)", "function createPair(address, address) returns (address)"];
const WHYPE_ABI = ["function deposit() payable", "function transfer(address, uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];

async function installMainnetDex() {
    for (const [address, code] of Object.entries(snap.code)) await network.provider.send("hardhat_setCode", [address, code]);
    for (const [slot, value] of Object.entries(snap.storage[snap.factory])) {
        await network.provider.send("hardhat_setStorageAt", [snap.factory, ethers.toBeHex(BigInt(slot), 32), value]);
    }
}

async function deploy() {
    await installMainnetDex();
    const [owner, launcher, alice, bob, creator, fees] = await ethers.getSigners();
    const factory = await (await ethers.getContractFactory("HyperPumpFactory")).deploy(
        owner.address, snap.whype, snap.factory, snap.initCodeHash, PARAMS, fees.address, 70, 30, 100,
    );
    await factory.setLauncher(launcher.address, true);
    const v2 = new ethers.Contract(snap.factory, V2_ABI, owner);
    const whype = new ethers.Contract(snap.whype, WHYPE_ABI, owner);
    return { factory, v2, whype, owner, launcher, alice, bob, creator };
}

async function launch(ctx) {
    const rc = await (await ctx.factory.connect(ctx.launcher).createToken("Real Dex", "RDEX", "", ctx.creator.address, ethers.ZeroAddress, 0, { value: E(0.5) })).wait();
    const ev = rc.logs.map((l) => { try { return ctx.factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "TokenCreated");
    return { address: ev.args.token, pair: ev.args.pair, token: await ethers.getContractAt("HyperPumpToken", ev.args.token), createGas: rc.gasUsed };
}

describe("Migration into real HyperSwap V2 (mainnet bytecode)", () => {
    it("predicts the pair address the real factory creates", async () => {
        const ctx = await loadFixture(deploy);
        const { address, pair } = await launch(ctx);
        const created = await ctx.v2.createPair.staticCall(address, snap.whype);
        expect(created).to.equal(pair);
    });

    it("launch fits a small block; migration seeds the real pair and burns the LP", async () => {
        const ctx = await loadFixture(deploy);
        const { address, pair, token, createGas } = await launch(ctx);
        expect(createGas).to.be.lt(3_000_000n);

        await ctx.factory.connect(ctx.bob).buy(address, 0, ctx.bob.address, { value: E(100) });
        const raised = (await ctx.factory.curves(address)).realHype;
        const curveEndPrice = Number((await ctx.factory.curves(address)).virtualHype) / Number((await ctx.factory.curves(address)).virtualToken);

        const tx = await ctx.factory.connect(ctx.alice).migrate(address);
        const rc = await tx.wait();
        console.log(`      gas: createToken+buy ${createGas}, migrate (createPair + mint on real HyperSwap) ${rc.gasUsed}`);
        await expect(tx).to.emit(ctx.factory, "Migrated");

        const p = new ethers.Contract(pair, PAIR_ABI, ctx.owner);
        expect(await ctx.v2.getPair(address, snap.whype)).to.equal(pair);
        const [r0, r1] = await p.getReserves();
        const tokenIs0 = (await p.token0()).toLowerCase() === address.toLowerCase();
        const [rTok, rHype] = tokenIs0 ? [r0, r1] : [r1, r0];
        expect(rTok).to.equal(PARAMS.totalSupply - PARAMS.curveSupply);
        expect(rHype).to.equal(raised - (raised * 100n) / 10000n);
        // DEX opens within ~2% of where the curve ended
        const dexPrice = Number(rHype) / Number(rTok);
        expect(Math.abs(dexPrice / curveEndPrice - 1)).to.be.lt(0.02);
        // all LP except the locked minimum went to the dead address
        expect(await p.balanceOf(DEAD)).to.equal((await p.totalSupply()) - 1000n);
        expect(await token.graduated()).to.equal(true);

        // the pool is a working market: swap HYPE for tokens
        await ctx.whype.connect(ctx.alice).deposit({ value: E(1) });
        await ctx.whype.connect(ctx.alice).transfer(pair, E(1));
        const out = (rTok * 990n) / 10000n / 31n; // well under 1 HYPE worth, any fee level passes
        await p.connect(ctx.alice).swap(tokenIs0 ? out : 0n, tokenIs0 ? 0n : out, ctx.alice.address, "0x");
        expect(await token.balanceOf(ctx.alice.address)).to.equal(out);
    });

    it("cannot be front-run: no one can seed the real pair before graduation", async () => {
        const ctx = await loadFixture(deploy);
        const { address, pair, token } = await launch(ctx);
        await expect(ctx.factory.connect(ctx.alice).buy(address, 0, pair, { value: E(2) })).to.be.revertedWithCustomError(ctx.factory, "InvalidAddress");
        await ctx.factory.connect(ctx.alice).buy(address, 0, ctx.alice.address, { value: E(2) });
        await expect(token.connect(ctx.alice).transfer(pair, 1n)).to.be.revertedWithCustomError(token, "PairLockedUntilGraduation");
        // Pre-create the pair and donate WHYPE: migration must still work and nobody else holds LP.
        // (HyperSwap's pair refuses sync() before its first mint, so the donation can't be synced in.)
        await ctx.v2.connect(ctx.alice).createPair(address, snap.whype);
        await ctx.whype.connect(ctx.alice).deposit({ value: E(1) });
        await ctx.whype.connect(ctx.alice).transfer(pair, E(1));
        const p = new ethers.Contract(pair, PAIR_ABI, ctx.alice);
        await expect(p.sync()).to.be.reverted;
        await expect(p.mint(ctx.alice.address)).to.be.reverted;
        await ctx.factory.connect(ctx.bob).buy(address, 0, ctx.bob.address, { value: E(100) });
        await expect(ctx.factory.migrate(address)).to.emit(ctx.factory, "Migrated");
        expect(await p.balanceOf(ctx.alice.address)).to.equal(0n);
        expect(await p.balanceOf(DEAD)).to.equal((await p.totalSupply()) - 1000n);
    });
});
