/**
 * 用 SDK 认真打 N 局吹牛骰，记录全程 + 终局战绩
 * 运行：node --experimental-strip-types tmp-r4/play.ts [局数]
 */
import { ArenaClient } from "../server/src/sdk/index.ts";
import { decide, type LDView } from "./strategy.ts";

const N = Number(process.argv[2] ?? 2);
const client = new ArenaClient("http://localhost:8787");

interface GameSummary {
  matchId: string;
  mySeat: number;
  myDiceLeft: number;
  resultScores: Record<string, number>;
  rank: string;
  win: boolean;
  rounds: number;
  actions: number;
  challenges: { by_me: number; against_me: number };
}

const summaries: GameSummary[] = [];

for (let g = 1; g <= N; g++) {
  console.log(`\n========== 第 ${g} 局 ==========`);
  const match = await client.quickstart({ game: "liars_dice", seats: 3, name: "tester-dice-r4" });
  console.log(`match_id=${match.matchId} seat=${1} agent=${match.agentId}`);

  let iter = 0;
  let acts = 0;
  let finishedView: LDView | null = null;
  const t0 = Date.now();
  const gapLog: number[] = [];
  let lastT = t0;

  for await (const raw of match.views(1000)) {
    const v = raw as unknown as LDView;
    iter++;
    const now = Date.now();
    if (iter > 1) gapLog.push(now - lastT);
    lastT = now;

    if (v.phase === "finished") {
      console.log(`[iter ${iter}] phase=finished（终局视图已收到）| 结束视图处 match.result 就绪=${match.result !== null}`);
      finishedView = v;
      break;
    }
    if (!v.you.active) continue;

    const myDiceLeft = v.public.players.find((p) => p.seat === v.you.seat)?.dice_count;
    const bidStr = v.public.current_bid ? `${v.public.current_bid.qty}×${v.public.current_bid.face}@${v.public.current_bid.seat}` : "无";
    const { action, reasoning } = decide(v);
    const nonce = `${match.matchId}-${g}-${acts}`;
    const r = await match.act(action, { reasoning, nonce });
    acts++;
    console.log(
      `  [回合 r${v.public.round}] 我骰=${JSON.stringify(v.private.my_dice)} 剩${myDiceLeft} 当前叫价=${bidStr} → ${JSON.stringify(action)} | ok=${r.ok}${r.ok ? "" : ` code=${r.code} err=${r.error}`}`,
    );
    if (!r.ok) console.log(`     !! 提交被拒，legal=${JSON.stringify(r.view?.legal_actions ?? [])}`);
  }

  const elapsed = Date.now() - t0;
  const result = match.result;
  const scores = (result?.scores ?? {}) as Record<string, number>;
  const seatScores = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const mySeat = 1;
  const myScore = scores[mySeat] ?? 0;
  const rankIdx = seatScores.findIndex(([s]) => Number(s) === mySeat);
  const myDiceLeft = finishedView ? (finishedView.public.players.find((p) => p.seat === mySeat)?.dice_count ?? 0) : 0;

  console.log(`—— 终局 —— 用时 ${(elapsed / 1000).toFixed(1)}s 轮数=${finishedView?.public.round} 迭代=${iter} 出招=${acts}`);
  console.log(`  scores=${JSON.stringify(scores)} 我的分数=${myScore} 名次=${rankIdx + 1}/${seatScores.length} 我剩骰=${myDiceLeft}`);
  console.log(`  result.events=${result?.events?.length ?? "null"} 轮询间隔样本(ms)=${gapLog.slice(0, 12).join(",")}`);

  summaries.push({
    matchId: match.matchId,
    mySeat,
    myDiceLeft,
    resultScores: scores,
    rank: `${rankIdx + 1}/${seatScores.length}`,
    win: myScore >= 0.99,
    rounds: finishedView?.public.round ?? -1,
    actions: acts,
    challenges: { by_me: 0, against_me: 0 },
  });
}

console.log(`\n========== 总战绩 ==========`);
for (const s of summaries) {
  console.log(`${s.matchId} | 名次 ${s.rank} | ${s.win ? "胜" : "负"} | 剩骰 ${s.myDiceLeft} | 轮 ${s.rounds} | 分数 ${JSON.stringify(s.resultScores)}`);
}
console.log(JSON.stringify(summaries));
