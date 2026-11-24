// 읽기 전용: SDK에 들어 있는 GIWA auto-route 배포 정보와 V4 팩토리 ABI 이름을 출력한다.
import {
  giwaSepoliaAutoRouteDeployment,
  ammoraLaunchFactoryV4Abi,
  ammoraLaunchPoolV4Abi,
} from "@ammora-protocol/sdk";

const replacer = (_, v) => (typeof v === "bigint" ? v.toString() : v);
const d = giwaSepoliaAutoRouteDeployment;
console.log("slot", d.slot, "chain", d.chain?.id, d.chain?.name);
console.log(JSON.stringify(d.contracts, replacer, 2));
console.log("startBlocks", JSON.stringify(d.startBlocks ?? d.deploymentBlocks ?? null, replacer));
const names = (abi) => abi.map((x) => `${x.type}:${x.name ?? ""}(${(x.inputs ?? []).map((i) => i.type + " " + i.name).join(",")})${x.outputs ? "->" + x.outputs.map((o) => o.type).join(",") : ""}`);
console.log("--- factory ---\n" + names(ammoraLaunchFactoryV4Abi).filter((s) => !s.startsWith("error")).join("\n"));
console.log("--- pool ---\n" + names(ammoraLaunchPoolV4Abi).filter((s) => s.startsWith("function") || s.startsWith("event")).join("\n"));
console.log("keys", Object.keys(d));
