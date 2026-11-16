/**
 * 冒烟测试：持续匹配队列（r49）
 * 覆盖：同游戏+同席位数凑满自动开局 / 票 token 鉴权 / 排位与等待人数 /
 *       重复入队幂等 / 取消 / 过期票清理 / 队列大厅聚合。
 * 运行：node --experimental-strip-types src/smoke-queue.ts
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "./gateway/http.ts";

const PORT = 18840;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

process.env.ALLOW_PRIVATE_WEBHOOKS = "1";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const g = new Gateway(join(tmpdir(), `arena-queue-smoke-${process.pid}.json`));
g.registerGame((await import("./games/othello.ts")).createOthello());
g.registerGame((await import("./games/liars-dice.ts")).createLiarsDice());
g.listen(PORT);

interface Resp {
  status: number;
  body: Record<string, unknown>;
}
async function api(path: string, init?: RequestInit): Promise<Resp> {
  const r = await fetch(BASE + path, init);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const post = (p: string, body: unknown, bearer?: string): Promise<Resp> =>
  api(p, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: "Bearer " + bearer } : {}),
    },
    body: JSON.stringify(body),
  });
const get = (p: string, token?: string): Promise<Resp> =>
  api(p, { headers: token ? { "x-queue-token": token } : {} });

async function main(): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fetch(BASE + "/games");
      break;
    } catch {
      if (i > 60) throw new Error("网关未就绪");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  console.log("\n[1] 双人黑白棋：队列凑满自动开局");
  const q1 = await post("/lobby/queue", { game: "othello", seats: 2, name: "queue-a" });
  check("首张票进入 waiting", q1.status === 201 && q1.body.status === "waiting", JSON.stringify(q1.body));
  check("首张票排位为 1", q1.body.position === 1 && q1.body.waiting === 1, JSON.stringify({ position: q1.body.position, waiting: q1.body.waiting }));

  const q2 = await post("/lobby/queue", { game: "othello", seats: 2, name: "queue-b" });
  check("第二张票立即 matched", q2.status === 201 && q2.body.status === "matched", JSON.stringify(q2.body));
  check("匹配结果含 match_id 与 seat_token", typeof q2.body.match_id === "string" && typeof q2.body.seat_token === "string", "");
  const matchId = String(q2.body.match_id);

  const s1 = await get(`/lobby/queue/${String(q1.body.ticket_id)}`, String(q1.body.token));
  check("首张票也能读到同一局", s1.body.status === "matched" && s1.body.match_id === matchId, JSON.stringify(s1.body));
  check("两席座位号分别为 1 / 2", s1.body.seat_id === 1 && q2.body.seat_id === 2, `${String(s1.body.seat_id)}/${String(q2.body.seat_id)}`);
  check("两张票的 token 不同", q1.body.token !== q2.body.token, "");

  const v1 = await fetch(`${BASE}/matches/${matchId}/view`, { headers: { "x-seat-token": String(s1.body.seat_token) } });
  const v2 = await fetch(`${BASE}/matches/${matchId}/view`, { headers: { "x-seat-token": String(q2.body.seat_token) } });
  const j1 = await v1.json() as { you?: { seat?: number } };
  const j2 = await v2.json() as { you?: { seat?: number } };
  check("双方凭匹配票 seat_token 可进入对局", j1.you?.seat === 1 && j2.you?.seat === 2, `${j1.you?.seat}/${j2.you?.seat}`);

  const list = await get("/lobby/queue");
  check("开局后队列大厅清空", Array.isArray(list.body.queue) && (list.body.queue as unknown[]).length === 0, JSON.stringify(list.body));

  console.log("\n[2] 票 token 鉴权与取消");
  const q3 = await post("/lobby/queue", { game: "liars_dice", seats: 3, name: "queue-c" });
  check("第三人进入三席队列", q3.status === 201 && q3.body.status === "waiting", JSON.stringify(q3.body));
  const bad = await get(`/lobby/queue/${String(q3.body.ticket_id)}`, "wrong-token");
  check("错误 token → 403 QUEUE_FORBIDDEN", bad.status === 403 && bad.body.code === "QUEUE_FORBIDDEN", JSON.stringify(bad.body));
  const cancel = await api(`/lobby/queue/${String(q3.body.ticket_id)}?token=${encodeURIComponent(String(q3.body.token))}`, { method: "DELETE" });
  check("取消 waiting 队列 → cancelled", cancel.status === 200 && cancel.body.status === "cancelled", JSON.stringify(cancel.body));
  const afterCancel = await get(`/lobby/queue/${String(q3.body.ticket_id)}`, String(q3.body.token));
  check("取消后状态可查且不再等待", afterCancel.body.status === "cancelled", JSON.stringify(afterCancel.body));

  console.log("\n[3] 幂等、非法参数与 webhook 边界");
  const dup1 = await post("/lobby/queue", { game: "liars_dice", seats: 3, name: "queue-dup" });
  const dup2 = await post("/lobby/queue", { game: "liars_dice", seats: 3, name: "queue-dup" }, String(dup1.body.api_key));
  check("同一身份重复入队返回原票", dup2.status === 200 && dup2.body.ticket_id === dup1.body.ticket_id && dup2.body.replay === true, JSON.stringify(dup2.body));
  const badGame = await post("/lobby/queue", { game: "not_a_game", seats: 2 });
  check("不存在的游戏 → 404 GAME_NOT_FOUND", badGame.status === 404 && badGame.body.code === "GAME_NOT_FOUND", JSON.stringify(badGame.body));
  const badWh = await post("/lobby/queue", { game: "othello", seats: 2, channel: "webhook" });
  check("无 Bearer 的 webhook 队列 → 401", badWh.status === 401 && badWh.body.code === "WEBHOOK_AUTH_REQUIRED", JSON.stringify(badWh.body));

  await g.close();
  console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke-queue] 异常：", e);
  process.exit(1);
});
