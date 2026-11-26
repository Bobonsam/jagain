/* =========================================================================
 * Sentinel dApp — vanilla JS + ethers.js v6
 *
 * Talks to:
 *  - SentinelCallback (destination chain, per-user): createOrder /
 *    pauseOrder / resumeOrder / cancelOrder / getOrder / orderCount,
 *    plus its OrderCreated / OrderPaused / OrderResumed / OrderCancelled /
 *    OrderExecuted events.
 *  - The Uniswap-V2-style pair (getReserves / token0) for the live price.
 *  - The V2 router for demo swaps (swapExactTokensForTokens / getAmountsOut).
 *
 * Contract facts that shape this file (from SentinelCallback.sol):
 *  - createOrder(pair, sellToken0, amount, coefficient, triggerPrice,
 *    kind, trailBps) is onlyOwner and does NOT escrow tokens: at execution
 *    time the contract transferFrom()s the amount from the owner. So the
 *    create flow approves the *callback contract* to spend `amount`, and the
 *    user must keep that allowance + balance until the order resolves.
 *  - Prices are scaled by `coefficient` (10000 = 4 dp):
 *    price(sell token0) = reserve1 * coefficient / reserve0.
 *  - For TrailingStop, triggerPrice is only the creation-time price record;
 *    the reactive contract computes the live stop and passes it back as
 *    effectiveTrigger. The create flow therefore passes the current price.
 * ========================================================================= */
"use strict";

const CFG = window.SENTINEL_CONFIG || {};
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const COEF = BigInt(CFG.COEFFICIENT || 10000);
const PRICE_DEC = Number(CFG.PRICE_DECIMALS || 4);

const KIND = { 0: "Stop Loss", 1: "Take Profit", 2: "Trailing Stop" };
const KIND_CLASS = { 0: "sl", 1: "tp", 2: "ts" };
const STATUS = { 0: "Active", 1: "Paused", 2: "Cancelled", 3: "Executed", 4: "Failed" };

/* ---------------- ABIs (human-readable, ethers v6) ---------------- */
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
];
const CALLBACK_ABI = [
  "function createOrder(address pair, bool sellToken0, uint256 amount, uint256 coefficient, uint256 triggerPrice, uint8 kind, uint256 trailBps) returns (uint256)",
  "function cancelOrder(uint256 orderId)",
  "function pauseOrder(uint256 orderId)",
  "function resumeOrder(uint256 orderId)",
  "function orderCount() view returns (uint256)",
  "function owner() view returns (address)",
  "function currentPrice(uint256 orderId) view returns (uint256)",
  "function getOrder(uint256 orderId) view returns (tuple(address pair, bool sellToken0, uint256 amount, uint256 coefficient, uint256 triggerPrice, uint8 kind, uint256 trailBps, uint8 status))",
  "event OrderCreated(address indexed pair, uint256 indexed orderId, bool sellToken0, uint256 amount, uint256 coefficient, uint256 triggerPrice, uint8 kind, uint256 trailBps)",
  "event OrderCancelled(uint256 indexed orderId)",
  "event OrderPaused(uint256 indexed orderId)",
  "event OrderResumed(uint256 indexed orderId)",
  "event OrderExecuted(address indexed pair, uint256 indexed orderId, uint256 amountIn, uint256 amountOut)",
];

/* ---------------- config sanity ---------------- */
function isRealAddr(a) {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO_ADDR;
}
const CONFIGURED =
  isRealAddr(CFG.CALLBACK_ADDRESS) && isRealAddr(CFG.PAIR_ADDRESS) &&
  isRealAddr(CFG.ROUTER_ADDRESS) && isRealAddr(CFG.TOKEN_A) && isRealAddr(CFG.TOKEN_B);

/* ---------------- state ---------------- */
const S = {
  readProvider: null,      // JsonRpcProvider for view calls (works pre-connect)
  browserProvider: null,   // ethers.BrowserProvider from window.ethereum
  signer: null,
  account: null,
  chainOk: false,
  contractOwner: null,
  pair: null, pairW: null,         // read / write instances
  router: null, routerW: null,
  callback: null, callbackW: null,
  tokenA: null, tokenAW: null,
  tokenB: null, tokenBW: null,
  metaA: { symbol: "sGOLD", decimals: 18 },
  metaB: { symbol: "sUSD", decimals: 18 },
  token0IsA: null,                 // whether TOKEN_A is the pair's token0
  priceScaled: null,               // BigInt price of A in B, scaled by COEF
  orders: [],                      // [{id, ...getOrder fields}]
  busy: false,
};

/* ---------------- small helpers ---------------- */
const $ = (id) => document.getElementById(id);
const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
const txLink = (hash) => `${CFG.EXPLORER_BASE_URL}/tx/${hash}`;
const addrLink = (a) => `${CFG.EXPLORER_BASE_URL}/address/${a}`;

function toast(msg, cls = "") {
  const t = document.createElement("div");
  t.className = "toast " + cls;
  t.innerHTML = msg;
  $("toasts").appendChild(t);
  setTimeout(() => t.remove(), 6000);
}
function errText(e) {
  if (!e) return "unknown error";
  return (e.shortMessage || e.reason || e.message || String(e)).slice(0, 220);
}
/** Human decimal string -> BigInt scaled by COEF (price inputs). */
function parsePrice(str) {
  return ethers.parseUnits(String(str).trim(), PRICE_DEC);
}
/** BigInt scaled price -> display string with PRICE_DEC decimals. */
function fmtPrice(scaled) {
  if (scaled === null || scaled === undefined) return "—";
  return ethers.formatUnits(scaled, PRICE_DEC);
}
function fmtAmt(raw, decimals) {
  const s = ethers.formatUnits(raw, decimals);
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : s;
}
function fmtWhen(ts) {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
async function withBusy(btn, busyLabel, fn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin">⏳</span> ${busyLabel}`;
  try { return await fn(); }
  finally { btn.disabled = false; btn.innerHTML = old; }
}

/* ---------------- provider / contract setup ---------------- */
function buildReadContracts() {
  if (!CONFIGURED) return;
  S.readProvider = new ethers.JsonRpcProvider(CFG.RPC_URL);
  S.pair = new ethers.Contract(CFG.PAIR_ADDRESS, PAIR_ABI, S.readProvider);
  S.router = new ethers.Contract(CFG.ROUTER_ADDRESS, ROUTER_ABI, S.readProvider);
  S.callback = new ethers.Contract(CFG.CALLBACK_ADDRESS, CALLBACK_ABI, S.readProvider);
  S.tokenA = new ethers.Contract(CFG.TOKEN_A, ERC20_ABI, S.readProvider);
  S.tokenB = new ethers.Contract(CFG.TOKEN_B, ERC20_ABI, S.readProvider);
}
function buildWriteContracts() {
  if (!CONFIGURED || !S.signer) return;
  S.pairW = new ethers.Contract(CFG.PAIR_ADDRESS, PAIR_ABI, S.signer);
  S.routerW = new ethers.Contract(CFG.ROUTER_ADDRESS, ROUTER_ABI, S.signer);
  S.callbackW = new ethers.Contract(CFG.CALLBACK_ADDRESS, CALLBACK_ABI, S.signer);
  S.tokenAW = new ethers.Contract(CFG.TOKEN_A, ERC20_ABI, S.signer);
  S.tokenBW = new ethers.Contract(CFG.TOKEN_B, ERC20_ABI, S.signer);
}

/* ---------------- wallet ---------------- */
async function connectWallet() {
  if (!window.ethereum) {
    toast("No wallet found. Install MetaMask or another EIP-1193 wallet.", "err");
    return;
  }
  try {
    S.browserProvider = new ethers.BrowserProvider(window.ethereum);
    await S.browserProvider.send("eth_requestAccounts", []);
    S.signer = await S.browserProvider.getSigner();
    S.account = await S.signer.getAddress();
    buildWriteContracts();
    await refreshChainState();
    await afterConnect();
  } catch (e) {
    toast("Connection failed: " + errText(e), "err");
  }
}

async function refreshChainState() {
  if (!S.browserProvider) return;
  const net = await S.browserProvider.getNetwork();
  S.chainOk = Number(net.chainId) === Number(CFG.CHAIN_ID);
  const badge = $("netBadge"), txt = $("netText");
  badge.classList.remove("ok", "bad");
  if (S.account) {
    badge.classList.add(S.chainOk ? "ok" : "bad");
    txt.textContent = S.chainOk
      ? `${CFG.CHAIN_NAME} · ${shortAddr(S.account)}`
      : `Wrong network (chain ${net.chainId}) · ${shortAddr(S.account)}`;
    $("connectBtn").textContent = shortAddr(S.account);
  }
  $("wrongNetBanner").classList.toggle("show", !!S.account && !S.chainOk);
  updateOwnerBanner();
  updateActionStates();
}

async function switchNetwork() {
  if (!window.ethereum) return;
  const hex = "0x" + Number(CFG.CHAIN_ID).toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e && e.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex, chainName: CFG.CHAIN_NAME,
          rpcUrls: [CFG.RPC_URL],
          blockExplorerUrls: [CFG.EXPLORER_BASE_URL],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        }],
      });
    } else { toast("Network switch failed: " + errText(e), "err"); }
  }
}

function updateOwnerBanner() {
  const b = $("notOwnerBanner");
  if (CONFIGURED && S.account && S.contractOwner &&
      S.account.toLowerCase() !== S.contractOwner.toLowerCase()) {
    b.innerHTML = `👀 <b>Read-only view.</b> This Sentinel contract belongs to
      <a href="${addrLink(S.contractOwner)}" target="_blank" rel="noopener">${shortAddr(S.contractOwner)}</a>.
      Connect that wallet to create or manage orders.`;
    b.classList.add("show");
  } else {
    b.classList.remove("show");
  }
}
function isOwner() {
  return !!(S.account && S.contractOwner &&
    S.account.toLowerCase() === S.contractOwner.toLowerCase());
}

/* ---------------- live price ---------------- */
async function loadPairInfo() {
  if (!CONFIGURED) return;
  try {
    const [t0, symA, decA, symB, decB, owner] = await Promise.all([
      S.pair.token0(),
      S.tokenA.symbol().catch(() => "sGOLD"), S.tokenA.decimals().catch(() => 18),
      S.tokenB.symbol().catch(() => "sUSD"), S.tokenB.decimals().catch(() => 18),
      S.callback.owner().catch(() => null),
    ]);
    S.token0IsA = t0.toLowerCase() === CFG.TOKEN_A.toLowerCase();
    S.metaA = { symbol: symA, decimals: Number(decA) };
    S.metaB = { symbol: symB, decimals: Number(decB) };
    S.contractOwner = owner;
    document.querySelectorAll(".symA").forEach((el) => (el.textContent = symA));
    document.querySelectorAll(".symB").forEach((el) => (el.textContent = symB));
    $("priceUnit").textContent = `${symB} / ${symA}`;
    $("pairAddr").innerHTML =
      `<a href="${addrLink(CFG.PAIR_ADDRESS)}" target="_blank" rel="noopener">${shortAddr(CFG.PAIR_ADDRESS)}</a>`;
    $("cbAddr").innerHTML =
      `<a href="${addrLink(CFG.CALLBACK_ADDRESS)}" target="_blank" rel="noopener">${shortAddr(CFG.CALLBACK_ADDRESS)}</a>`;
    if (isRealAddr(CFG.REACTIVE_ADDRESS)) {
      $("reactiveAddr").innerHTML =
        `<a href="${CFG.REACTIVE_EXPLORER_URL}/address/${CFG.REACTIVE_ADDRESS}" target="_blank" rel="noopener">${shortAddr(CFG.REACTIVE_ADDRESS)}</a>`;
    }
    updateOwnerBanner();
  } catch (e) {
    console.warn("pair info failed", e);
  }
}

/** price of TOKEN_A in TOKEN_B, scaled by COEF, from raw reserves. */
function priceFromReserves(r0, r1) {
  const reserveA = S.token0IsA ? r0 : r1;
  const reserveB = S.token0IsA ? r1 : r0;
  if (reserveA === 0n) return null;
  return (reserveB * COEF) / reserveA;
}

async function refreshPrice() {
  if (!CONFIGURED) return;
  try {
    const [r0, r1] = await S.pair.getReserves();
    S.priceScaled = priceFromReserves(r0, r1);
    $("priceValue").textContent = S.priceScaled === null ? "—" : fmtPrice(S.priceScaled);
    const reserveA = S.token0IsA ? r0 : r1;
    const reserveB = S.token0IsA ? r1 : r0;
    $("reservesText").textContent =
      `${fmtAmt(reserveA, S.metaA.decimals)} ${S.metaA.symbol} · ${fmtAmt(reserveB, S.metaB.decimals)} ${S.metaB.symbol}`;
    $("priceUpdated").textContent = new Date().toLocaleTimeString();
    updateTriggerHint();
    if (S.account) {
      const bal = await S.tokenA.balanceOf(S.account);
      $("balanceText").textContent = `${fmtAmt(bal, S.metaA.decimals)} ${S.metaA.symbol}`;
    }
  } catch (e) {
    console.warn("price refresh failed", e);
  }
}

/* ---------------- orders ---------------- */
async function loadOrders() {
  if (!CONFIGURED || !S.callback) return;
  try {
    const count = Number(await S.callback.orderCount());
    const list = [];
    for (let i = 0; i < count; i++) {
      const o = await S.callback.getOrder(i);
      list.push({
        id: i,
        pair: o.pair ?? o[0],
        sellToken0: o.sellToken0 ?? o[1],
        amount: o.amount ?? o[2],
        coefficient: o.coefficient ?? o[3],
        triggerPrice: o.triggerPrice ?? o[4],
        kind: Number(o.kind ?? o[5]),
        trailBps: o.trailBps ?? o[6],
        status: Number(o.status ?? o[7]),
      });
    }
    S.orders = list;
    renderOrders();
  } catch (e) {
    console.warn("loadOrders failed", e);
  }
}

function distanceText(o) {
  if (S.priceScaled === null || o.status > 1) return "";
  const price = Number(S.priceScaled), trig = Number(o.triggerPrice);
  if (!trig) return "";
  const pct = ((price - trig) / trig) * 100;
  if (o.kind === 0) return pct <= 0 ? "⚠️ in trigger zone" : `${pct.toFixed(2)}% above trigger`;
  if (o.kind === 1) return pct >= 0 ? "⚠️ in trigger zone" : `${Math.abs(pct).toFixed(2)}% below trigger`;
  return "ratchets with the peak";
}

function renderOrders() {
  const grid = $("ordersGrid");
  $("ordersCount").textContent = String(S.orders.length);
  if (!S.account) {
    grid.innerHTML = `<div class="empty">Connect your wallet to load your orders.</div>`;
    return;
  }
  if (!S.orders.length) {
    grid.innerHTML = `<div class="empty">No orders yet. Create your first protection order above. 🛡️</div>`;
    return;
  }
  const mine = isOwner();
  grid.innerHTML = "";
  for (const o of [...S.orders].reverse()) {
    const sellSym = o.sellToken0 === S.token0IsA ? S.metaA.symbol : S.metaB.symbol;
    const sellDec = o.sellToken0 === S.token0IsA ? S.metaA.decimals : S.metaB.decimals;
    const card = document.createElement("div");
    card.className = "order";
    const dist = distanceText(o);
    card.innerHTML = `
      <div class="head">
        <span class="oid">#${o.id}</span>
        <span class="badge ${KIND_CLASS[o.kind]}">${KIND[o.kind]}</span>
        <span class="badge st-${STATUS[o.status]}" style="margin-left:auto">${STATUS[o.status]}</span>
      </div>
      <dl>
        <dt>Sells</dt><dd>${fmtAmt(o.amount, sellDec)} ${sellSym}</dd>
        ${o.kind === 2
          ? `<dt>Trail</dt><dd>${(Number(o.trailBps) / 100).toFixed(2)}% below peak</dd>
             <dt>Price at creation</dt><dd>${fmtPrice(o.triggerPrice)} ${S.metaB.symbol}</dd>`
          : `<dt>Trigger</dt><dd>${fmtPrice(o.triggerPrice)} ${S.metaB.symbol}</dd>`}
        ${dist ? `<dt>Distance</dt><dd>${dist}</dd>` : ""}
      </dl>
      <div class="actions"></div>`;
    const actions = card.querySelector(".actions");
    if (o.status === 0 || o.status === 1) {
      if (o.status === 0) actions.appendChild(actionBtn("⏸ Pause", () => orderAction("pause", o.id)));
      if (o.status === 1) actions.appendChild(actionBtn("▶ Resume", () => orderAction("resume", o.id)));
      const cancel = actionBtn("✖ Cancel", () => orderAction("cancel", o.id));
      cancel.classList.add("danger");
      actions.appendChild(cancel);
      if (!mine || !S.chainOk) actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
    } else {
      actions.innerHTML = `<span class="hint" style="margin:0">Final — no actions available.</span>`;
    }
    grid.appendChild(card);
  }
}
function actionBtn(label, fn) {
  const b = document.createElement("button");
  b.className = "small";
  b.textContent = label;
  b.addEventListener("click", () => withBusy(b, "Working…", fn));
  return b;
}

async function orderAction(which, id) {
  if (!CONFIGURED) return;
  try {
    const fn = { pause: "pauseOrder", resume: "resumeOrder", cancel: "cancelOrder" }[which];
    const tx = await S.callbackW[fn](id);
    toast(`Transaction sent — <a href="${txLink(tx.hash)}" target="_blank" rel="noopener">view</a>`);
    await tx.wait();
    toast(`Order #${id}: ${which} confirmed ✅`, "ok");
    await loadOrders();
    await loadActivity();
  } catch (e) {
    toast(`Failed to ${which} order #${id}: ` + errText(e), "err");
  }
}

/* ---------------- activity feed ---------------- */
async function loadActivity() {
  if (!CONFIGURED || !S.callback) return;
  const feed = $("activityFeed");
  try {
    const from = Number(CFG.FROM_BLOCK || 0);
    const [created, executed, paused, resumed, cancelled] = await Promise.all([
      S.callback.queryFilter(S.callback.filters.OrderCreated(), from),
      S.callback.queryFilter(S.callback.filters.OrderExecuted(), from),
      S.callback.queryFilter(S.callback.filters.OrderPaused(), from),
      S.callback.queryFilter(S.callback.filters.OrderResumed(), from),
      S.callback.queryFilter(S.callback.filters.OrderCancelled(), from),
    ]);
    const items = [];
    const push = (ev, icon, html) => items.push({ block: ev.blockNumber, tx: ev.transactionHash, icon, html });
    for (const ev of created) {
      const a = ev.args;
      push(ev, "🛡️", `<b>Order #${a.orderId}</b> created — ${KIND[Number(a.kind)]} for
        ${fmtAmt(a.amount, a.sellToken0 === S.token0IsA ? S.metaA.decimals : S.metaB.decimals)}
        at trigger ${fmtPrice(a.triggerPrice)}`);
    }
    for (const ev of executed) {
      const a = ev.args;
      const ord = S.orders.find((o) => o.id === Number(a.orderId));
      const soldB = !!(ord && ord.sellToken0 !== S.token0IsA);
      const inDec = soldB ? S.metaB.decimals : S.metaA.decimals;
      const inSym = soldB ? S.metaB.symbol : S.metaA.symbol;
      const outDec = soldB ? S.metaA.decimals : S.metaB.decimals;
      const outSym = soldB ? S.metaA.symbol : S.metaB.symbol;
      push(ev, "⚡", `<b>Order #${a.orderId} EXECUTED</b> — sold
        ${fmtAmt(a.amountIn, inDec)} ${inSym}, received <b>${fmtAmt(a.amountOut, outDec)} ${outSym}</b>`);
    }
    for (const ev of paused) push(ev, "⏸️", `<b>Order #${ev.args.orderId}</b> paused`);
    for (const ev of resumed) push(ev, "▶️", `<b>Order #${ev.args.orderId}</b> resumed`);
    for (const ev of cancelled) push(ev, "✖️", `<b>Order #${ev.args.orderId}</b> cancelled`);
    items.sort((x, y) => y.block - x.block);
    if (!items.length) { feed.innerHTML = `<div class="empty">Nothing yet.</div>`; return; }
    // resolve timestamps for the newest few blocks only (keeps RPC calls low)
    const shown = items.slice(0, 30);
    const blockTimes = {};
    for (const it of shown) {
      if (blockTimes[it.block] === undefined) {
        const blk = await S.readProvider.getBlock(it.block).catch(() => null);
        blockTimes[it.block] = blk ? blk.timestamp : null;
      }
    }
    feed.innerHTML = "";
    for (const it of shown) {
      const div = document.createElement("div");
      div.className = "feed-item";
      div.innerHTML = `<div class="ic">${it.icon}</div>
        <div class="body">${it.html}<br>
          <a href="${txLink(it.tx)}" target="_blank" rel="noopener">transaction ↗</a></div>
        <div class="when">${blockTimes[it.block] ? fmtWhen(blockTimes[it.block]) : "block " + it.block}</div>`;
      feed.appendChild(div);
    }
  } catch (e) {
    console.warn("loadActivity failed", e);
    feed.innerHTML = `<div class="empty">Could not load activity (RPC history scan failed).</div>`;
  }
}

/* ---------------- create order ---------------- */
function sellToken0ForA() {
  // This UI always protects TOKEN_A (sells A for B). On-chain the order is
  // expressed as sellToken0, which depends on the pair's token ordering.
  return S.token0IsA === true;
}

async function ensureAllowance(tokenW, owner, spender, amount, btn, label) {
  const current = await tokenW.allowance(owner, spender);
  if (current >= amount) return;
  toast(`Approval needed: Sentinel must be allowed to spend ${label}. Confirm in your wallet…`);
  const tx = await tokenW.approve(spender, amount);
  await tx.wait();
  toast("Approval confirmed ✅", "ok");
}

async function onCreateOrder(ev) {
  ev.preventDefault();
  const btn = $("createBtn");
  if (!CONFIGURED) { toast("Contracts are not deployed yet — see config.js.", "err"); return; }
  if (!S.account) { toast("Connect your wallet first.", "err"); return; }
  if (!S.chainOk) { toast("Switch to " + CFG.CHAIN_NAME + " first.", "err"); return; }
  if (!isOwner()) { toast("This Sentinel contract belongs to a different wallet.", "err"); return; }
  if (S.token0IsA === null) { toast("Pair info still loading — try again in a moment.", "err"); return; }

  const kind = Number($("kindSel").value);
  const amountStr = $("amountIn").value.trim();
  if (!amountStr || Number(amountStr) <= 0) { toast("Enter an amount to protect.", "err"); return; }
  let amount;
  try { amount = ethers.parseUnits(amountStr, S.metaA.decimals); }
  catch { toast("Amount is not a valid number.", "err"); return; }

  let triggerPrice, trailBps = 0n;
  if (kind === 2) {
    // TrailingStop: triggerPrice is only the creation-time price record
    // (the reactive contract computes the live stop). Pass the live price.
    if (S.priceScaled === null) { toast("Live price unavailable — cannot create a trailing stop yet.", "err"); return; }
    triggerPrice = S.priceScaled;
    const pctStr = $("trailIn").value.trim();
    const pct = Number(pctStr);
    if (!pctStr || !Number.isFinite(pct) || pct <= 0 || pct > 50) {
      toast("Trailing distance must be between 0 and 50%.", "err"); return;
    }
    trailBps = BigInt(Math.round(pct * 100));
    if (trailBps <= 0n || trailBps > 5000n) { toast("Trailing distance out of range.", "err"); return; }
  } else {
    const trigStr = $("triggerIn").value.trim();
    if (!trigStr || Number(trigStr) <= 0) { toast("Enter a trigger price.", "err"); return; }
    try { triggerPrice = parsePrice(trigStr); }
    catch { toast("Trigger price is not a valid number.", "err"); return; }
    if (S.priceScaled !== null) {
      if (kind === 0 && triggerPrice >= S.priceScaled)
        toast("Heads-up: this stop-loss trigger is at/above the current price — it can fire immediately.", "err");
      if (kind === 1 && triggerPrice <= S.priceScaled)
        toast("Heads-up: this take-profit trigger is at/below the current price — it can fire immediately.", "err");
    }
  }

  await withBusy(btn, "Creating order…", async () => {
    try {
      const bal = await S.tokenA.balanceOf(S.account);
      if (bal < amount) {
        toast(`Insufficient ${S.metaA.symbol} balance: you have ${fmtAmt(bal, S.metaA.decimals)}.`, "err");
        return;
      }
      // The callback contract pulls the tokens from the owner when the
      // trigger fires (transferFrom in executeOrder) — approve IT, not the router.
      await ensureAllowance(S.tokenAW, S.account, CFG.CALLBACK_ADDRESS, amount, btn,
        `${amountStr} ${S.metaA.symbol}`);
      const tx = await S.callbackW.createOrder(
        CFG.PAIR_ADDRESS, sellToken0ForA(), amount, COEF, triggerPrice, kind, trailBps
      );
      toast(`Order transaction sent — <a href="${txLink(tx.hash)}" target="_blank" rel="noopener">view</a>`);
      const receipt = await tx.wait();
      // The new order id is the pre-push length; read it from the event if present.
      let newId = null;
      for (const log of receipt.logs) {
        try {
          const parsed = S.callback.interface.parseLog(log);
          if (parsed && parsed.name === "OrderCreated") { newId = Number(parsed.args.orderId); break; }
        } catch { /* not our event */ }
      }
      toast(`Order${newId !== null ? " #" + newId : ""} created ✅ Sentinel is watching.`, "ok");
      $("amountIn").value = ""; $("triggerIn").value = ""; $("trailIn").value = "";
      await loadOrders();
      await loadActivity();
    } catch (e) {
      toast("Create order failed: " + errText(e), "err");
    }
  });
}

/* ---------------- demo swap ---------------- */
async function demoSwap(sellA) {
  const btn = sellA ? $("demoSellBtn") : $("demoBuyBtn");
  if (!CONFIGURED) { toast("Contracts are not deployed yet — see config.js.", "err"); return; }
  if (!S.account) { toast("Connect your wallet first.", "err"); return; }
  if (!S.chainOk) { toast("Switch to " + CFG.CHAIN_NAME + " first.", "err"); return; }
  const amtStr = $("demoAmount").value.trim();
  if (!amtStr || Number(amtStr) <= 0) { toast("Enter a demo swap amount.", "err"); return; }

  const inMeta = sellA ? S.metaA : S.metaB;
  const outMeta = sellA ? S.metaB : S.metaA;
  const inTokenW = sellA ? S.tokenAW : S.tokenBW;
  const path = sellA ? [CFG.TOKEN_A, CFG.TOKEN_B] : [CFG.TOKEN_B, CFG.TOKEN_A];
  let amountIn;
  try { amountIn = ethers.parseUnits(amtStr, inMeta.decimals); }
  catch { toast("Demo amount is not a valid number.", "err"); return; }

  await withBusy(btn, "Swapping…", async () => {
    try {
      const bal = await inTokenW.balanceOf(S.account);
      if (bal < amountIn) {
        toast(`Insufficient ${inMeta.symbol} balance: you have ${fmtAmt(bal, inMeta.decimals)}.`, "err");
        return;
      }
      let expected = null;
      try {
        const outs = await S.router.getAmountsOut(amountIn, path);
        expected = outs[outs.length - 1];
      } catch { /* quote is best-effort */ }
      if (expected !== null &&
          !window.confirm(`Swap ${amtStr} ${inMeta.symbol} → ≈ ${fmtAmt(expected, outMeta.decimals)} ${outMeta.symbol}?\n\nThis moves the testnet price. Minimum output is 0 (demo only).`)) {
        return;
      }
      await ensureAllowance(inTokenW, S.account, CFG.ROUTER_ADDRESS, amountIn, btn,
        `${amtStr} ${inMeta.symbol} for the router`);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const tx = await S.routerW.swapExactTokensForTokens(amountIn, 0, path, S.account, deadline);
      toast(`Demo swap sent — <a href="${txLink(tx.hash)}" target="_blank" rel="noopener">view</a>`);
      await tx.wait();
      toast("Demo swap confirmed ✅ Watch your order — Sentinel should react on its own.", "ok");
      await refreshPrice();
      setTimeout(() => { loadOrders(); loadActivity(); }, 4000);
    } catch (e) {
      toast("Demo swap failed: " + errText(e), "err");
    }
  });
}

/* ---------------- UI state / hints ---------------- */
function updateTriggerHint() {
  const kind = Number($("kindSel").value);
  $("trailField").style.display = kind === 2 ? "" : "none";
  $("triggerField").style.display = kind === 2 ? "none" : "";
  if (S.priceScaled !== null && kind !== 2) {
    const cur = fmtPrice(S.priceScaled);
    $("triggerHint").textContent = kind === 0
      ? `Current price is ${cur}. A stop-loss is usually set below it.`
      : `Current price is ${cur}. A take-profit is usually set above it.`;
  } else {
    $("triggerHint").textContent = "";
  }
}

function updateActionStates() {
  const ready = CONFIGURED && !!S.account && S.chainOk && isOwner();
  $("createBtn").disabled = !ready;
  const demoReady = CONFIGURED && !!S.account && S.chainOk;
  $("demoSellBtn").disabled = !demoReady;
  $("demoBuyBtn").disabled = !demoReady;
}

async function afterConnect() {
  await loadPairInfo();
  await refreshChainState();
  await refreshPrice();
  await loadOrders();
  await loadActivity();
}

/* ---------------- init ---------------- */
function init() {
  $("wantNetName").textContent = CFG.CHAIN_NAME || "Base Sepolia";
  $("footDest").textContent = CFG.CHAIN_NAME || "Base Sepolia";
  const fr = $("footReactive");
  fr.href = CFG.REACTIVE_EXPLORER_URL || "#";
  fr.textContent = `${CFG.REACTIVE_CHAIN_NAME || "Reactive Lasna"} explorer`;

  if (!CONFIGURED) {
    $("notDeployedBanner").classList.add("show");
  } else if (!isRealAddr(CFG.REACTIVE_ADDRESS)) {
    const wb = $("watcherBanner");
    wb.innerHTML = `ℹ️ The destination contracts are configured, but the Reactive watcher
      address (<code>REACTIVE_ADDRESS</code>) is still a placeholder — order watching status
      can't be displayed until SentinelReactive is deployed and set in <code>config.js</code>.`;
    wb.classList.add("show");
  }
  updateActionStates();

  if (CONFIGURED) {
    buildReadContracts();
    loadPairInfo().then(refreshPrice);
    setInterval(refreshPrice, Number(CFG.PRICE_REFRESH_MS || 6000));
    // Refresh on new blocks too, when a wallet provider is available.
    if (window.ethereum) {
      const bp = new ethers.BrowserProvider(window.ethereum);
      bp.on("block", () => { refreshPrice(); });
    }
  }

  $("connectBtn").addEventListener("click", connectWallet);
  $("switchNetBtn").addEventListener("click", switchNetwork);
  $("refreshPriceBtn").addEventListener("click", refreshPrice);
  $("createForm").addEventListener("submit", onCreateOrder);
  $("kindSel").addEventListener("change", updateTriggerHint);
  $("demoSellBtn").addEventListener("click", () => demoSwap(true));
  $("demoBuyBtn").addEventListener("click", () => demoSwap(false));

  if (window.ethereum) {
    window.ethereum.on("accountsChanged", () => window.location.reload());
    window.ethereum.on("chainChanged", () => window.location.reload());
    // Silent reconnect if the wallet is already authorized.
    new ethers.BrowserProvider(window.ethereum).send("eth_accounts", []).then(async (accs) => {
      if (accs && accs.length) {
        S.browserProvider = new ethers.BrowserProvider(window.ethereum);
        S.signer = await S.browserProvider.getSigner();
        S.account = await S.signer.getAddress();
        buildWriteContracts();
        await refreshChainState();
        await afterConnect();
      }
    }).catch(() => {});
  }
  updateTriggerHint();
}

document.addEventListener("DOMContentLoaded", init);
