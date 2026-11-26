# Sentinel dApp

The web frontend for **Sentinel** — autonomous trade protection (stop-loss,
take-profit and trailing-stop orders) powered by the Reactive Network.

- **SentinelCallback** (Base Sepolia) holds a user's orders and executes the swap.
- **SentinelReactive** (Reactive Lasna) watches the pair's `Sync` events and
  calls the callback contract through the Reactive callback proxy when a
  trigger is crossed. No server, keeper or cron job is involved.
- This page is a plain static site: HTML + CSS + vanilla JS with
  [ethers.js v6](https://docs.ethers.org/v6/) from a CDN. **No build step.**

## 1. Fill in `config.js` after deployment

Open `config.js` and replace the zero-address placeholders with the addresses
printed by the deployment script (`deployments.json` in the parent project):

| Key | What it is |
| --- | --- |
| `CALLBACK_ADDRESS` | The user's deployed `SentinelCallback` contract on Base Sepolia |
| `PAIR_ADDRESS` | The Uniswap-V2 pair for the demo tokens (sGOLD/sUSD) |
| `ROUTER_ADDRESS` | The Uniswap-V2-style router used for swaps |
| `TOKEN_A` | sGOLD — the protected asset that orders sell |
| `TOKEN_B` | sUSD — the quote token orders sell into |
| `REACTIVE_ADDRESS` | `SentinelReactive` on Reactive Lasna (display only) |

Usually already correct, but double-check:

- `CHAIN_ID` / `CHAIN_NAME` / `RPC_URL` — destination chain (Base Sepolia,
  `84532`, `https://sepolia.base.org`).
- `EXPLORER_BASE_URL` — block explorer used for transaction links
  (`https://sepolia.basescan.org`).
- `REACTIVE_EXPLORER_URL` — Lasna explorer hint for the watcher contract.
- `COEFFICIENT` — the price scale used by the contracts (`10000` = 4 decimal
  places). Must match what orders were deployed/created with.
- `FROM_BLOCK` — first block scanned for order history / activity. `0` is fine
  on testnet; raise it if history queries get slow.

Until the five deployment addresses are real, the app detects the
placeholders and runs in **"not deployed yet"** mode: a banner is shown and
all data/transaction controls stay disabled instead of throwing errors.

## 2. Run it

Any static file server works. From this directory:

```bash
# Python
python3 -m http.server 8080

# or Node
npx serve .
```

Then open <http://localhost:8080> in a browser with a wallet (MetaMask)
installed. It can also be hosted as-is on GitHub Pages / Netlify / IPFS —
just upload `index.html`, `app.js` and `config.js` together.

## 3. Using the app

1. **Connect Wallet** — connect the wallet that *owns* the SentinelCallback
   contract (`createOrder` etc. are `onlyOwner`). Connecting a different
   wallet gives a read-only view with a notice.
2. **Live Price** — the sGOLD price is computed from the pair reserves
   (`reserve quote × coefficient ÷ reserve base`), refreshed every few
   seconds and on new blocks.
3. **Create Protection Order**
   - *Stop Loss*: sell when the price falls to the trigger.
   - *Take Profit*: sell when the price rises to the trigger.
   - *Trailing Stop*: you set a percentage distance; the reactive contract
     ratchets the stop up behind the highest observed price and fires when
     the price falls that far below the peak. (On-chain, the order's
     `triggerPrice` simply records the price at creation time.)
   - Tokens are **not escrowed**: they stay in your wallet and Sentinel
     pulls them via `transferFrom` only when the trigger fires. Creating an
     order therefore includes an ERC-20 **approval for the callback
     contract** covering the protected amount — keep that allowance and the
     balance in place until the order executes or you cancel it.
4. **My Orders** — all orders on your callback contract, read live via
   `orderCount()` + `getOrder()`, with **Pause / Resume / Cancel** actions
   wired to the real contract calls.
5. **Activity** — `OrderCreated`, `OrderExecuted`, pause/resume/cancel
   events with explorer links.
6. **Live Demo** — the 4-step walkthrough: create an order → move the price
   with a demo swap through the router (`swapExactTokensForTokens`, 0
   minimum output, testnet only) → Sentinel fires on its own via the
   Reactive Network → the execution lands in the Activity feed.

## Notes

- All user transactions happen on Base Sepolia; the Lasna addresses in
  `config.js` are informational only.
- Demo-token balances are required for orders and demo swaps — the demo
  tokens are mintable testnet tokens (see the parent project's deploy
  scripts).
