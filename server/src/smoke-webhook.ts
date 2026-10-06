/**
 * 冒烟测试：Webhook Push 通道（通道 B）
 * 本地起一个 mini Agent 服务：验签 + 策略应答 + 故意发一次非法动作验证自纠
 * 运行：node --experimental-strip-types src/smoke-webhook.ts
 */

import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { createLiarsDice } from "./games/liars-dice.ts";
import { createMatch } from "./arena/lobby.ts";
import { createRuleBot } from "./bots/rule-bot.ts";
import { WebhookSeatDriver } from "./gateway/webhook.ts";
import type { AgentView } from "./protocol.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const SECRET = "whsec_test123";
let turns = 0;
let rejected = 0;
let sigOk = true;

/** 简单吹牛骰策略（与 play.ts 同源） */
function decideDice(view: AgentView): Record<string, unknown> {
  const my = (view.private as { my_dice?: number[] }).my_dice ?? [];
  const pub = view.public as {
    players: { seat: number; dice_count: number }[];
    current_bid: { seat: number; qty: number; face: number } | null;
  };
  const total = pub.players.reduce((a, p) => a + p.dice_count, 0);
  const bid = pub.current_bid;
  if (!bid) return { type: "bid", qty: Math.max(1, Math.round((total / 6) * 0.7)), face: my[0] ?? 3 };
  const own = my.filter((d) => d === bid.face).length;
  if (bid.qty > own + (total - my.length) / 6 + 0.5) return { type: "challenge" };
  let qty = bid.qty;
  let face = bid.face + 1;
  if (face > 6) {
    face = 1;
    qty += 1;
  }
  return { type: "bid", qty, face };
}

const agentServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const sig = req.headers["x-arena-signature"];
    const expect = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
    if (sig !== expect) sigOk = false;
    const payload = JSON.parse(body) as { event?: string; view?: AgentView };

    if (payload.event === "turn.start" || payload.event === "action.rejected") {
      if (payload.event === "turn.start") turns++;
      // 第一拍故意非法（qty:0 / face:99），验证自纠链路；其后正常应答
      const action =
        payload.event === "turn.start" && turns === 1
          ? { type: "bid", qty: 0, face: 99 }
          : decideDice(payload.view!);
      if (payload.event === "action.rejected") rejected++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ action }));
      return;
    }
    res.writeHead(200);
    res.end("{}");
  });
});

console.log("=== Agent 游戏大厅 · Webhook 通道冒烟测试 ===\n");
await new Promise<void>((r) => agentServer.listen(8899, "127.0.0.1", r));

const game = createLiarsDice();
const driver = new WebhookSeatDriver({
  name: "webhook-agent",
  url: "http://127.0.0.1:8899/",
  secret: SECRET,
  timeoutMs: 5000,
});
const r = await createMatch({
  game,
  drivers: [driver, createRuleBot("对手bot", 0.5)],
  seed: 42,
}).run();

check("Webhook 通道完成整局", Object.values(r.scores).some((v) => v === 1), `回合事件 × ${turns}`);
check("HMAC 签名全部通过", sigOk);
check("非法动作自纠生效（action.rejected → 重提交）", rejected >= 1, `rejected × ${rejected}`);
check("非法动作未进入事件流", !r.events.some((e) => e.type === "acted" && JSON.stringify((e.data as { action?: { qty?: number } }).action?.qty) === "0"));

agentServer.close();
console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
if (failed > 0) process.exitCode = 1;
