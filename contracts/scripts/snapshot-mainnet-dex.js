// Copies the live HyperEVM-mainnet bytecode (and config storage) of WHYPE and
// the HyperSwap V2 factory into test/fixtures/hyperswap-v2.json, so tests can
// run our migration against the real DEX code on a local chain.
//   node scripts/snapshot-mainnet-dex.js
const fs = require("fs");
const path = require("path");

const RPC = process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm";
const WHYPE = "0x5555555555555555555555555555555555555555";
const FACTORY = "0x724412C00059bf7d6ee7d4a1d0D5cd4de3ea1C48";
const INIT_CODE_HASH_SELECTOR = "0x5855a25a"; // INIT_CODE_PAIR_HASH()

async function rpc(method, params) {
    for (let attempt = 0; attempt < 8; attempt++) {
        const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const body = await res.json().catch(() => ({}));
        if (body.result !== undefined) return body.result;
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
    throw new Error(`${method} failed`);
}

(async () => {
    const block = await rpc("eth_blockNumber", []);
    const out = { source: RPC, block: parseInt(block, 16), whype: WHYPE, factory: FACTORY, code: {}, storage: {} };
    out.code[WHYPE] = await rpc("eth_getCode", [WHYPE, block]);
    out.code[FACTORY] = await rpc("eth_getCode", [FACTORY, block]);
    out.storage[FACTORY] = {};
    for (let i = 0; i < 12; i++) {
        const slot = `0x${i.toString(16)}`;
        const v = await rpc("eth_getStorageAt", [FACTORY, slot, block]);
        if (BigInt(v) !== 0n) out.storage[FACTORY][slot] = v;
    }
    out.initCodeHash = await rpc("eth_call", [{ to: FACTORY, data: INIT_CODE_HASH_SELECTOR }, block]);
    fs.writeFileSync(path.join(__dirname, "../test/fixtures/hyperswap-v2.json"), JSON.stringify(out, null, 2));
    console.log(`snapshot at block ${out.block}: factory ${(out.code[FACTORY].length - 2) / 2} bytes, ${Object.keys(out.storage[FACTORY]).length} storage slots, init hash ${out.initCodeHash}`);
})();
