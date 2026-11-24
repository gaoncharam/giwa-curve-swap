// 읽기 전용: 탐색기 API로 최근 런치를 읽고, SDK AmmoraSwapClient로 WETH→토큰 견적을 낸다(서명·전송 없음).
import { createPublicClient, http, defineChain, decodeEventLog, erc20Abi, formatUnits, parseEther } from "viem";
import {
  AmmoraSwapClient,
  giwaSepoliaAutoRouteDeployment as d,
  giwaSepoliaAutoRoutePoolProfiles,
  ammoraLaunchFactoryV4Abi,
  ammoraLaunchPoolV4Abi,
} from "@ammora-protocol/sdk";

const chain = defineChain({ id: 91342, name: "GIWA Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } } });
const client = createPublicClient({ chain, transport: http() });
const payer = "0x0000000000000000000000000000000000000001";

const res = await fetch(`https://sepolia-explorer.giwa.io/api/v2/addresses/${d.contracts.launch.factory}/logs`);
const page = await res.json();
const launches = [];
for (const item of page.items) {
  try {
    const ev = decodeEventLog({ abi: ammoraLaunchFactoryV4Abi, data: item.data, topics: item.topics.filter(Boolean) });
    if (ev.eventName === "LaunchCreated") launches.push({ ...ev.args, block: item.block_number });
  } catch {}
}
console.log("decoded", launches.length, "next", JSON.stringify(page.next_page_params));

const swaps = await AmmoraSwapClient.create(client, { deploymentCatalog: { 91342: d }, factoryProfiles: giwaSepoliaAutoRoutePoolProfiles });
let tried = 0;
for (const l of launches) {
  const [symbol, status, quoteToken, quoteReserve, threshold] = await Promise.all([
    client.readContract({ address: l.token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: l.curve, abi: ammoraLaunchPoolV4Abi, functionName: "status" }),
    client.readContract({ address: l.curve, abi: ammoraLaunchPoolV4Abi, functionName: "quoteToken" }),
    client.readContract({ address: l.curve, abi: ammoraLaunchPoolV4Abi, functionName: "quoteReserve" }),
    client.readContract({ address: l.curve, abi: ammoraLaunchPoolV4Abi, functionName: "migrationQuoteThreshold" }),
  ]);
  console.log(l.block, symbol, l.curve, "status", status, "quote", quoteToken, formatUnits(quoteReserve, 18), "/", formatUnits(threshold, 18));
  if (status !== 1 || tried >= 2) continue;
  tried++;
  try {
    const prepared = await swaps.prepareExactIn({ model: "dbc", pool: l.curve, tokenIn: quoteToken, amountIn: parseEther("0.001"), payer, recipient: payer, slippageBps: 100 });
    const q = prepared.quote;
    console.log("  QUOTE out", formatUnits(q.expectedAmountOut, 18), "min", formatUnits(q.minimumAmountOut, 18), "approvals", JSON.stringify(prepared.approvalRequirements, (_, v) => typeof v === "bigint" ? v.toString() : v), "to", prepared.transaction.to);
  } catch (e) {
    console.log("  QUOTE FAIL", String(e.shortMessage ?? e.message).slice(0, 300));
  }
  try {
    const nat = await swaps.prepareExactIn({ model: "dbc", pool: l.curve, tokenIn: quoteToken, inputAsset: "native", amountIn: parseEther("0.001"), payer, recipient: payer, slippageBps: 100 });
    console.log("  NATIVE ok to", nat.transaction.to, "value", String(nat.transaction.value));
  } catch (e) {
    console.log("  NATIVE FAIL", String(e.shortMessage ?? e.message).slice(0, 300));
  }
}
