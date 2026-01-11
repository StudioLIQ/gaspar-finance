# GasperFinance Frontend

Casper testnet–only frontend. **Casper Wallet** is the only supported wallet.

## Requirements

- Node.js 18+
- Casper Wallet browser extension

## Environment

Optional (defaults provided):

```bash
NEXT_PUBLIC_CASPER_NODE_ADDRESS=https://rpc.testnet.casperlabs.io/rpc
NEXT_PUBLIC_CASPER_RPC_URL=https://rpc.testnet.casperlabs.io/rpc
NEXT_PUBLIC_CASPER_EXPLORER_URL=https://testnet.cspr.live
```

If the default testnet RPC hostname has DNS issues in your environment, use:

```bash
NEXT_PUBLIC_CASPER_NODE_ADDRESS=https://node.testnet.casper.network/rpc
```

## Run

```bash
npm install
npm run dev
```

## Notes

- Casper testnet only
- Casper Wallet only
