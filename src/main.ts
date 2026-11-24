import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hash,
  type Transport,
  type WalletClient,
} from "viem";
import {
  AmmoraSwapClient,
  ammoraLaunchFactoryV4Abi,
  ammoraLaunchPoolV4Abi,
  buildAmmoraPortableUnwrapTransaction,
  buildAmmoraPortableWrapTransaction,
  giwaSepoliaAutoRouteDeployment as DEPLOYMENT,
  giwaSepoliaAutoRoutePoolProfiles,
  type SafeSwapStatus,
} from "@ammora-protocol/sdk";

/* ---------- chain & SDK deployment ---------- */

const RPC = "https://sepolia-rpc.giwa.io";
const EXPLORER = "https://sepolia-explorer.giwa.io";
const CHAIN_ID = 91342;
const FACTORY = getAddress(DEPLOYMENT.contracts.launch.factory);
const WETH = getAddress(DEPLOYMENT.contracts.tokens.wrappedNative);
const SLIPPAGE_BPS = 100;
const QUOTE_PAYER = "0x0000000000000000000000000000000000000001" as Address;
/** Minimum ETH left after wrapping, so the user can still pay gas. */
const GAS_RESERVE = parseUnits("0.0003", 18);

const chain = defineChain({
  id: CHAIN_ID,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: EXPLORER } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

const wrapModel = {
  kind: "WRAPPED_ERC20",
  nativeDecimals: 18,
  wrappedToken: WETH,
  wrappedTokenDecimals: 18,
  nativeRouter: getAddress(DEPLOYMENT.contracts.routers.native),
} as const;

/** The public GIWA RPC rate-limits bursts (HTTP 429). Serialize calls and back off on 429. */
function pacedHttp(url: string, intervalMs = 120): Transport {
  let tail: Promise<unknown> = Promise.resolve();
  let nextStart = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const isRateLimit = (e: unknown) => {
    const err = e as { status?: number; message?: string; details?: string; cause?: { status?: number } };
    if (err?.status === 429 || err?.cause?.status === 429) return true;
    return /over rate limit|too many requests/i.test(`${err?.details ?? ""} ${err?.message ?? ""}`);
  };
  return (params) => {
    const base = http(url, { retryCount: 0 })(params);
    return custom(
      {
        request: (args) => {
          const run = tail.then(async () => {
            for (let attempt = 0; ; attempt++) {
              await sleep(Math.max(0, nextStart - Date.now()));
              try {
                const out = await base.request(args);
                nextStart = Date.now() + intervalMs;
                return out;
              } catch (e) {
                if (isRateLimit(e) && attempt < 6) {
                  nextStart = Date.now() + 700 * (attempt + 1);
                  continue;
                }
                nextStart = Date.now() + intervalMs;
                throw e;
              }
            }
          });
          tail = run.catch(() => undefined);
          return run;
        },
      },
      { retryCount: 0 },
    )(params);
  };
}

const publicClient = createPublicClient({
  chain,
  transport: pacedHttp(RPC),
  batch: { multicall: { wait: 20 } },
});

let swapClientPromise: Promise<AmmoraSwapClient> | null = null;
const swapClient = () =>
  (swapClientPromise ??= AmmoraSwapClient.create(publicClient as never, {
    deploymentCatalog: { [CHAIN_ID]: DEPLOYMENT },
    factoryProfiles: giwaSepoliaAutoRoutePoolProfiles,
  }));

/* ---------- state ---------- */

type Launch = {
  token: Address;
  curve: Address;
  creator: Address;
  block: number;
  name: string;
  symbol: string;
  image: string | null;
  launchpad: string | null;
  status: number | null;
  quoteReserve: bigint | null;
  threshold: bigint | null;
};

type Selected = Launch & { decimals: number; quoteToken: Address };

/** Everything a quote or swap depends on, frozen at the moment it starts. */
type Trade = {
  curve: Address;
  token: Address;
  quoteToken: Address;
  symbol: string;
  decimals: number;
  side: "buy" | "sell";
  amountIn: bigint;
};

const state = {
  launches: [] as Launch[],
  nextPage: null as Record<string, string | number> | null,
  selected: null as Selected | null,
  side: "buy" as "buy" | "sell",
  provider: null as EIP1193Provider | null,
  listenersBound: false,
  account: null as Address | null,
  wallet: null as WalletClient | null,
  balances: { eth: null as bigint | null, weth: null as bigint | null, token: null as bigint | null },
  quoteSeq: 0,
  selectSeq: 0,
  busy: false,
};

/* ---------- DOM helpers ---------- */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, cls?: string, text?: string) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

function fmt(value: bigint | null, decimals = 18, digits = 6): string {
  if (value === null) return "–";
  const s = formatUnits(value, decimals);
  const [i, f = ""] = s.split(".");
  const trimmed = f.slice(0, digits).replace(/0+$/, "");
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return trimmed ? `${int}.${trimmed}` : int;
}

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function log(message: string, kind: "info" | "ok" | "err" = "info", hash?: Hash) {
  const li = el("li", kind === "info" ? "" : kind);
  li.append(document.createTextNode(message));
  if (hash) {
    li.append(" ");
    const a = el("a", "mono", short(hash)) as HTMLAnchorElement;
    a.href = `${EXPLORER}/tx/${hash}`;
    a.target = "_blank";
    a.rel = "noopener";
    li.append(a);
  }
  $("log").prepend(li);
}

function errText(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; code?: number };
  if (err?.code === 4001) return "Request rejected in wallet.";
  const text = (err?.shortMessage ?? err?.message ?? String(e)).split("\n")[0];
  if (/requires partial fill/i.test(text)) return "Amount is larger than this curve can fill right now. Try a smaller amount.";
  return text.slice(0, 220);
}

function avatar(l: { image: string | null; symbol: string }, size?: number) {
  if (l.image) {
    const img = el("img", "avatar") as HTMLImageElement;
    img.alt = "";
    img.loading = "lazy";
    img.src = l.image;
    if (size) img.style.width = img.style.height = `${size}px`;
    return img;
  }
  return el("div", "avatar", l.symbol.slice(0, 3).toUpperCase());
}

/* ---------- launch discovery (explorer logs → SDK ABI decode → curve state via multicall) ---------- */

function parseMetadata(uri: string): { name?: string; symbol?: string; image?: string; launchpad?: string } | null {
  try {
    if (uri.startsWith("data:application/json;base64,")) return JSON.parse(atob(uri.slice(29)));
    if (uri.startsWith("data:application/json,")) {
      const raw = uri.slice(22);
      try {
        return JSON.parse(decodeURIComponent(raw));
      } catch {
        return JSON.parse(raw);
      }
    }
  } catch {
    /* unreadable metadata is shown as plain symbol */
  }
  return null;
}

/** Only inline raster images: no remote hosts (keeps visitors' IPs private), no SVG. */
function safeImage(src: unknown): string | null {
  if (typeof src !== "string") return null;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(src) && src.length < 400_000) return src;
  return null;
}

async function fetchLaunchPage(params: Record<string, string | number> | null) {
  const qs = params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}` : "";
  const res = await fetch(`${EXPLORER}/api/v2/addresses/${FACTORY}/logs${qs}`);
  if (!res.ok) throw new Error(`Explorer API ${res.status}`);
  const page = (await res.json()) as {
    items: { data: `0x${string}`; topics: (`0x${string}` | null)[]; block_number: number }[];
    next_page_params: Record<string, string | number> | null;
  };
  const found: Launch[] = [];
  for (const item of page.items) {
    try {
      const ev = decodeEventLog({
        abi: ammoraLaunchFactoryV4Abi,
        data: item.data,
        topics: item.topics.filter(Boolean) as [`0x${string}`, ...`0x${string}`[]],
      });
      if (ev.eventName !== "LaunchCreated") continue;
      const args = ev.args as { token: Address; curve: Address; creator: Address; metadataURI: string };
      const meta = parseMetadata(args.metadataURI);
      found.push({
        token: getAddress(args.token),
        curve: getAddress(args.curve),
        creator: getAddress(args.creator),
        block: item.block_number,
        name: String(meta?.name ?? "").slice(0, 40),
        symbol: String(meta?.symbol ?? "").slice(0, 16),
        image: safeImage(meta?.image),
        launchpad: meta?.launchpad ? String(meta.launchpad).slice(0, 24) : null,
        status: null,
        quoteReserve: null,
        threshold: null,
      });
    } catch {
      /* other factory events */
    }
  }
  await enrich(found);
  return { found, next: page.next_page_params };
}

async function enrich(list: Launch[]) {
  if (!list.length) return;
  const reads = list.flatMap((l) => [
    { address: l.curve, abi: ammoraLaunchPoolV4Abi, functionName: "status" },
    { address: l.curve, abi: ammoraLaunchPoolV4Abi, functionName: "quoteReserve" },
    { address: l.curve, abi: ammoraLaunchPoolV4Abi, functionName: "migrationQuoteThreshold" },
    { address: l.token, abi: erc20Abi, functionName: "symbol" },
  ]);
  const out = (await publicClient.multicall({ contracts: reads as never, allowFailure: true })) as unknown as {
    status: string;
    result?: unknown;
  }[];
  list.forEach((l, i) => {
    const [s, r, t, sym] = out.slice(i * 4, i * 4 + 4) as { status: string; result?: unknown }[];
    l.status = s.status === "success" ? Number(s.result) : null;
    l.quoteReserve = r.status === "success" ? (r.result as bigint) : null;
    l.threshold = t.status === "success" ? (t.result as bigint) : null;
    if (sym.status === "success") l.symbol = String(sym.result).slice(0, 16);
    if (!l.name) l.name = l.symbol;
  });
}

function statusLabel(s: number | null) {
  return s === 1 ? "Trading" : s === 2 ? "Graduating" : s === 3 ? "Graduated" : "Inactive";
}

function renderLaunches() {
  const box = $("launches");
  box.replaceChildren();
  const onlyActive = ($("onlyActive") as HTMLInputElement).checked;
  const rows = state.launches.filter((l) => !onlyActive || l.status === 1);
  if (!rows.length) {
    box.append(el("div", "empty", state.launches.length ? "No trading curves on this page. Load more below." : "No launches found."));
  }
  for (const l of rows) {
    const btn = el("button", "launch") as HTMLButtonElement;
    btn.disabled = state.busy;
    if (state.selected?.curve === l.curve) btn.classList.add("selected");
    const mid = el("div");
    const title = el("div");
    title.append(el("span", "sym", l.symbol || "?"), document.createTextNode(" "), el("span", "sub", l.name !== l.symbol ? l.name : ""));
    const pct = l.quoteReserve !== null && l.threshold ? Number((l.quoteReserve * 10000n) / l.threshold) / 100 : 0;
    const sub = el("div", "sub", `${fmt(l.quoteReserve, 18, 4)} / ${fmt(l.threshold, 18, 4)} WETH · ${short(l.token)}${l.launchpad ? ` · via ${l.launchpad}` : ""}`);
    const bar = el("div", "bar");
    const fill = el("i");
    fill.style.width = `${Math.min(100, pct)}%`;
    bar.append(fill);
    mid.append(title, sub, bar);
    const badge = el("span", `badge${l.status === 1 ? " live" : ""}`, statusLabel(l.status));
    btn.append(avatar(l), mid, badge);
    btn.addEventListener("click", () => void selectLaunch(l));
    box.append(btn);
  }
  $("more").hidden = !state.nextPage;
}

async function loadLaunches(more = false) {
  try {
    $("more").setAttribute("disabled", "");
    const { found, next } = await fetchLaunchPage(more ? state.nextPage : null);
    state.launches = more ? [...state.launches, ...found] : found;
    state.nextPage = next;
    renderLaunches();
    if (!state.selected) {
      const first = state.launches.find((l) => l.status === 1);
      if (first) void selectLaunch(first);
    }
  } catch (e) {
    $("launches").replaceChildren(el("div", "empty", `Could not load launches: ${errText(e)}`));
  } finally {
    $("more").removeAttribute("disabled");
  }
}

/* ---------- selection, balances, quotes ---------- */

const supported = (s: Selected | null) => !!s && s.quoteToken === WETH;

async function selectLaunch(l: Launch) {
  if (state.busy) return;
  const seq = ++state.selectSeq;
  state.balances.token = null;
  try {
    const [decimals, quoteToken] = await Promise.all([
      publicClient.readContract({ address: l.token, abi: erc20Abi, functionName: "decimals" }),
      publicClient.readContract({ address: l.curve, abi: ammoraLaunchPoolV4Abi, functionName: "quoteToken" }) as Promise<Address>,
    ]);
    if (seq !== state.selectSeq) return;
    state.selected = { ...l, decimals: Number(decimals), quoteToken: getAddress(quoteToken) };
  } catch (e) {
    if (seq === state.selectSeq) log(`Could not load ${l.symbol}: ${errText(e)}`, "err");
    return;
  }
  renderLaunches();
  renderTokenHead(l);
  syncLabels();
  scheduleQuote();
  await refreshBalances();
}

function renderTokenHead(l: Launch) {
  const head = $("tokenHead");
  head.replaceChildren();
  const info = el("div");
  info.append(el("div", "t-name", `${l.symbol} ${l.name && l.name !== l.symbol ? `· ${l.name}` : ""}`));
  const sub = el("div", "t-sub");
  const a = el("a", "mono", `token ${short(l.token)}`) as HTMLAnchorElement;
  a.href = `${EXPLORER}/token/${l.token}`;
  a.target = "_blank";
  a.rel = "noopener";
  const c = el("a", "mono", `curve ${short(l.curve)}`) as HTMLAnchorElement;
  c.href = `${EXPLORER}/address/${l.curve}`;
  c.target = "_blank";
  c.rel = "noopener";
  sub.append(a, document.createTextNode(" · "), c, document.createTextNode(` · ${statusLabel(l.status)}`));
  info.append(sub);
  head.append(avatar(l, 48), info);
}

function syncLabels() {
  const s = state.selected;
  const sym = s?.symbol ?? "token";
  $("payLabel").textContent = state.side === "buy" ? "You pay (WETH)" : `You pay (${sym})`;
  const bal = state.side === "buy" ? fmt(state.balances.weth) : fmt(state.balances.token, s?.decimals ?? 18);
  $("payBal").textContent = state.account ? bal : "connect wallet";
  $("ethBal").textContent = fmt(state.balances.eth);
  $("wethBal").textContent = fmt(state.balances.weth);
  const btn = $("swapBtn") as HTMLButtonElement;
  if (!state.account) {
    btn.textContent = "Connect wallet";
    btn.disabled = false;
  } else if (!s) {
    btn.textContent = "Pick a token";
    btn.disabled = true;
  } else if (s.status !== 1) {
    btn.textContent = `${statusLabel(s.status)} – curve not tradable here`;
    btn.disabled = true;
  } else if (!supported(s)) {
    btn.textContent = "This curve's quote token is not WETH";
    btn.disabled = true;
  } else {
    btn.textContent = state.busy ? "Waiting for wallet…" : state.side === "buy" ? `Buy ${sym}` : `Sell ${sym}`;
    btn.disabled = state.busy;
  }
  // While a transaction is in flight, freeze everything the trade depends on.
  for (const id of ["wrapBtn", "unwrapBtn"]) ($(id) as HTMLButtonElement).disabled = !state.account || state.busy;
  for (const id of ["amount", "wrapAmount"]) ($(id) as HTMLInputElement).disabled = state.busy;
  ($("maxBtn") as HTMLButtonElement).disabled = state.busy;
  document.querySelectorAll<HTMLButtonElement>(".tab, .launch, #more").forEach((b) => (b.disabled = state.busy));
}

async function refreshBalances() {
  if (!state.account) return syncLabels();
  const owner = state.account;
  const token = state.selected?.token ?? null;
  const tasks: Promise<bigint>[] = [
    publicClient.getBalance({ address: owner }),
    publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
  ];
  if (token) tasks.push(publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }));
  try {
    const [eth, weth, tokenBal] = await Promise.all(tasks);
    // Ignore results for an account or token the user has since moved away from.
    if (owner !== state.account || token !== (state.selected?.token ?? null)) return;
    state.balances = { eth, weth, token: tokenBal ?? null };
  } catch (e) {
    log(`Balance read failed: ${errText(e)}`, "err");
  }
  syncLabels();
}

function currentTrade(): Trade | null {
  const s = state.selected;
  const text = ($("amount") as HTMLInputElement).value.trim();
  if (!s || !supported(s) || !/^\d*\.?\d+$/.test(text)) return null;
  const decimals = state.side === "buy" ? 18 : s.decimals;
  if ((text.split(".")[1]?.length ?? 0) > decimals) return null;
  const amountIn = parseUnits(text, decimals);
  if (amountIn <= 0n) return null;
  return { curve: s.curve, token: s.token, quoteToken: s.quoteToken, symbol: s.symbol, decimals: s.decimals, side: state.side, amountIn };
}

const tradeKey = (t: Trade | null) => (t ? `${t.curve}|${t.side}|${t.amountIn}` : "");
const outDecimals = (t: Trade) => (t.side === "buy" ? t.decimals : 18);
const outSymbol = (t: Trade) => (t.side === "buy" ? t.symbol : "WETH");

/** The public RPC sits behind several backends that can lag a block behind each other;
 * the SDK refuses mixed-block reads, so transient "consistent RPC state" errors are retried. */
async function prepare(trade: Trade, payer: Address) {
  const client = await swapClient();
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.prepareExactIn({
        model: "dbc",
        pool: trade.curve,
        tokenIn: trade.side === "buy" ? trade.quoteToken : trade.token,
        amountIn: trade.amountIn,
        payer,
        recipient: payer,
        slippageBps: SLIPPAGE_BPS,
      });
    } catch (e) {
      const transient = /consistent RPC state|RPC Request failed|rate limit|timed out|fetch/i.test(errText(e));
      if (!transient || attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

let quoteTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleQuote() {
  clearTimeout(quoteTimer);
  const seq = ++state.quoteSeq; // invalidates any quote already in flight
  clearQuote();
  quoteTimer = setTimeout(() => void runQuote(seq), 450);
}

function clearQuote(text = "–") {
  $("qOut").textContent = text;
  $("qMin").textContent = "–";
  $("qFee").textContent = "–";
  $("qBlock").textContent = "–";
}

async function runQuote(seq: number) {
  const s = state.selected;
  const trade = currentTrade();
  if (!s || s.status !== 1) return clearQuote();
  if (!supported(s)) return clearQuote("Quote token is not WETH");
  if (!trade) return clearQuote();
  $("qOut").textContent = "Quoting…";
  try {
    const prepared = await prepare(trade, state.account ?? QUOTE_PAYER);
    if (seq !== state.quoteSeq) return;
    const q = prepared.quote;
    $("qOut").textContent = `${fmt(q.expectedAmountOut, outDecimals(trade))} ${outSymbol(trade)}`;
    $("qMin").textContent = `${fmt(q.minimumAmountOut, outDecimals(trade))} ${outSymbol(trade)}`;
    const feeInToken = !!q.feeToken && getAddress(q.feeToken) === trade.token;
    $("qFee").textContent = q.feeAmount === null ? "–" : `${fmt(q.feeAmount, feeInToken ? trade.decimals : 18)} ${feeInToken ? trade.symbol : "WETH"}`;
    $("qBlock").textContent = q.quoteBlockNumber.toString();
  } catch (e) {
    if (seq === state.quoteSeq) clearQuote(`Quote failed: ${errText(e)}`);
  }
}

/* ---------- wallet ---------- */

const announced: { info: { rdns?: string; name?: string }; provider: EIP1193Provider }[] = [];
window.addEventListener("eip6963:announceProvider", (event) => {
  const detail = (event as CustomEvent).detail;
  if (detail?.provider) announced.push(detail);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

function pickProvider(): EIP1193Provider | null {
  const okx = announced.find((p) => p.info?.rdns?.includes("okex") || /okx/i.test(p.info?.name ?? ""));
  if (okx) return okx.provider;
  const w = window as unknown as { okxwallet?: EIP1193Provider; ethereum?: EIP1193Provider };
  return w.okxwallet ?? announced[0]?.provider ?? w.ethereum ?? null;
}

async function walletChainId(provider: EIP1193Provider) {
  return Number(await provider.request({ method: "eth_chainId" }));
}

async function ensureChain(provider: EIP1193Provider) {
  if ((await walletChainId(provider)) === CHAIN_ID) return;
  const hex = `0x${CHAIN_ID.toString(16)}` as const;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hex, chainName: "GIWA Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [RPC], blockExplorerUrls: [EXPLORER] }],
    });
  }
}

async function connect() {
  if (state.busy) return;
  const provider = state.provider ?? pickProvider();
  if (!provider) {
    log("No browser wallet found. Install OKX Wallet or MetaMask.", "err");
    return;
  }
  try {
    const [addr] = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
    await ensureChain(provider);
    state.provider = provider;
    if (!state.listenersBound) {
      state.listenersBound = true;
      provider.on?.("accountsChanged", (accounts: string[]) => (accounts[0] ? setAccount(getAddress(accounts[0])) : disconnect()));
      provider.on?.("chainChanged", (id: string) => markChain(Number(id)));
    }
    markChain(CHAIN_ID);
    if (state.account !== getAddress(addr)) {
      setAccount(getAddress(addr));
      log(`Connected ${short(addr)} on GIWA Sepolia.`, "ok");
    } else {
      await refreshBalances();
    }
  } catch (e) {
    log(`Connect failed: ${errText(e)}`, "err");
  }
}

function setAccount(addr: Address) {
  state.account = addr;
  state.wallet = createWalletClient({ account: addr, chain, transport: custom(state.provider!) });
  state.balances = { eth: null, weth: null, token: null };
  $("connect").textContent = short(addr);
  void refreshBalances();
  scheduleQuote();
}

function disconnect() {
  state.account = null;
  state.wallet = null;
  state.balances = { eth: null, weth: null, token: null };
  $("connect").textContent = "Connect wallet";
  syncLabels();
}

function markChain(id: number) {
  const net = $("net");
  net.textContent = id === CHAIN_ID ? "GIWA Sepolia" : `Wrong network (${id})`;
  net.classList.toggle("bad", id !== CHAIN_ID);
}

async function withBusy(fn: () => Promise<void>) {
  if (state.busy) return;
  state.busy = true;
  syncLabels();
  try {
    await ensureChain(state.provider!);
    await fn();
  } catch (e) {
    log(errText(e), "err");
  } finally {
    state.busy = false;
    syncLabels();
    await refreshBalances();
  }
}

/* ---------- actions ---------- */

function describe(status: SafeSwapStatus, t: Trade) {
  switch (status.type) {
    case "approval-requested":
      return log(`Approve ${t.side === "buy" ? "WETH" : t.symbol} spending in your wallet (exact amount)…`);
    case "approval-submitted":
      return log("Approval sent.", "info", status.hash);
    case "approval-confirmed":
      return log("Approval confirmed.", "ok", status.hash);
    case "swap-requested":
      return log(`Confirm the swap in your wallet. Minimum out: ${fmt(status.quote.minimumAmountOut, outDecimals(t))} ${outSymbol(t)}.`);
    case "swap-submitted":
      return log("Swap sent.", "info", status.hash);
    case "swap-confirmed":
      return log(
        `Swap confirmed${status.amountReceived !== null ? `: received ${fmt(status.amountReceived, outDecimals(t))} ${outSymbol(t)}` : ""}.`,
        "ok",
        status.hash,
      );
    case "quote-refreshed":
      return log(`Quote refreshed before sending: ${fmt(status.quote.expectedAmountOut, outDecimals(t))} ${outSymbol(t)}.`);
  }
}

async function swap() {
  if (!state.account) return connect();
  const trade = currentTrade();
  if (!trade) return log("Enter a valid amount first.", "err");
  const payer = state.account;
  const key = tradeKey(trade);
  await withBusy(async () => {
    log(`Preparing ${trade.side} ${trade.side === "buy" ? "of" : ""} ${trade.symbol} with AmmoraSwapClient…`);
    const prepared = await prepare(trade, payer);
    const result = await prepared.execute(state.wallet!, {
      exactApproval: true,
      simulate: true,
      autoRefresh: true,
      onStatus: (status) => describe(status, trade),
      // Rechecked by the SDK before every signature request.
      beforeSend: async () => {
        if (state.account !== payer) throw new Error("Wallet account changed. Start the swap again.");
        if (tradeKey(currentTrade()) !== key) throw new Error("Trade inputs changed. Start the swap again.");
        if ((await walletChainId(state.provider!)) !== CHAIN_ID) throw new Error("Wallet is not on GIWA Sepolia.");
      },
    });
    const fresh = state.launches.find((l) => l.curve === trade.curve);
    if (fresh) {
      await enrich([fresh]);
      if (state.selected?.curve === trade.curve) {
        Object.assign(state.selected, { status: fresh.status, quoteReserve: fresh.quoteReserve, threshold: fresh.threshold });
      }
      renderLaunches();
    }
    if (result.amountReceived === null) log("Swap succeeded; output reconciliation unavailable.", "info", result.hash);
    scheduleQuote();
  });
}

async function wrap(direction: "wrap" | "unwrap") {
  if (!state.account) return connect();
  const text = ($("wrapAmount") as HTMLInputElement).value.trim();
  if (!/^\d*\.?\d+$/.test(text) || (text.split(".")[1]?.length ?? 0) > 18) return log("Enter a valid ETH amount (up to 18 decimals).", "err");
  const raw = parseUnits(text, 18);
  if (raw <= 0n) return;
  const { eth, weth } = state.balances;
  if (direction === "wrap" && eth !== null && raw + GAS_RESERVE > eth) {
    return log(`Keep at least ${fmt(GAS_RESERVE)} ETH for gas. You have ${fmt(eth)} ETH.`, "err");
  }
  if (direction === "unwrap" && weth !== null && raw > weth) return log(`You only have ${fmt(weth)} WETH.`, "err");
  await withBusy(async () => {
    const tx = direction === "wrap" ? buildAmmoraPortableWrapTransaction(wrapModel, raw) : buildAmmoraPortableUnwrapTransaction(wrapModel, raw);
    log(`Confirm ${direction} of ${text} in your wallet…`);
    const hash = await state.wallet!.sendTransaction({ account: state.account!, chain, to: tx.to, data: tx.data, value: tx.value });
    log(`${direction === "wrap" ? "Wrap" : "Unwrap"} sent.`, "info", hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${direction} reverted`);
    log(`${direction === "wrap" ? "Wrapped" : "Unwrapped"} ${text}.`, "ok", hash);
  });
}

/* ---------- wiring ---------- */

$("connect").addEventListener("click", () => void connect());
$("swapBtn").addEventListener("click", () => void swap());
$("wrapBtn").addEventListener("click", () => void wrap("wrap"));
$("unwrapBtn").addEventListener("click", () => void wrap("unwrap"));
$("more").addEventListener("click", () => void loadLaunches(true));
$("onlyActive").addEventListener("change", renderLaunches);
$("amount").addEventListener("input", scheduleQuote);
$("maxBtn").addEventListener("click", () => {
  const s = state.selected;
  const bal = state.side === "buy" ? state.balances.weth : state.balances.token;
  if (bal === null || state.busy) return;
  ($("amount") as HTMLInputElement).value = formatUnits(bal, state.side === "buy" ? 18 : (s?.decimals ?? 18));
  scheduleQuote();
});
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    if (state.busy) return;
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.side = tab.dataset.side === "sell" ? "sell" : "buy";
    syncLabels();
    scheduleQuote();
  }),
);

($("amount") as HTMLInputElement).value = "0.001";
syncLabels();
void loadLaunches();
