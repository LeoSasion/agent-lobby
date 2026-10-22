/**
 * 冒烟测试：MCP 通道（通道 C）
 * 模拟 MCP 客户端：spawn mcp/server.ts → initialize → tools/list → join → view/act 循环打完整局
 * 前置：网关运行在 http://localhost:8787
 * 运行：node --experimental-strip-types mcp/smoke.ts
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const serverPath = fileURLToPath(new URL("./server.ts", import.meta.url));
const statePath = join(dirname(serverPath), ".smoke-state.json");
const child = spawn(process.execPath, ["--experimental-strip-types", serverPath], {
  env: { ...process.env, ARENA_URL: "http://localhost:8787", ARENA_STATE: statePath },
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map<number, (v: Record<string, unknown>) => void>();
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line) as { id?: number };
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg as Record<string, unknown>);
      pending.delete(msg.id);
    }
  } catch {
    /* 忽略非 JSON 行 */
  }
});

function call(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = (await call("tools/call", { name, arguments: args })) as {
    result?: { content?: { text?: string }[] };
  };
  return r.result?.content?.[0]?.text ?? "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("=== Agent 游戏大厅 · MCP 通道冒烟测试 ===\n");
const t0 = Date.now();

const init = (await call("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
})) as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } };
check("initialize 握手", init.result?.protocolVersion === "2024-11-05", `server=${init.result?.serverInfo?.name}`);

const tl = (await call("tools/list")) as { result?: { tools?: { name: string }[] } };
const names = (tl.result?.tools ?? []).map((t) => t.name);
// r30c：此处曾硬编码 names.length === 8（当时确为 8 个工具）。工具增至 10 个后断言恒假，
// 而本冒烟不在任何 npm test 链上，坏掉半年无人知——"数量必须恰好相等"是错的锁法：
// 应该锁「能力只能增不能减」这个真不变量。删除/改名工具会挂，新增工具不挂。
const REQUIRED_TOOLS = [
  "arena_register", "arena_games", "arena_join", "arena_join_room", "arena_room_status",
  "arena_view", "arena_act", "arena_events", "arena_leaderboard", "arena_status",
];
const missing = REQUIRED_TOOLS.filter((n) => !names.includes(n));
check(
  "工具清单完整（关键工具齐备、数量只增不减）",
  missing.length === 0 && names.length >= REQUIRED_TOOLS.length && new Set(names).size === names.length,
  missing.length ? `缺失 ${missing.join(",")}` : `${names.length} 个${names.length > REQUIRED_TOOLS.length ? "（新增未登记：" + names.filter((n) => !REQUIRED_TOOLS.includes(n)).join(",") + "）" : ""}`,
);

const games = await tool("arena_games");
check("arena_games 返回游戏目录", games.includes("liars_dice") && games.includes("werewolf_lite"));

const joinText = await tool("arena_join", { game: "liars_dice", seats: 3 });
check("arena_join 成功开局", joinText.includes("已加入对局"), joinText.slice(0, 60));

// 打完整局：view → 轮到我则出招（有叫价就质疑，否则叫 1 个 2）
let finished = false;
let moves = 0;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const vText = await tool("arena_view");
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(vText) as Record<string, unknown>;
  } catch {
    check("arena_view 返回合法 JSON", false, vText.slice(0, 80));
    break;
  }
  if (v.phase === "finished") {
    finished = true;
    break;
  }
  const you = v.you as { active?: boolean } | undefined;
  if (you?.active) {
    const pub = v.public as { current_bid?: unknown } | undefined;
    const action = pub?.current_bid ? { type: "challenge" } : { type: "bid", qty: 1, face: 2 };
    const rText = await tool("arena_act", { action });
    // r30c：arena_act 自 r9 起返回纯 JSON（{"ok":true,"applied":true,...}），
    // 本冒烟却仍在找「已提交」字样 —— 断言早就恒假，只因不在 test 链上没人发现。
    let ok = false;
    try {
      ok = (JSON.parse(rText) as { ok?: boolean }).ok === true;
    } catch {
      ok = false; // 非 JSON = 工具级错误文本（isError）
    }
    if (!ok) {
      check("arena_act 应成功", false, rText.slice(0, 120));
      break;
    }
    moves++;
  } else {
    await sleep(150);
  }
}
check("MCP 通道打完整局（验收：AI 经 MCP 完赛）", finished, `${moves} 次出招 · ${Date.now() - t0}ms`);

child.kill();
console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
process.exit(failed > 0 ? 1 : 0);
