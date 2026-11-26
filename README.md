# Jagain — your position's night watchman

**Jagain** (Indonesian for *"watch over it for me"*) is a fully on-chain
trade-protection system for Uniswap V2 pairs: **stop-loss, take-profit and
trailing-stop orders that execute themselves** — no server, no keeper bot,
no cron job, nobody watching a chart at 3 a.m.

You place an order once. A Reactive Smart Contract on the Reactive Network
(Lasna testnet) watches the pair's `Sync` events on Base Sepolia, recomputes
the price on every reserve change, and the moment your level is crossed it
calls back to your personal callback contract, which re-verifies the price
from live reserves and performs the swap through the router. Set it, and
Jagain stands guard.

Built for the **Reactive Omni Buildathon**, track **Every Second Counts**.

## Why this matters

Retail traders lose money in the hours they are *not* watching. Centralized
exchanges offer stop orders; on-chain AMM traders mostly have nothing —
existing "stop-loss" tools are off-chain bots that can be down, censored or
honeypots. Jagain moves the whole loop on-chain: the watcher's logic, the
trigger decision and the execution all live in contracts, and every step is
verifiable from event logs and transaction hashes.

## How it works

```
Base Sepolia (destination)                Reactive Lasna (watcher)
┌──────────────────────────┐              ┌──────────────────────────┐
│ SentinelCallback (yours) │── OrderCreated ─▶ SentinelReactive        │
│  - holds your orders     │              │  - tracks your orders    │
│  - executes swaps        │              │  - subscribes to the     │
│                          │   Sync       │    pair's Sync events    │
│ Uniswap V2 pair          │── (reserves) ─▶  - recomputes price     │
│  sGOLD / sUSD            │              │  - ratchets trailing     │
│                          │◀── Callback ──│    stops                 │
│  executeOrder()          │   when level │  - emits Callback when   │
│  re-verifies price,      │   is crossed │    a level is crossed    │
│  swaps via the router    │              └──────────────────────────┘
└──────────────────────────┘
```

Order types:

| Kind | Fires when |
| --- | --- |
| Stop-loss | price ≤ trigger |
| Take-profit | price ≥ trigger |
| Trailing stop | price falls back to `peak × (1 − trailBps)` after ratcheting up behind new highs |

Safety properties:

- **Per-user isolation** — every user deploys their own callback contract;
  orders, allowances and proceeds never mix.
- **No escrow** — tokens stay in your wallet until the trigger moment; the
  callback pulls via your ERC-20 allowance at execution time.
- **Price re-verification** — the callback re-reads live reserves and
  enforces a slippage bound before swapping; a stale or manipulated trigger
  cannot force a bad fill.
- **Retry discipline** — per-order cooldown and a maximum-attempts cap in
  the watcher prevent callback spam.
- Full lifecycle: create, pause, resume, cancel — the watcher subscribes
  and unsubscribes to pair `Sync` events dynamically as orders come and go.

## Deployments (testnet)

Destination chain: **Base Sepolia** (84532) · Watcher chain: **Reactive
Lasna** (5318007). Full machine-readable list in [`deployments.json`](deployments.json).

| Contract | Address |
| --- | --- |
| SentinelCallback | `0x76447AAbe4806639ed259FD837F3D208a7B9407e` |
| SentinelReactive (Lasna) | `0x8500f9e37e9a17fa47f52b6bb68fe0fa12d0e0c9` |
| Pair sGOLD/sUSD | `0x6Eb12BA6c5c484152Dbdb75fA0729e1A6F81e9cb` |
| Router (demo DEX) | `0xc7Dff5F8DEb73318932e13423569D2bE2b94A31B` |
| sGOLD (TKA) | `0x50403AdE2Eaa14aB098C1ef3bB988bEE5709ECB3` |
| sUSD (TKB) | `0x9C248a6ab42F805051252d43D9f67b8D9281ce8d` |

The demo DEX is a self-deployed canonical Uniswap V2 stack (factory,
router, WETH, pair) so the whole flow runs on testnet end-to-end; Jagain's
own contracts are pair- and router-agnostic.

## The dApp

[`app/`](app/) is a dependency-light dashboard (plain HTML + ethers v6 via
CDN): connect a wallet, read the live pair price, create stop-loss /
take-profit / trailing-stop orders, pause / resume / cancel them, follow
the activity feed, and run the guided 4-step demo that moves the price and
lets Jagain fire on its own. All contract addresses live in one file,
`app/config.js`.

## Repository layout

- `src/SentinelReactive.sol` — the watcher on Reactive Lasna
- `src/SentinelCallback.sol` — the per-user order book + executor on Base Sepolia
- `src/DemoToken.sol`, `src/WETH9.sol` — demo assets
- `app/` — the dashboard
- `lib/` — vendored dependencies (Reactive contracts library, Uniswap V2
  core/periphery, OpenZeppelin, forge-std)

Build with Foundry: `forge build`.

## Status note (20 Nov 2026)

End-to-end deployment is complete and verified on-chain (DEX live, pool
funded 100/100, order #0 created, price pushed below its stop level). At
the time of writing, the Lasna testnet is not processing reactions — the
Reactive team's own Basic Demo, deployed verbatim from the official demos
repository on Ethereum Sepolia, shows the identical stall (no callbacks,
no REACT charged), which isolates the delay to testnet event ingestion
rather than to this project's contracts. The live-fire transaction hashes
will be added here as soon as ingestion resumes and the pending order
executes.

## License

MIT for Jagain's own contracts; vendored libraries keep their upstream
licenses.
