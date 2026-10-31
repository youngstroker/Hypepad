// Copies the factory and token ABIs from the Hardhat build into server/abi.
// Run after `npm run compile` in contracts/.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
for (const name of ['HyperPumpFactory', 'HyperPumpToken']) {
    const artifact = JSON.parse(fs.readFileSync(path.join(root, 'contracts/artifacts/contracts', `${name}.sol`, `${name}.json`), 'utf8'));
    fs.writeFileSync(path.join(root, 'server/abi', `${name}.json`), JSON.stringify(artifact.abi, null, 2));
    console.log(`wrote server/abi/${name}.json`);
}
