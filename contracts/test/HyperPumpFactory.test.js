const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const PARAMS = {
    virtualHype: E(10),
    virtualToken: E(1_066_666_667),
    curveSupply: E(800_000_000),
    totalSupply: E(1_000_000_000),
};

async function deploy() {
    const [owner, launcher, alice, bob, creator, fees] = await ethers.getSigners();
    const whype = await (await ethers.getContractFactory("MockWHYPE")).deploy();
    const v2 = await (await ethers.getContractFactory("MockV2Factory")).deploy();
    const factory = await (await ethers.getContractFactory("HyperPumpFactory")).deploy(
        owner.address, await whype.getAddress(), await v2.getAddress(), await v2.INIT_CODE_HASH(),
        PARAMS, fees.address, 70, 30, 100,
    );
    await factory.setLauncher(launcher.address, true);
    return { factory, whype, v2, owner, launcher, alice, bob, creator, fees };
}

async function launch(ctx, value = 0n) {
    const { factory, launcher, creator } = ctx;
    const tx = await factory.connect(launcher).createToken("Hyper Frog", "HFROG", "https://x/m.json", creator.address, ethers.ZeroAddress, 0, { value });
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "TokenCreated");
    const token = await ethers.getContractAt("HyperPumpToken", ev.args.token);
    return { token, address: ev.args.token, pair: ev.args.pair };
}

async function fillCurve(ctx, address) {
    await ctx.factory.connect(ctx.bob).buy(address, 0, ctx.bob.address, { value: E(100) });
}

describe("HyperPumpFactory", () => {
    it("launches a fixed-supply token held by the factory", async () => {
        const ctx = await loadFixture(deploy);
        const { token, address } = await launch(ctx);
        expect(await token.name()).to.equal("Hyper Frog");
        expect(await token.symbol()).to.equal("HFROG");
        expect(await token.totalSupply()).to.equal(PARAMS.totalSupply);
        expect(await token.balanceOf(await ctx.factory.getAddress())).to.equal(PARAMS.totalSupply);
        const c = await ctx.factory.curves(address);
        expect(c.realToken).to.equal(PARAMS.curveSupply);
        expect(c.creator).to.equal(ctx.creator.address);
        expect(await ctx.factory.tokenCount()).to.equal(1n);
    });

    it("restricts launches to approved launchers unless opened", async () => {
        const ctx = await loadFixture(deploy);
        await expect(ctx.factory.connect(ctx.alice).createToken("A", "A", "", ctx.alice.address, ethers.ZeroAddress, 0))
            .to.be.revertedWithCustomError(ctx.factory, "NotLauncher");
        await ctx.factory.setLaunchSettings(true, false);
        await expect(ctx.factory.connect(ctx.alice).createToken("A", "A", "", ctx.alice.address, ethers.ZeroAddress, 0)).to.not.be.reverted;
        await ctx.factory.setLaunchSettings(true, true);
        await expect(ctx.factory.connect(ctx.alice).createToken("A", "A", "", ctx.alice.address, ethers.ZeroAddress, 0))
            .to.be.revertedWithCustomError(ctx.factory, "LaunchesPaused");
    });

    it("validates metadata lengths", async () => {
        const ctx = await loadFixture(deploy);
        await expect(ctx.factory.connect(ctx.launcher).createToken("", "A", "", ctx.creator.address, ethers.ZeroAddress, 0))
            .to.be.revertedWithCustomError(ctx.factory, "InvalidMetadata");
        await expect(ctx.factory.connect(ctx.launcher).createToken("A", "ELEVENCHARS", "", ctx.creator.address, ethers.ZeroAddress, 0))
            .to.be.revertedWithCustomError(ctx.factory, "InvalidMetadata");
    });

    it("spends launch value as an atomic first buy for the creator", async () => {
        const ctx = await loadFixture(deploy);
        const quoted = await ctx.factory.quoteLaunchBuy(E(1));
        const { token } = await launch(ctx, E(1));
        expect(await token.balanceOf(ctx.creator.address)).to.equal(quoted);
        expect(quoted).to.be.gt(0n);
    });

    it("buys and sells along the curve and charges capped fees", async () => {
        const ctx = await loadFixture(deploy);
        const { token, address } = await launch(ctx);
        const [quoteOut, quoteFee] = await ctx.factory.quoteBuy(address, E(2));
        expect(quoteFee).to.equal(E(2) * 100n / 10000n);
        await ctx.factory.connect(ctx.alice).buy(address, quoteOut, ctx.alice.address, { value: E(2) });
        const bal = await token.balanceOf(ctx.alice.address);
        expect(bal).to.equal(quoteOut);

        // price rises after a buy
        const [secondOut] = await ctx.factory.quoteBuy(address, E(2));
        expect(secondOut).to.be.lt(quoteOut);

        await token.connect(ctx.alice).approve(await ctx.factory.getAddress(), bal);
        const [hypeOut] = await ctx.factory.quoteSell(address, bal);
        const before = await ethers.provider.getBalance(ctx.bob.address);
        await ctx.factory.connect(ctx.alice).sell(address, bal, hypeOut, ctx.bob.address);
        expect(await ethers.provider.getBalance(ctx.bob.address) - before).to.equal(hypeOut);
        // round trip loses ~2% to fees, never more than paid in
        expect(hypeOut).to.be.lt(E(2));
        expect(hypeOut).to.be.gt(E(1.95));

        // fee split 70/30 between protocol and creator
        const protocol = await ctx.factory.accruedFees(ctx.fees.address);
        const creatorFees = await ctx.factory.accruedFees(ctx.creator.address);
        expect(protocol).to.be.gt(creatorFees);
        await expect(ctx.factory.connect(ctx.creator).claimFees()).to.changeEtherBalance(ctx.creator, creatorFees);
    });

    it("enforces slippage limits", async () => {
        const ctx = await loadFixture(deploy);
        const { address } = await launch(ctx);
        const [out] = await ctx.factory.quoteBuy(address, E(1));
        await ctx.factory.connect(ctx.bob).buy(address, 0, ctx.bob.address, { value: E(1) });
        await expect(ctx.factory.connect(ctx.alice).buy(address, out, ctx.alice.address, { value: E(1) }))
            .to.be.revertedWithCustomError(ctx.factory, "Slippage");
    });

    it("stays solvent: everyone can sell back everything", async () => {
        const ctx = await loadFixture(deploy);
        const { token, address } = await launch(ctx);
        const signers = (await ethers.getSigners()).slice(6, 16);
        for (let i = 0; i < signers.length; i++) {
            await ctx.factory.connect(signers[i]).buy(address, 0, signers[i].address, { value: E(0.37 * (i + 1)) });
        }
        for (const s of signers.reverse()) {
            const bal = await token.balanceOf(s.address);
            await token.connect(s).approve(await ctx.factory.getAddress(), bal);
            await ctx.factory.connect(s).sell(address, bal, 0, s.address);
        }
        const c = await ctx.factory.curves(address);
        const owed = (await ctx.factory.accruedFees(ctx.fees.address)) + (await ctx.factory.accruedFees(ctx.creator.address));
        expect(await ethers.provider.getBalance(await ctx.factory.getAddress())).to.be.gte(c.realHype + owed);
        expect(c.realToken).to.equal(PARAMS.curveSupply);
    });

    it("completes the curve, refunds overpayment, and blocks further curve trades", async () => {
        const ctx = await loadFixture(deploy);
        const { token, address } = await launch(ctx);
        const before = await ethers.provider.getBalance(ctx.bob.address);
        const tx = await ctx.factory.connect(ctx.bob).buy(address, 0, ctx.bob.address, { value: E(100) });
        const rc = await tx.wait();
        const spent = before - (await ethers.provider.getBalance(ctx.bob.address)) - rc.gasUsed * rc.gasPrice;
        // ~30.08 HYPE raised + 1% fee; the rest refunded
        expect(spent).to.be.gt(E(30));
        expect(spent).to.be.lt(E(31));
        await expect(tx).to.emit(ctx.factory, "CurveCompleted").withArgs(address);
        expect(await token.balanceOf(ctx.bob.address)).to.equal(PARAMS.curveSupply);
        await expect(ctx.factory.connect(ctx.alice).buy(address, 0, ctx.alice.address, { value: E(1) }))
            .to.be.revertedWithCustomError(ctx.factory, "CurveIsComplete");
    });

    it("locks transfers to the future pair until graduation", async () => {
        const ctx = await loadFixture(deploy);
        const { token, address, pair } = await launch(ctx);
        expect(pair).to.equal(await ctx.factory.pairFor(address));
        await ctx.factory.connect(ctx.alice).buy(address, 0, ctx.alice.address, { value: E(1) });
        await expect(token.connect(ctx.alice).transfer(pair, 1n)).to.be.revertedWithCustomError(token, "PairLockedUntilGraduation");
        await expect(token.connect(ctx.alice).transfer(ctx.bob.address, 1n)).to.not.be.reverted;
    });

    it("blocks seeding the future pair through a curve buy (first-LP attack)", async () => {
        const ctx = await loadFixture(deploy);
        const { token, address, pair } = await launch(ctx);
        await expect(ctx.factory.connect(ctx.alice).buy(address, 0, pair, { value: E(2) }))
            .to.be.revertedWithCustomError(ctx.factory, "InvalidAddress");
        await ctx.factory.connect(ctx.alice).buy(address, 0, ctx.alice.address, { value: E(2) });
        await expect(token.connect(ctx.alice).transferFrom(ctx.alice.address, pair, 1n)).to.be.reverted;
        await token.connect(ctx.alice).approve(ctx.bob.address, 10n);
        await expect(token.connect(ctx.bob).transferFrom(ctx.alice.address, pair, 1n)).to.be.revertedWithCustomError(token, "PairLockedUntilGraduation");
        // nothing can reach the pair, so no LP exists before migration
        await ctx.v2.createPair(address, await ctx.whype.getAddress());
        const lp = await ethers.getContractAt("MockV2Pair", pair);
        await ctx.whype.connect(ctx.alice).deposit({ value: 1000000n });
        await ctx.whype.connect(ctx.alice).transfer(pair, 1000000n);
        await expect(lp.mint(ctx.alice.address)).to.be.reverted;
        await fillCurve(ctx, address);
        await ctx.factory.migrate(address);
        expect(await lp.balanceOf(ctx.alice.address)).to.equal(0n);
        expect(await lp.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal((await lp.totalSupply()) - 1000n);
    });

    it("migrates liquidity to the DEX pair and burns the LP", async () => {
        const ctx = await loadFixture(deploy);
        const { token, address, pair } = await launch(ctx);
        await expect(ctx.factory.migrate(address)).to.be.revertedWithCustomError(ctx.factory, "CurveNotComplete");
        await fillCurve(ctx, address);
        const raised = (await ctx.factory.curves(address)).realHype;
        const fee = raised * 100n / 10000n;

        await expect(ctx.factory.connect(ctx.alice).migrate(address)).to.emit(ctx.factory, "Migrated");
        expect(await ctx.v2.getPair(address, await ctx.whype.getAddress())).to.equal(pair);
        expect(await token.balanceOf(pair)).to.equal(PARAMS.totalSupply - PARAMS.curveSupply);
        expect(await ctx.whype.balanceOf(pair)).to.equal(raised - fee);
        const lp = await ethers.getContractAt("MockV2Pair", pair);
        expect(await lp.balanceOf("0x000000000000000000000000000000000000dEaD")).to.be.gt(0n);
        expect(await token.graduated()).to.equal(true);
        await expect(token.connect(ctx.bob).transfer(pair, 1n)).to.not.be.reverted;
        await expect(ctx.factory.migrate(address)).to.be.revertedWithCustomError(ctx.factory, "AlreadyMigrated");
    });

    it("migrates even if someone created the pair and donated WHYPE first", async () => {
        const ctx = await loadFixture(deploy);
        const { address, pair } = await launch(ctx);
        const whypeAddr = await ctx.whype.getAddress();
        await ctx.v2.createPair(address, whypeAddr);
        await ctx.whype.connect(ctx.alice).deposit({ value: E(1) });
        await ctx.whype.connect(ctx.alice).transfer(pair, E(1));
        await (await ethers.getContractAt("MockV2Pair", pair)).sync();
        await fillCurve(ctx, address);
        await expect(ctx.factory.migrate(address)).to.emit(ctx.factory, "Migrated");
    });

    it("caps fees and validates params", async () => {
        const ctx = await loadFixture(deploy);
        await expect(ctx.factory.setFees(ctx.fees.address, 150, 51, 0)).to.be.revertedWithCustomError(ctx.factory, "FeeTooHigh");
        await expect(ctx.factory.setFees(ctx.fees.address, 100, 0, 501)).to.be.revertedWithCustomError(ctx.factory, "FeeTooHigh");
        await expect(ctx.factory.setParams({ ...PARAMS, virtualToken: PARAMS.curveSupply })).to.be.revertedWithCustomError(ctx.factory, "InvalidParams");
        await expect(ctx.factory.setParams({ ...PARAMS, curveSupply: PARAMS.totalSupply })).to.be.revertedWithCustomError(ctx.factory, "InvalidParams");
        await expect(ctx.factory.connect(ctx.alice).setFees(ctx.alice.address, 0, 0, 0)).to.be.revertedWithCustomError(ctx.factory, "OwnableUnauthorizedAccount");
    });

    it("works with zero fees", async () => {
        const ctx = await loadFixture(deploy);
        await ctx.factory.setFees(ctx.fees.address, 0, 0, 0);
        const { address } = await launch(ctx, E(1));
        await fillCurve(ctx, address);
        await expect(ctx.factory.migrate(address)).to.emit(ctx.factory, "Migrated");
    });
});
