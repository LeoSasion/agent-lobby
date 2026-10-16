/**
 * 冒烟测试：相位间隙提前提交（HTTP 通道回归 · E2E）
 * 场景：狼人杀网关固定 minPhaseMs=4000——每步结算后有 4s 强制间隙。
 *   r27-e 预算：r26-b 狼队密语让夜间横跨两步（先声明后出刀，各 4s 间隙）；
 *   夜亡者为 bot 时其遗言再占一步（+4s）——座 1 的 you.active 窗口最迟 ≈12s，轮询预算 16s。
 *   人类座 1 为村民/夜亡者皆可命中：白天首个属于座 1 的行动（夜亡=last_words，存活=say）
 *   在间隙内轮询到 you.active=true 后立即 POST——必须被缓冲，回合开启时入账。
 * 修复前表现：视相位已推进、回合未开启 → 422 NOT_YOUR_TURN 的不一致窗口。
 * 运行：node --experimental-strip-types src/smoke-http-gap.ts
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "./gateway/http.ts";
import { createWerewolfLite } from "./games/werewolf-lite.ts";
import type { AgentView } from "./protocol.ts";

const PORT = 18799;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

// 独立临时数据文件：不读写真实持久化数据
const g = new Gateway(join(tmpdir(), `arena-gap-smoke-${process.pid}.json`));
g.registerGame(createWerewolfLite());
g.listen(PORT);

interface Resp {
  status: number;
  body: Record<string, unknown>;
}
async function api(path: string, init?: RequestInit): Promise<Resp> {
  const r = await fetch(BASE + path, init);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function main(): Promise<void> {
  // 0. 等服务就绪
  for (let i = 0; ; i++) {
    try {
      await fetch(BASE + "/games");
      break;
    } catch {
      if (i > 50) throw new Error("网关未就绪");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // 1. 重试 quickstart 直到人类是村民（每次 1/2 概率）
  let seatToken = "";
  let matchId = "";
  let tries = 0;
  for (;;) {
    tries++;
    if (tries > 12) throw new Error("12 次未抽到村民席位");
    const qs = await api("/lobby/quickstart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ game: "werewolf_lite", name: "gap-tester" }),
    });
    matchId = String(qs.body.match_id ?? "");
    seatToken = String(qs.body.seat_token ?? "");
    const v0 = await api("/matches/" + matchId + "/view", { headers: { "x-seat-token": seatToken } });
    const priv = v0.body.private as { role?: string };
    if (priv.role === "villager") break;
  }
  check("开局（人类为村民）", matchId !== "" && seatToken !== "", `尝试 ${tries} 次`);

  // 2. 间隙轮询：夜晚结算后 phase=day_discuss 且 you.active → 立即 POST
  //    r27-e：预算 16s——两步夜（密语步+出刀步）+ 夜亡 bot 遗言步，各步 4s 间隙
  const t0 = Date.now();
  let view: AgentView | null = null;
  while (Date.now() - t0 < 16000) {
    const v = await api("/matches/" + matchId + "/view", { headers: { "x-seat-token": seatToken } });
    view = v.body as unknown as AgentView;
    if (view.phase === "day_discuss" && view.you.active) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  check(
    "间隙内观测到新相位且 you.active=true",
    view?.phase === "day_discuss" && view?.you.active === true,
    `phase=${view?.phase ?? "?"}`,
  );
  // 防御：窗口耗尽未见活跃席位时干净收场（旧版此处 TypeError 掩盖真实失败原因）
  const legal = view?.legal_actions?.[0];
  if (!legal) {
    console.log(`\n=== 结果：${failed} 项失败（未进入座 1 行动窗口，跳过后续用例） ===`);
    process.exit(1);
  }

  // 3. 照法定动作提交（say 或 last_words——取决于座 1 是否夜亡），带 nonce 供幂等重放用例
  const action =
    legal.type === "last_words"
      ? { type: "last_words", text: "（间隙测试）遗言：信息给大家了。" }
      : { type: "say", text: "（间隙测试）我在相位间隙就提交了这番话。" };
  const post = await api("/matches/" + matchId + "/actions", {
    method: "POST",
    headers: { "x-seat-token": seatToken, "content-type": "application/json" },
    body: JSON.stringify({ action, nonce: "gap-nonce-1" }),
  });
  check(
    "间隙提交被接受（修复核心断言）",
    post.status === 200 && post.body.ok === true,
    `status=${post.status} err=${String(post.body?.error ?? "")}`,
  );

  // 4. 该发言最终入事件流
  const wantText = String((action as { text: string }).text);
  let landed = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 10000 && !landed) {
    const ev = await api("/matches/" + matchId + "/events?since=-1", {
      headers: { "x-seat-token": seatToken },
    });
    const events = ev.body.events as { type: string; data?: { text?: string } }[];
    landed = events.some(
      (e) => (e.type === "said" || e.type === "last_words") && e.data?.text === wantText,
    );
    if (!landed) await new Promise((r) => setTimeout(r, 300));
  }
  check("提前提交的动作最终入账", landed);

  // 5. 同回合重复提交被拒
  const dup = await api("/matches/" + matchId + "/actions", {
    method: "POST",
    headers: { "x-seat-token": seatToken, "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  check("同回合重复提交被拒", dup.status === 422, `code=${String(dup.body?.code ?? "")}`);

  // 6. nonce 幂等重放：跨回合同 nonce → 200 + replayed:true（网关重放缓存，绝不消耗新回合）
  const replay = await api("/matches/" + matchId + "/actions", {
    method: "POST",
    headers: { "x-seat-token": seatToken, "content-type": "application/json" },
    body: JSON.stringify({ action, nonce: "gap-nonce-1" }),
  });
  check(
    "跨回合 nonce 重试幂等成功（replayed）",
    replay.status === 200 && replay.body.ok === true && replay.body.replayed === true,
    `status=${replay.status} replayed=${String(replay.body?.replayed ?? "")}`,
  );

  // 7. 重放没有吞掉后续回合：seat 1 不应出现 timed_out（若有回合被吞，超时裁判会留痕）
  await new Promise((r) => setTimeout(r, 1200));
  const ev2 = await api("/matches/" + matchId + "/events?since=-1", {
    headers: { "x-seat-token": seatToken },
  });
  const swallows = (ev2.body.events as { type: string; data?: { seat?: number } }[]).filter(
    (e) => e.type === "timed_out" && e.data?.seat === 1,
  );
  check("重放未消耗任何回合（seat1 无 timed_out）", swallows.length === 0, `出现 ${swallows.length} 次`);

  console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
  process.exitCode = failed === 0 ? 0 : 1;
  process.exit(process.exitCode); // 网关常驻句柄不阻塞退出（后台对局随之结束）
}

main().catch((e) => {
  console.error("[smoke-http-gap] 异常：", e);
  process.exit(1);
});
