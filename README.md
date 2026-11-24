# GIWA Curve Swap

A small exchange front-end for **Ammora bonding-curve launches on GIWA Sepolia**,
built with [`@ammora-protocol/sdk`](https://www.npmjs.com/package/@ammora-protocol/sdk) 0.3.9.

Testnet only. Tokens here have no real value.

## What it does

- **Discovers launches** created by the Ammora V4 launch factory
  (`giwaSepoliaAutoRouteDeployment.contracts.launch.factory`). Factory logs come from the
  GIWA explorer API and are decoded with the SDK's `ammoraLaunchFactoryV4Abi`.
- **Shows curve progress**: `status`, `quoteReserve` and `migrationQuoteThreshold`, read
  with the SDK's `ammoraLaunchPoolV4Abi` in one Multicall3 batch.
- **Quotes and swaps** WETH ⇄ token on the curve through `AmmoraSwapClient.prepareExactIn`
  (model `dbc`, 1% slippage). `PreparedExactInputSwap.execute` then handles the exact
  ERC-20 approval, the simulation, the swap and receipt-block balance reconciliation.
- **Wraps and unwraps ETH ⇄ WETH** with `buildAmmoraPortableWrapTransaction` /
  `buildAmmoraPortableUnwrapTransaction`. New GIWA curves trade against WETH, and the
  native router is not enabled for this factory.
- **Connects any injected wallet** (EIP-6963; OKX Wallet preferred) and adds or switches to
  GIWA Sepolia (chain 91342).

No backend, no private keys. Every transaction is signed in the user's own wallet.

## Run

```sh
npm install
npm run dev      # local
npm run build    # static site in dist/
```

The public GIWA RPC rate-limits bursts, so the app serializes RPC calls, backs off on HTTP 429
and retries transient mixed-block reads.

## Key files

- `src/main.ts`: discovery, quotes, wallet, swap and wrap flows
- `scripts/quote-test.mjs`: read-only Node check of the same SDK quote path

MIT
