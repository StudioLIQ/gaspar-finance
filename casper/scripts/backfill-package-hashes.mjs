#!/usr/bin/env node
/**
 * Backfill missing package_hash values in deployment records
 * Uses casper-js-sdk for reliable RPC communication
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY_DIR = path.resolve(__dirname, '../../deployments/casper');

const NETWORK = process.argv[2] || 'testnet';
let DEPLOY_FILE = process.argv[3] || '';

const NODE_URLS = {
  testnet: 'https://node.testnet.casper.network/rpc',
  mainnet: 'https://node.mainnet.casper.network/rpc',
  local: 'http://localhost:11101/rpc',
};

const NODE_ADDRESS = process.env.CSPR_NODE_ADDRESS || NODE_URLS[NETWORK];

if (!NODE_ADDRESS) {
  console.error(`Unknown network: ${NETWORK}`);
  process.exit(1);
}

// Find latest deployment file
if (!DEPLOY_FILE) {
  const files = fs.readdirSync(DEPLOY_DIR)
    .filter(f => f.startsWith(`${NETWORK}-`) && f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.error(`No deployment file found for network: ${NETWORK}`);
    process.exit(1);
  }
  DEPLOY_FILE = path.join(DEPLOY_DIR, files[0]);
}

console.log('=== Backfill Package Hashes ===');
console.log(`Network: ${NETWORK}`);
console.log(`Node: ${NODE_ADDRESS}`);
console.log(`Deployment file: ${DEPLOY_FILE}`);
console.log('');

function httpRequest(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
}

async function rpcCall(method, params) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  });

  const data = await httpRequest(NODE_ADDRESS, body);
  if (data.error) {
    throw new Error(`RPC error: ${data.error.message}`);
  }
  return data.result;
}

async function getStateRootHash() {
  const result = await rpcCall('chain_get_state_root_hash', []);
  return result.state_root_hash;
}

async function queryGlobalState(key) {
  const stateRootHash = await getStateRootHash();
  const result = await rpcCall('query_global_state', {
    state_identifier: { StateRootHash: stateRootHash },
    key,
    path: [],
  });
  return result.stored_value;
}

async function getPackageHashFromContract(contractHash) {
  try {
    const stored = await queryGlobalState(contractHash);

    // Casper 1.x
    if (stored?.Contract?.contract_package_hash) {
      return stored.Contract.contract_package_hash;
    }

    // Casper 2.0
    if (stored?.AddressableEntity?.package_hash) {
      return stored.AddressableEntity.package_hash;
    }

    return null;
  } catch (e) {
    console.error(`  Error querying ${contractHash}: ${e.message}`);
    return null;
  }
}

async function getPackageHashFromDeploy(deployHash) {
  try {
    const result = await rpcCall('info_get_deploy', [deployHash]);
    const transforms = result?.execution_results?.[0]?.result?.Success?.effect?.transforms || [];

    for (const t of transforms) {
      // Casper 1.x
      if (t.transform?.WriteContractPackage) {
        return t.key;
      }
      // Casper 2.0
      if (t.transform?.WritePackage) {
        return t.key;
      }
      // Check key pattern
      if (t.key?.startsWith('contract-package-') || t.key?.startsWith('package-')) {
        return t.key;
      }
    }

    return null;
  } catch (e) {
    console.error(`  Error getting deploy ${deployHash}: ${e.message}`);
    return null;
  }
}

async function main() {
  const deployData = JSON.parse(fs.readFileSync(DEPLOY_FILE, 'utf8'));
  const contracts = deployData.contracts || {};

  let updated = 0;
  let failed = 0;

  for (const [name, info] of Object.entries(contracts)) {
    const contractHash = info.hash;
    const deployHash = info.deploy_hash;
    const existingPkg = info.package_hash;

    if (!contractHash || contractHash === 'null') {
      console.log(`⏭ ${name}: no contract hash, skipping`);
      continue;
    }

    if (existingPkg && existingPkg !== 'null') {
      console.log(`✓ ${name}: already has package_hash`);
      continue;
    }

    process.stdout.write(`→ ${name}: `);

    let pkgHash = null;

    // Method 1: From deploy transforms
    if (deployHash && deployHash !== 'null') {
      process.stdout.write('checking deploy... ');
      pkgHash = await getPackageHashFromDeploy(deployHash);
    }

    // Method 2: Query contract
    if (!pkgHash) {
      process.stdout.write('querying contract... ');
      pkgHash = await getPackageHashFromContract(contractHash);
    }

    if (pkgHash) {
      deployData.contracts[name].package_hash = pkgHash;
      console.log(`✓ ${pkgHash}`);
      updated++;
    } else {
      console.log('✗ not found');
      failed++;
    }
  }

  // Save updated file
  if (updated > 0) {
    fs.writeFileSync(DEPLOY_FILE, JSON.stringify(deployData, null, 2));
  }

  console.log('');
  console.log('=== Summary ===');
  console.log(`Updated: ${updated}`);
  console.log(`Failed: ${failed}`);

  if (updated > 0) {
    console.log('');
    console.log(`Deployment file updated: ${DEPLOY_FILE}`);
    console.log('');
    console.log('Next steps:');
    console.log(`  ./casper/scripts/bind-frontend.sh ${NETWORK} ${DEPLOY_FILE}`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
