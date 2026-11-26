/**
 * Sentinel — deployment configuration
 * =====================================
 * Fill these in AFTER the contracts are deployed (see README.md).
 * Until CALLBACK_ADDRESS / PAIR_ADDRESS / ROUTER_ADDRESS / TOKEN_A / TOKEN_B
 * hold real addresses, the app runs in "not deployed yet" mode: the live
 * price, order form, order actions and demo swap stay disabled and a notice
 * is shown instead of throwing errors.
 *
 * Destination chain: Base Sepolia (chain id 84532), where SentinelCallback,
 * the demo Uniswap-V2-style DEX, the pair and the tokens live.
 * Watcher chain:     Reactive Lasna (chain id 5318007), where
 * SentinelReactive lives. The dApp only *displays* the watcher info — all
 * user interactions happen on the destination chain.
 */
window.SENTINEL_CONFIG = {
  // ---- Destination chain (Base Sepolia) ----------------------------------
  CHAIN_ID: 84532,
  CHAIN_NAME: "Base Sepolia",
  RPC_URL: "https://sepolia.base.org",
  EXPLORER_BASE_URL: "https://sepolia.basescan.org", // tx links: <base>/tx/<hash>

  // ---- Deployed contracts on Base Sepolia — TODO after deployment --------
  CALLBACK_ADDRESS: "0x76447AAbe4806639ed259FD837F3D208a7B9407e", // SentinelCallback (per-user)
  PAIR_ADDRESS: "0x6Eb12BA6c5c484152Dbdb75fA0729e1A6F81e9cb",     // Uniswap V2 pair sGOLD/sUSD
  ROUTER_ADDRESS: "0xc7Dff5F8DEb73318932e13423569D2bE2b94A31B",   // Uniswap V2 router
  TOKEN_A: "0x50403AdE2Eaa14aB098C1ef3bB988bEE5709ECB3",          // sGOLD (the protected asset, sold by orders)
  TOKEN_B: "0x9C248a6ab42F805051252d43D9f67b8D9281ce8d",          // sUSD  (the quote / proceeds token)

  // ---- Reactive Network watcher (display only) ---------------------------
  REACTIVE_CHAIN_ID: 5318007,
  REACTIVE_CHAIN_NAME: "Reactive Lasna",
  REACTIVE_RPC_URL: "https://lasna-rpc.rnk.dev/",
  REACTIVE_ADDRESS: "0x8500f9e37e9a17fa47f52b6bb68fe0fa12d0e0c9", // SentinelReactive on Lasna — TODO
  REACTIVE_EXPLORER_URL: "https://lasna.reactscan.net",           // hint: check Lasna explorer for the watcher

  // ---- App behaviour ------------------------------------------------------
  // Prices on-chain are scaled by this coefficient (price = reserve ratio *
  // COEFFICIENT). 10000 = 4 decimal places, matching the deploy scripts.
  COEFFICIENT: 10000,
  PRICE_DECIMALS: 4,
  // First block scanned for OrderCreated / OrderExecuted history.
  FROM_BLOCK: 0,
  PRICE_REFRESH_MS: 6000,
};
