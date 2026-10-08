/**
 * mcp-r4 实测驱动（通道 C · MCP）—— 仅写入 tmp-r4/
 * 流程：spawn mcp/server.ts → initialize → tools/list → 探针 → 2 局 othello → 全程 RPC 落盘
 * 运行：node --experimental-strip-types tmp-r4/mcp-r4-driver.ts
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RPC_LOG = join(HERE, "mcp-r4-rpc.jsonl");
const RUN_LOG = join(HERE, "mcp-r4-run.txt");
writeFileSync(RPC_LOG, "", "utf8");
writeFileSync(RUN_LOG, "", "utf8");

function log(line: string): void {
  console.log(line);
  appendFileSync(RUN_LOG, line + "\n", "utf8");
}
function logRpc(dir: "send" | "recv", obj: unknown): void {
  appendFileSync(RPC_LOG, JSON.stringify({ t: Date.now(), dir, msg: obj }) + "\n", "utf8");
}

// ---------------- othello 引擎（黑白棋规则 + negamax） ----------------
const DIRS: number[][] = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

function flipsFor(board: number[], cell: number, player: number): number[] {
  if (board[cell] !== 0) return [];
  const opp = 3 - player;
  const r = Math.floor(cell / 8);
  const c = cell % 8;
  const all: number[] = [];
  for (const [dr, dc] of DIRS) {
    const line: number[] = [];
    let closed = false;
    let rr = r + dr;
    let cc = c + dc;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const v = board[rr * 8 + cc];
      if (v === opp) line.push(rr * 8 + cc);
      else if (v === player) { closed = line.length > 0; break; }
      else break;
      rr += dr;
      cc += dc;
    }
    if (closed) all.push(...line);
  }
  return all;
}
function legalCells(board: number[], player: number): number[] {
  const out: number[] = [];
  for (let cell = 0; cell < 64; cell++) if (board[cell] === 0 && flipsFor(board, cell, player).length > 0) out.push(cell);
  return out;
}
function applyMove(board: number[], cell: number, player: number): number[] {
  const nb = board.slice();
  nb[cell] = player;
  for (const f of flipsFor(board, cell, player)) nb[f] = player;
  return nb;
}
function discDiff(board: number[], player: number): number {
  let me = 0, op = 0;
  for (const v of board) {
    if (v === player) me++;
    else if (v === 3 - player) op++;
  }
  return me - op;
}

const W = [
  120, -20, 20, 5, 5, 20, -20, 120,
  -20, -40, -5, -5, -5, -5, -40, -20,
  20, -5, 15, 3, 3, 15, -5, 20,
  5, -5, 3, 3, 3, 3, -5, 5,
  5, -5, 3, 3, 3, 3, -5, 5,
  20, -5, 15, 3, 3, 15, -5, 20,
  -20, -40, -5, -5, -5, -5, -40, -20,
  120, -20, 20, 5, 5, 20, -20, 120,
];

function evalBoard(board: number[], player: number): number {
  let pos = 0;
  for (let i = 0; i < 64; i++) {
    if (board[i] === player) pos += W[i];
    else if (board[i] === 3 - player) pos -= W[i];
  }
  const myMob = legalCells(board, player).length;
  const opMob = legalCells(board, 3 - player).length;
  return pos + (myMob - opMob) * 8;
}

function negamax(board: number[], player: number, depth: number, alpha: number, beta: number): number {
  const opp = 3 - player;
  const moves = legalCells(board, player);
  if (depth === 0 && moves.length > 0) return evalBoard(board, player);
  if (moves.length === 0) {
    if (legalCells(board, opp).length === 0) return discDiff(board, player) * 10000;
    return -negamax(board, opp, depth, -beta, -alpha);
  }
  let best = -Infinity;
  const ordered = moves.slice().sort((a, b) => W[b] - W[a]);
  for (const c of ordered) {
    const nb = applyMove(board, c, player);
    const sc = -negamax(nb, opp, depth - 1, -beta, -alpha);
    if (sc > best) best = sc;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

interface Pick { cell: number; depth: number; score: number; ms: number; }
function chooseMove(board: number[], player: number, budgetMs = 1400): Pick | null {
  const moves = legalCells(board, player);
  if (moves.length === 0) return null;
  const ordered = moves.slice().sort((a, b) => W[b] - W[a]);
  const t0 = Date.now();
  let bestCell = ordered[0];
  let bestScore = 0;
  let reached = 0;
  for (let depth = 2; depth <= 9; depth++) {
    if (Date.now() - t0 > budgetMs) break;
    let localBest = ordered[0];
    let localScore = -Infinity;
    let alpha = -Infinity;
    for (const c of ordered) {
      const nb = applyMove(board, c, player);
      const sc = -negamax(nb, 3 - player, depth - 1, -Infinity, -alpha);
      if (sc > localScore) { localScore = sc; localBest = c; }
      if (sc > alpha) alpha = sc;
      if (Date.now() - t0 > budgetMs) break;
    }
    if (localScore > -Infinity) { bestCell = localBest; bestScore = localScore; reached = depth; }
    if (bestScore >= 9000) break; // 已见必胜
  }
  return { cell: bestCell, depth: reached, score: bestScore, ms: Date.now() - t0 };
}

// ---------------- MCP 客户端 ----------------
const serverPath = join(ROOT, "mcp", "server.ts");
const statePath = join(HERE, ".mcp-r4-state.json");
const child = spawn(process.execPath, ["--experimental-strip-types", serverPath], {
  env: { ...process.env, ARENA_URL: "http://localhost:8787", ARENA_STATE: statePath },
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map<number, (v: Record<string, unknown>) => void>();
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
  logRpc("recv", msg);
  const id = msg.id as number | undefined;
  if (id !== undefined && pending.has(id)) { pending.get(id)!(msg); pending.delete(id); }
});

function call(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = nextId++;
  const req = { jsonrpc: "2.0", id, method, params };
  logRpc("send", req);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("RPC timeout: " + method)); }, 90_000);
    pending.set(id, (v) => { clearTimeout(timer); resolve(v); });
    child.stdin.write(JSON.stringify(req) + "\n");
  });
}

interface ToolResult { text: string; isError: boolean; ms: number; }
async function tool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const t0 = Date.now();
  const r = (await call("tools/call", { name, arguments: args })) as {
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  const text = r.result?.content?.[0]?.text ?? (r.error ? "RPC_ERROR: " + r.error.message : "");
  return { text, isError: !!r.result?.isError || !!r.error, ms: Date.now() - t0 };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------- 主流程 ----------------
interface View {
  phase: string;
  round: number;
  you: { seat: number; active: boolean };
  public: {
    board: number[];
    turn: number | null;
    colors: { black: number; white: number };
    counts: { black: number; white: number };
    last_move: number | null;
  };
  legal_actions: { type: string; schema?: { values?: number[] }; hint?: string }[];
  deadline_ms: number | null;
  history: { seq: number; type: string }[];
}

function parseView(text: string): View | null {
  try { return JSON.parse(text) as View; } catch { return null; }
}

async function playOne(gameNo: number): Promise<void> {
  log(`\n########## 第 ${gameNo} 局 ##########`);
  const join = await tool("arena_join", { game: "othello" });
  log(`[join] ${join.ms}ms isError=${join.isError} :: ${join.text.replace(/\n/g, " ")}`);
  if (join.isError) return;

  let moveCount = 0;
  let illegalProbeDone = false;
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 180_000) { log("!! 超过 180s 未终局，放弃"); break; }
    const vres = await tool("arena_view");
    const v = parseView(vres.text);
    if (!v) { log(`[view] 解析失败 isError=${vres.isError} :: ${vres.text.slice(0, 200)}`); break; }
    if (v.phase === "finished") {
      await finish(gameNo, v, moveCount, t0);
      return;
    }
    if (!v.you.active) { await sleep(250); continue; }
    // 出招
    const cells = (v.legal_actions.find((a) => a.type === "place")?.schema?.values ?? []) as number[];
    if (cells.length === 0) {
      const pa = await tool("arena_act", { action: { type: "pass" }, reasoning: "无合法落点，虚着" });
      log(`[act] PASS ${pa.ms}ms :: ${pa.text.slice(0, 80)}`);
      continue;
    }
    // 探针 P3：第 1 局首手先提交一个非法落点，采集错误文案（不影响棋局）
    if (gameNo === 1 && !illegalProbeDone) {
      illegalProbeDone = true;
      const bad = cells.includes(0) ? 63 : 0;
      const pr = await tool("arena_act", { action: { type: "place", cell: bad } });
      log(`[PROBE P3 非法落点 cell=${bad}] isError=${pr.isError} :: ${pr.text.replace(/\n/g, " ").slice(0, 300)}`);
    }
    const pick = chooseMove(v.public.board, v.you.seat)!;
    const act = await tool("arena_act", {
      action: { type: "place", cell: pick.cell },
      reasoning: `negamax d${pick.depth} score=${pick.score} cell=${pick.cell}`,
    });
    moveCount++;
    if (act.isError) log(`[act] #${moveCount} cell=${pick.cell} 被拒 :: ${act.text.replace(/\n/g, " ").slice(0, 200)}`);
    else log(`[act] #${moveCount} cell=${pick.cell} d${pick.depth} score=${pick.score} search=${pick.ms}ms rpc=${act.ms}ms`);
  }
  child.kill();
  process.exit(0);
}

async function finish(gameNo: number, v: View, moves: number, t0: number): Promise<void> {
  const ev = await tool("arena_events", { since: -1 });
  let scores: Record<string, number> | null = null;
  try {
    const parsed = JSON.parse(ev.text) as { events?: { type: string; data?: { scores?: Record<string, number> } }[] };
    const ended = parsed.events?.find((e) => e.type === "match_ended");
    scores = ended?.data?.scores ?? null;
  } catch { /* ignore */ }
  const me = v.you.seat;
  const myColor = v.public.colors.black === me ? "黑" : "白";
  const mine = myColor === "黑" ? v.public.counts.black : v.public.counts.white;
  const theirs = myColor === "黑" ? v.public.counts.white : v.public.counts.black;
  const result = mine > theirs ? "胜" : mine === theirs ? "平" : "负";
  log(`[终局] 手数=${moves} 我方座位=${me}(${myColor}) 子数 我=${mine} 敌=${theirs} 结果=${result} scores=${JSON.stringify(scores)} 用时=${Date.now() - t0}ms`);
  log(`[终局 view] phase=${v.phase} round=${v.round} you.active=${v.you.active} counts=${JSON.stringify(v.public.counts)} colors=${JSON.stringify(v.public.colors)}`);
  // 排行榜
  const lb = await tool("arena_leaderboard", { game: "othello" });
  log(`[排行榜] ${lb.ms}ms\n${lb.text}`);
}

async function main(): Promise<void> {
  log("=== mcp-r4 通道 C 实测开始 ===");
  // 1. initialize
  const init = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-r4-tester", version: "1.0" },
  });
  log(`[initialize] ${JSON.stringify(init.result ?? init.error)}`);

  // 2. tools/list —— 原文保存
  const tl = (await call("tools/list")) as { result?: { tools?: { name: string; description: string; inputSchema: unknown }[] } };
  const tools = tl.result?.tools ?? [];
  log(`[tools/list] 共 ${tools.length} 个工具`);
  for (const t of tools) log(`  · ${t.name}\n    desc: ${t.description}\n    schema: ${JSON.stringify(t.inputSchema)}`);
  writeFileSync(join(HERE, "mcp-r4-tools-list.json"), JSON.stringify(tools, null, 2), "utf8");

  // 探针 P1：未加入即 view
  const p1 = await tool("arena_view");
  log(`\n[PROBE P1 未 join 就 view] isError=${p1.isError} :: ${p1.text}`);

  // 探针 P2：不存在的游戏
  const p2 = await tool("arena_join", { game: "nonexistent-game" });
  log(`[PROBE P2 join 不存在游戏] isError=${p2.isError} :: ${p2.text.slice(0, 300)}`);

  // 探针 P4：注册身份
  const reg = await tool("arena_register", { name: "mcp-r4-agent" });
  log(`[PROBE P4 register] isError=${reg.isError} :: ${reg.text}`);

  // 3. 两局
  await playOne(1);
  await playOne(2);
}

main()
  .then(() => { log("\n=== 全部结束 ==="); child.kill(); process.exit(0); })
  .catch((e) => { log("FATAL " + String(e)); child.kill(); process.exit(1); });
