// Deploys HyperPumpFactory and writes its address to deployments/<network>.json.
//
// Local (`--network localhost`): also deploys mock WHYPE and a mock V2 DEX and
// registers the first hardhat account as fee recipient and the second as launcher.
//
// Testnet/mainnet: set these in contracts/.env first. Verify every DEX address
// against the DEX's own docs before deploying; a wrong init-code hash makes
// migration revert with PairMismatch.
//   DEPLOYER_PRIVATE_KEY   deployer (needs HYPE; enable big blocks on HyperCore)
//   OWNER                  final owner (use a multisig)
//   FEE_RECIPIENT          protocol fee recipient
//   LAUNCHER               the server relayer address allowed to call createToken
//   WHYPE                  wrapped HYPE  (0x5555555555555555555555555555555555555555 on mainnet)
//   V2_FACTORY             Uniswap-V2-style factory on HyperEVM
//   PAIR_INIT_CODE_HASH    that factory's pair init-code hash
// Optional: VIRTUAL_HYPE (default 10), PROTOCOL_FEE_BPS (70), CREATOR_FEE_BPS (30), MIGRATION_FEE_BPS (100)
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));

function required(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing ${name} in contracts/.env`);
    return v;
}

async function main() {
    const [deployer, second] = await ethers.getSigners();
    const isLocal = network.name === "localhost" || network.name === "hardhat";
    console.log(`Deploying on ${network.name} from ${deployer.address}`);

    let whype, v2Factory, initCodeHash, owner, feeRecipient, launcher;
    if (isLocal && process.env.MAINNET_DEX === "1") {
        // Install the real mainnet WHYPE + HyperSwap V2 bytecode at their mainnet addresses.
        const snap = require("../test/fixtures/hyperswap-v2.json");
        for (const [address, code] of Object.entries(snap.code)) await network.provider.send("hardhat_setCode", [address, code]);
        for (const [slot, value] of Object.entries(snap.storage[snap.factory])) {
            await network.provider.send("hardhat_setStorageAt", [snap.factory, ethers.toBeHex(BigInt(slot), 32), value]);
        }
        whype = snap.whype;
        v2Factory = snap.factory;
        initCodeHash = snap.initCodeHash;
        owner = deployer.address;
        feeRecipient = deployer.address;
        launcher = process.env.LAUNCHER || second.address;
        console.log("Using real HyperSwap V2 + WHYPE bytecode from mainnet snapshot");
    } else if (isLocal) {
        const w = await (await ethers.getContractFactory("MockWHYPE")).deploy();
        const f = await (await ethers.getContractFactory("MockV2Factory")).deploy();
        whype = await w.getAddress();
        v2Factory = await f.getAddress();
        initCodeHash = await f.INIT_CODE_HASH();
        owner = deployer.address;
        feeRecipient = deployer.address;
        launcher = process.env.LAUNCHER || second.address;
    } else {
        whype = required("WHYPE");
        v2Factory = required("V2_FACTORY");
        initCodeHash = required("PAIR_INIT_CODE_HASH");
        owner = required("OWNER");
        feeRecipient = required("FEE_RECIPIENT");
        launcher = required("LAUNCHER");
    }

    const params = {
        virtualHype: E(process.env.VIRTUAL_HYPE || 10),
        virtualToken: E(1_066_666_667),
        curveSupply: E(800_000_000),
        totalSupply: E(1_000_000_000),
    };
    const fees = [
        Number(process.env.PROTOCOL_FEE_BPS ?? 70),
        Number(process.env.CREATOR_FEE_BPS ?? 30),
        Number(process.env.MIGRATION_FEE_BPS ?? 100),
    ];

    // On HyperEVM the deploy (~2.94M gas) is best sent from a big-blocks account,
    // and big blocks have their own gas price; cover both block types.
    let overrides = {};
    if (!isLocal) {
        const fee = await ethers.provider.getFeeData();
        const big = BigInt(await ethers.provider.send("eth_bigBlockGasPrice", []));
        const maxFeePerGas = [fee.maxFeePerGas ?? 0n, big * 2n].reduce((a, b) => (a > b ? a : b));
        overrides = { maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n };
        const bigBlocks = await ethers.provider.send("eth_usingBigBlocks", [deployer.address]);
        console.log(`Deployer on ${bigBlocks ? "big" : "small"} blocks; maxFeePerGas ${maxFeePerGas}`);
        if (!bigBlocks) console.log("Warning: the deploy needs ~2.94M gas, close to the 3M small-block limit. Enable big blocks for the deployer if it does not land.");
    }

    // Deploy with the deployer as owner so it can register the launcher, then hand over.
    const Factory = await ethers.getContractFactory("HyperPumpFactory");
    const factory = await Factory.deploy(deployer.address, whype, v2Factory, initCodeHash, params, feeRecipient, ...fees, overrides);
    await factory.waitForDeployment();
    const address = await factory.getAddress();
    const block = (await factory.deploymentTransaction().wait()).blockNumber;
    await (await factory.setLauncher(launcher, true, overrides)).wait();
    if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
        await (await factory.transferOwnership(owner, overrides)).wait();
        console.log(`Ownership transfer started: ${owner} must call acceptOwnership().`);
    }

    const out = {
        network: network.name,
        chainId: Number(network.config.chainId),
        factory: address,
        deployBlock: block,
        whype,
        v2Factory,
        pairInitCodeHash: initCodeHash,
        launcher,
        owner,
        feeRecipient,
        deployedAt: new Date().toISOString(),
    };
    const dir = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
