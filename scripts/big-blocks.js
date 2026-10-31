// Switches an address between HyperEVM small blocks (3M gas, every ~1s) and
// big blocks (30M gas, every ~60s). The migrator key needs big blocks because
// migrate() uses ~3.7M gas; the relayer must stay on small blocks.
//   npm run big-blocks -- status [address]
//   npm run big-blocks -- on|off          (signs with MIGRATOR_PRIVATE_KEY)
//
// The switch is a HyperCore "L1 action" ({type: 'evmUserModify'}), signed the
// way Hyperliquid's official Python SDK does it (sign_l1_action): msgpack the
// action, append the nonce, hash, and sign an EIP-712 "Agent" message.
// The address must already exist on HyperCore (e.g. it has received USDC or
// HYPE there) before HyperCore accepts any action from it.
import { encode } from '@msgpack/msgpack';
import { keccak256, concat, toHex, numberToHex, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

process.env.NO_JOBS = '1';

export function actionHash(action, nonce) {
    return keccak256(concat([toHex(encode(action)), numberToHex(BigInt(nonce), { size: 8 }), '0x00']));
}

export async function signL1Action(account, action, nonce, isMainnet) {
    const signature = await account.signTypedData({
        domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
        types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
        primaryType: 'Agent',
        message: { source: isMainnet ? 'a' : 'b', connectionId: actionHash(action, nonce) },
    });
    // Same wire format as the SDK: r and s as minimal hex numbers.
    return { r: toHex(BigInt(signature.slice(0, 66))), s: toHex(BigInt(`0x${signature.slice(66, 130)}`)), v: parseInt(signature.slice(130, 132), 16) };
}

async function main() {
    const { config } = await import('../server/config.js');
    const evm = await import('../server/hyperevm.js');
    const [cmd, arg] = process.argv.slice(2);
    const isMainnet = config.evm.chainId === 999;
    const api = isMainnet ? 'https://api.hyperliquid.xyz' : 'https://api.hyperliquid-testnet.xyz';

    if (cmd === 'status') {
        const address = arg && isAddress(arg) ? arg : evm.migrator?.address;
        if (!address) throw new Error('Pass an address or set MIGRATOR_PRIVATE_KEY.');
        console.log(`${address}: ${(await evm.usingBigBlocks(address)) ? 'big blocks' : 'small blocks'}`);
        return;
    }
    if (cmd !== 'on' && cmd !== 'off') {
        console.log('Usage: npm run big-blocks -- status [address] | on | off');
        return;
    }
    const key = process.env.MIGRATOR_PRIVATE_KEY;
    if (!key) throw new Error('MIGRATOR_PRIVATE_KEY is not set. This changes the migrator only, never the relayer.');
    const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
    const action = { type: 'evmUserModify', usingBigBlocks: cmd === 'on' }; // key order matters for the hash
    const nonce = Date.now();
    const signature = await signL1Action(account, action, nonce, isMainnet);
    const res = await fetch(`${api}/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, nonce, signature, vaultAddress: null, expiresAfter: null }),
    });
    const body = await res.text();
    console.log(`HyperCore replied (${res.status}): ${body}`);
    if (!res.ok || /err/i.test(body)) {
        console.log('If it says the user does not exist, send any USDC or HYPE to this address on HyperCore first, then retry.');
        process.exitCode = 1;
        return;
    }
    await new Promise((r) => setTimeout(r, 3000));
    console.log(`${account.address}: ${(await evm.usingBigBlocks(account.address)) ? 'big blocks' : 'small blocks'}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}
