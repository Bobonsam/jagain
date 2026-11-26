# Jagain — demo video script (< 3 min)

Status 26 Nov 2026: **final except the callback segment (1:35–2:20)**,
which needs the real callback tx hash + measured latency. Those exist
only when Lasna ingestion resumes (see livefire/EVIDENCE-2026-11-26.md).
A fallback version of that segment is included below and is honest to
show judges if we submit while the callback is still pending.
Narration language: English (DoraHacks judges). Target runtime ~2:50.

---

**0:00–0:15 — The problem**
画面: A price chart falling through the night; a phone face-down.
VO: "It's 3 a.m. Your position is bleeding. On a centralised exchange, a
stop-loss would have saved you. On an AMM, there is no stop order —
only keeper bots. Servers. And servers sleep."

**0:15–0:40 — Meet Jagain**
画面: Dashboard (app/) + the two contract addresses on Basescan/Lasna
explorer: SentinelCallback 0x76447AAbe4806639ed259FD837F3D208a7B9407e
(Base Sepolia), SentinelReactive 0x8500f9e37e9a17fa47f52b6bb68fe0fa12d0e0c9
(Lasna).
VO: "Jagain — Indonesian for 'watch over it for me' — is trade
protection with no server at all. You place an order once, in your own
contract. A Reactive Smart Contract on Lasna watches the pair for you,
every block, and executes the moment your level breaks."

**0:40–1:10 — Placing the stop-loss (real tx)**
画面: dApp guided demo / Basescan tx page.
On screen: Order #1 — stop-loss, sell 2 sGOLD, trigger 0.88.
Tx: 0x88c1fdd8c71d2642c12f74386c1ec70be68e3dfa03125897133a1fc3f464d2f7
(Base Sepolia block 63717708). Price at placement: 0.9981.
VO: "Here is a real stop-loss, placed on testnet today. Two sGOLD,
trigger at 0.88. Nothing is escrowed — the contract pulls from my
allowance only when it fires. From this moment, I can close the laptop."

**1:10–1:35 — The price move (real tx)**
画面: Swap tx + pair reserves before/after.
On screen: Tx 0x53503fc5d3755132329fa06c884403764b65098410e3c5d98825e5f7f2964781
(block 63722309). Reserves 100.16/99.98 → 107.17/93.45. Price 0.9981 →
0.8719 — through the trigger.
VO: "Now the market moves against the position. One swap pushes the
price to 0.8719 — below the trigger. Watch what happens with nobody
online."

**1:35–2:20 — The callback fires [PENDING REAL FOOTAGE]**
画面 (to record once ingestion resumes): Lasna explorer showing
ExecutionTriggered for order #1 → Basescan showing the callback
transaction delivering executeOrder → OrderExecuted event; order status
flips to Executed; sUSD lands in the owner wallet.
On screen: callback tx hash «FILL IN», end-to-end latency «FILL IN»
seconds (Sync block timestamp → callback block timestamp).
VO: "The reactive contract sees the Sync event, checks the level, and
fires a callback across chains. The callback contract re-verifies the
price from live reserves, enforces its slippage bound, and swaps.
No bot. No server. No human. «FILL IN» seconds, block to block."

**1:35–2:20 — FALLBACK segment (use only if submitting while pending)**
画面: The armed order on Basescan (Active, price already through the
trigger), the live-fire evidence table, Lasna block height ticking up.
VO: "One honest note. As of filming, Lasna's event ingestion for Base
Sepolia is stalled — the network produces blocks but isn't delivering
origin events, a stall that reproduces identically with Reactive's own
official Basic Demo. So the loop is armed, not yet fired: the order is
live, the price is through the trigger, and the moment ingestion
resumes, the queued events execute it. Everything on our side of the
wire is deployed, funded, and verified on-chain."

**2:20–2:50 — Why Reactive / close**
画面: Architecture diagram from the README; repo URL.
VO: "Stop-loss, take-profit, trailing stops that ratchet behind the
peak — the whole loop is contract logic, so reaction time is bounded
only by the networks themselves. That's what 'every second counts'
means. Jagain: place the order, close the laptop, sleep.
Code: github.com/Bobonsam/jagain"

---

Production notes
- Render with Remotion (house engine) from screen captures of the dApp
  + explorers; export H.264 High, yuv420p, faststart.
- Do NOT record the fallback segment's "armed" screens until the day of
  submission — state may change if ingestion resumes; re-verify
  trackedOrders(1) / order status first.
- If the callback lands before submission, swap the fallback segment
  for the real one and update the BUIDL draft hashes.
