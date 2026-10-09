/**
 * 冒烟测试：持久化与重启恢复（r9 自查 P1 修复回归）
 * 缺陷回顾：
 *   ① RestoredMatch.isFinished() 恒 false（私有字段仅 run()/fail() 置 true，恢复壳从不 run）
 *     → replay/events 报 finished:false、scores:null
 *   ② persistState() 以 isFinished() 过滤 → 恢复壳被排除在下次落盘外
 *     → 历史对局每重启一代静默丢失一代（复利丢失）
 *   ③ 恢复壳无事件时 replay/step 喂空事件给 replayToState 会 throw → 500
 * 修复：RestoredMatch 覆写 isFinished/rawEvents/eventsFor/currentResult 透传落盘数据；
 *       persistState 落盘全量事件 + 终局比分；空事件 replay/step 显式 410 REPLAY_UNAVAILABLE。
 * 运行：node --experimental-strip-types src/smoke-persist.ts
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { Gateway } from "./gateway/http.ts";

const PORT_1 = 18810;
const PORT_2 = 18811;
const PORT_3 = 18812;
const PORT_4 = 18813;

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const tag = ok ? "[OK]  " : "[FAIL]";
  if (!ok) failed++;
  console.log(`  ${tag} ${name}${detail ? " — " + detail : ""}`);
}

const dataFile = join(tmpdir(), `arena-persist-smoke-${process.pid}.json`);
const oldFmtFile = join(tmpdir(), `arena-persist-oldfmt-${process.pid}.json`);

interface Resp {
  status: number;
  body: Record<string, unknown>;
}
async function api(base: string, path: string, init?: RequestInit): Promise<Resp> {
  const r = await fetch(base + path, init);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function waitReady(base: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fetch(base + "/games");
      return;
    } catch {
      if (i > 100) throw new Error("网关未就绪");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** 等待 loadState 完成（构造器内异步）：轮询目标 match 的 replay 直至出现或超时 */
async function waitRestored(base: string, matchId: string): Promise<Resp | null> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/matches/${matchId}/replay`);
      if (r.status === 200) return { status: r.status, body: (await r.json()) as Record<string, unknown> };
      if (r.status === 404) {
        // 状态尚未载入，等一拍再试
      }
    } catch { /* 网关未就绪 */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function main(): Promise<void> {
  // —— 第 1 幕：跑一局双真人黑白棋（含 reasoning 的一手），落盘 ——
  const g1 = new Gateway(dataFile);
  g1.registerGame((await import("./games/othello.ts")).createOthello());
  g1.registerGame((await import("./games/liars-dice.ts")).createLiarsDice());
  g1.registerGame((await import("./games/holdem-lite.ts")).createHoldemLite());
  g1.listen(PORT_1);
  const B1 = `http://127.0.0.1:${PORT_1}/api/v1`;
  await waitReady(B1);

  console.log("\n[第 1 幕] 完整对局 + 显式落盘");
  const cr = await api(B1, "/lobby/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ game: "othello", name: "persist-host" }),
  });
  const roomId = String(cr.body.room_id);
  const hostToken = String(cr.body.join_token);
  const j2 = await api(B1, `/lobby/rooms/${roomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "persist-guest" }),
  });
  const s1 = await api(B1, `/lobby/rooms/${roomId}?token=${hostToken}`);
  const s2 = await api(B1, `/lobby/rooms/${roomId}?token=${String(j2.body.join_token)}`);
  const st: Record<number, string> = { 1: String(s1.body.seat_token), 2: String(s2.body.seat_token) };
  const matchId = String(s1.body.match_id);

  let finished = false;
  let moves = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    let allDone = true;
    for (const seat of [1, 2]) {
      const v = await api(B1, `/matches/${matchId}/view`, { headers: { "x-seat-token": st[seat]! } });
      const view = v.body as { phase?: string; you?: { active?: boolean }; legal_actions?: { type: string; schema?: { values?: number[] } }[] };
      if (view.phase === "finished") continue;
      allDone = false;
      if (view.you?.active !== true) continue;
      const la = view.legal_actions?.[0];
      const action = la?.type === "place" ? { type: "place", cell: la.schema?.values?.[0] } : { type: "pass" };
      // 第一手带 reasoning：终局公开语义跨重启回归（恢复壳 finished=true → 不脱敏）
      const body = moves === 0 && seat === 1
        ? { action, reasoning: "开局占角思路（持久化回归用）" }
        : { action };
      const r = await api(B1, `/matches/${matchId}/actions`, {
        method: "POST",
        headers: { "x-seat-token": st[seat]!, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.status === 200) moves++;
    }
    if (allDone) {
      finished = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  check("对局完整收官", finished, `${moves} 手 · ${Date.now() - t0}ms`);

  const pre = await api(B1, `/matches/${matchId}/replay`);
  const preEvents = pre.body.events as { seq: number; type: string; data?: Record<string, unknown> }[];
  const preScores = JSON.stringify(pre.body.scores);
  check("落盘前：replay 事件非空 + 比分在", preEvents.length > 0 && preScores !== "null", `${preEvents.length} 事件`);
  await g1.persistState();
  check("显式 persistState 完成", true, "");

  // —— 第 2 幕：同文件新网关（模拟重启），恢复壳必须可回放 ——
  console.log("\n[第 2 幕] 重启恢复 · replay 完整性");
  const g2 = new Gateway(dataFile);
  g2.registerGame((await import("./games/othello.ts")).createOthello());
  g2.registerGame((await import("./games/liars-dice.ts")).createLiarsDice());
  g2.registerGame((await import("./games/holdem-lite.ts")).createHoldemLite());
  g2.listen(PORT_2);
  const B2 = `http://127.0.0.1:${PORT_2}/api/v1`;
  await waitReady(B2);

  const restored = await waitRestored(B2, matchId);
  check("恢复壳出现在新网关", restored !== null, "");
  if (!restored) {
    console.log(`\n=== 结果：${failed} 项失败（提前终止） ===`);
    process.exit(1);
  }
  check("恢复壳 finished=true（修复①）", restored.body.finished === true, `finished=${String(restored.body.finished)}`);
  check("恢复壳事件数与落盘前一致", (restored.body.events as unknown[]).length === preEvents.length, `${(restored.body.events as unknown[]).length} 事件`);
  check("恢复壳比分与落盘前一致", JSON.stringify(restored.body.scores) === preScores, String(restored.body.scores));

  const evs2 = await api(B2, `/matches/${matchId}/events`);
  check("events 端点 finished=true", evs2.body.finished === true, `finished=${String(evs2.body.finished)}`);

  // reasoning 终局公开：观战视角（无 token）能看到恢复壳 acted.reasoning
  const specReasoning = (restored.body.events as { type: string; data?: { reasoning?: string } }[])
    .filter((e) => e.type === "acted")
    .some((e) => typeof e.data?.reasoning === "string" && (e.data.reasoning as string).includes("占角"));
  check("恢复壳 acted.reasoning 终局公开（观战可读）", specReasoning, "");

  // replay/step：观战模式重放到底 → phase=finished 且 result 与落盘比分一致（真实重放，非空壳）
  const lastSeq = preEvents[preEvents.length - 1]!.seq;
  const step = await api(B2, `/matches/${matchId}/replay/step?to=${lastSeq}`);
  const stepView = step.body.view as { phase?: string; result?: { scores?: Record<string, number> } | null } | undefined;
  check(
    "replay/step 观战重放到底 → finished + 比分一致",
    step.status === 200 && stepView?.phase === "finished" && JSON.stringify(stepView?.result?.scores ?? null) === preScores,
    `phase=${String(stepView?.phase)}`,
  );

  // replay/step 视角鉴权：恢复壳 seatTokens 恒空 → 403（r8 P0 安全默认不回退）
  const seatStep = await api(B2, `/matches/${matchId}/replay/step?seat=1`);
  check("恢复壳 replay/step?seat=1 → 403 SEAT_INVALID", seatStep.status === 403 && String(seatStep.body.error).startsWith("SEAT_INVALID"), `code=${String(seatStep.body.error ?? "").slice(0, 16)}`);

  // —— 第 3 幕：复利丢失回归——二次落盘 + 三次恢复，历史必须仍在 ——
  console.log("\n[第 3 幕] 复利丢失回归（修复②）");
  await g2.persistState();
  const g3 = new Gateway(dataFile);
  g3.registerGame((await import("./games/othello.ts")).createOthello());
  g3.registerGame((await import("./games/liars-dice.ts")).createLiarsDice());
  g3.registerGame((await import("./games/holdem-lite.ts")).createHoldemLite());
  g3.listen(PORT_3);
  const B3 = `http://127.0.0.1:${PORT_3}/api/v1`;
  await waitReady(B3);
  const again = await waitRestored(B3, matchId);
  check("二次重启后对局仍在（不再被落盘过滤丢弃）", again !== null, "");
  if (again) {
    check(
      "二次恢复事件与比分完整",
      (again.body.events as unknown[]).length === preEvents.length && JSON.stringify(again.body.scores) === preScores,
      `${(again.body.events as unknown[]).length} 事件`,
    );
  }

  // —— 第 4 幕：旧版状态文件（无 events/scores 字段）优雅降级 ——
  console.log("\n[第 4 幕] 旧格式状态文件 · 优雅降级（修复③）");
  await writeFile(
    oldFmtFile,
    JSON.stringify({
      saved_at: new Date().toISOString(),
      ratings: {},
      agents: {},
      agentNames: {},
      matches: [
        { match_id: "m_oldfmt", game: "othello", started_at: 1_700_000_000_000, headline: null, seats: { "1": "old-a", "2": "old-b" } },
      ],
    }),
    "utf8",
  );
  const g4 = new Gateway(oldFmtFile);
  g4.registerGame((await import("./games/othello.ts")).createOthello());
  g4.registerGame((await import("./games/liars-dice.ts")).createLiarsDice());
  g4.registerGame((await import("./games/holdem-lite.ts")).createHoldemLite());
  g4.listen(PORT_4);
  const B4 = `http://127.0.0.1:${PORT_4}/api/v1`;
  await waitReady(B4);
  const old = await waitRestored(B4, "m_oldfmt");
  check("旧格式恢复壳存在", old !== null, "");
  if (old) {
    check("旧格式 finished=true + 空 events + scores=null", old.body.finished === true && (old.body.events as unknown[]).length === 0 && old.body.scores === null, "");
    const oldStep = await api(B4, "/matches/m_oldfmt/replay/step");
    check(
      "旧格式 replay/step → 410 REPLAY_UNAVAILABLE（不再 500）",
      oldStep.status === 410 && String(oldStep.body.error).startsWith("REPLAY_UNAVAILABLE"),
      `status=${oldStep.status} · code=${String(oldStep.body.error ?? "").slice(0, 20)}`,
    );
  }

  console.log(`\n=== 结果：${failed === 0 ? "全部通过" : failed + " 项失败"} ===`);
  process.exitCode = failed === 0 ? 0 : 1;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error("[smoke-persist] 异常：", e);
  process.exit(1);
});
