require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: {
        version: "0.8.24",
        settings: {
            optimizer: { enabled: true, runs: 500 },
            viaIR: true,
            evmVersion: "cancun",
        },
    },
    networks: {
        hardhat: { chainId: 31337 },
        localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
        hyperevmTestnet: {
            url: process.env.HYPEREVM_TESTNET_RPC || "https://rpc.hyperliquid-testnet.xyz/evm",
            chainId: 998,
            accounts,
        },
        hyperevm: {
            url: process.env.HYPEREVM_RPC || "https://rpc.hyperliquid.xyz/evm",
            chainId: 999,
            accounts,
        },
    },
};
