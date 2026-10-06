/**
 * 最简参赛客户端（= 最简 SDK 雏形 · 通道 A 轮询模式）
 * 用法：node --experimental-strip-types src/cli/play.ts [base] [match_id] [seat_token]
 */

interface View {
  game: string;
  phase: string;
  round: number;
  you: { seat: number; active: boolean };
  legal_actions: { type: string; schema?: { values?: number[] } }[];
  public: {
    players?: { seat: number; dice_count: number }[];
    current_bid?: { seat: number; qty: number; face: number } | null;
    board?: number[];
    alive_seats?: number[];
  };
  private: {
    my_dice?: number[];
    role?: string;
    teammates?: number[];
    checks?: { target: number; is_wolf: boolean }[];
  };
}

const base = process.argv[2] ?? "http://localhost:8787";
const matchId = process.argv[3];
const token = process.argv[4];
if (!matchId || !token) {
  console.log("用法: node --experimental-strip-types src/cli/play.ts <base> <match_id> <seat_token>");
  process.exit(1);
}

const H = { "x-seat-token": token, "content-type": "application/json" };
const api = (p: string) => `${base}/api/v1${p}`;

async function getView(): Promise<View | null> {
  const r = await fetch(api(`/matches/${matchId}/view`), { headers: H });
  if (!r.ok) return null;
  return (await r.json()) as View;
}

/** 按游戏分派策略 */
function decide(v: View): Record<string, unknown> {
  if (v.game === "othello") return decideOthello(v);
  if (v.game === "werewolf_lite") return decideWerewolf(v);
  return decideDice(v);
}

/** 狼人杀：按角色出招（狼装民 / 预言家报查验 / 村民归票） */
function decideWerewolf(v: View): Record<string, unknown> {
  const role = v.private.role ?? "villager";
  const alive = v.public.alive_seats ?? [];
  const la = v.legal_actions;
  const values = (t: string): number[] => (la.find((a) => a.type === t)?.schema?.values ?? []);

  if (la.some((a) => a.type === "kill")) {
    const targets = values("kill");
    return targets.length ? { type: "kill", target: targets[0] } : { type: "pass" };
  }
  if (la.some((a) => a.type === "check")) {
    const checked = new Set((v.private.checks ?? []).map((c) => c.target));
    const t = values("check").find((x) => !checked.has(x));
    return t !== undefined ? { type: "check", target: t } : { type: "pass" };
  }
  if (la.some((a) => a.type === "say")) {
    if (role === "seer") {
      const cs = v.private.checks ?? [];
      const c = cs[cs.length - 1];
      return {
        type: "say",
        text: c ? `我是预言家，昨晚验了 ${c.target} 号，${c.is_wolf ? "是狼人！" : "是好人。"}` : "我是预言家，昨晚没验人。",
      };
    }
    return { type: "say", text: role === "werewolf" ? "我是个平民，先听大家怎么说。" : "我是好人，信息不多，谨慎投票。" };
  }
  if (la.some((a) => a.type === "vote")) {
    const me = v.you.seat;
    const mates = new Set(v.private.teammates ?? []);
    const targets = values("vote").filter((t) => t !== me);
    if (role === "werewolf") {
      const t = targets.find((x) => !mates.has(x));
      return t !== undefined ? { type: "vote", target: t } : { type: "pass" };
    }
    if (role === "seer") {
      const wolf = (v.private.checks ?? []).find((c) => c.is_wolf && alive.includes(c.target));
      if (wolf) return { type: "vote", target: wolf.target };
    }
    return targets.length ? { type: "vote", target: targets[(me + v.round) % targets.length] } : { type: "pass" };
  }
  return { type: "pass" };
}

/** 吹牛骰：评估当前叫价可信度，不可信则质疑，可信则最小加价 */
function decideDice(v: View): Record<string, unknown> {
  const my = v.private.my_dice ?? [];
  const total = (v.public.players ?? []).reduce((a, p) => a + p.dice_count, 0);
  const bid = v.public.current_bid ?? null;
  if (!bid) {
    return { type: "bid", qty: Math.max(1, Math.round((total / 6) * 0.7)), face: my[0] ?? 3 };
  }
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

/** 黑白棋：角 > 边 > 其他，平手取最小索引 */
function decideOthello(v: View): Record<string, unknown> {
  const place = v.legal_actions.find((a) => a.type === "place");
  const cells = place?.schema?.values ?? [];
  if (cells.length === 0) return { type: "pass" };
  const rank = (cell: number): number => {
    const r = Math.floor(cell / 8);
    const c = cell % 8;
    const corner = (r === 0 || r === 7) && (c === 0 || c === 7);
    const edge = r === 0 || r === 7 || c === 0 || c === 7;
    return corner ? 2 : edge ? 1 : 0;
  };
  let best = cells[0];
  let bestRank = -1;
  for (const cell of cells) {
    const rk = rank(cell);
    if (rk > bestRank) {
      bestRank = rk;
      best = cell;
    }
  }
  return { type: "place", cell: best };
}

async function post(action: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(api(`/matches/${matchId}/actions`), {
    method: "POST",
    headers: H,
    body: JSON.stringify({ action }),
  });
  return (await r.json()) as { ok: boolean; error?: string };
}

console.log(`参赛中：match=${matchId}`);
for (;;) {
  const v = await getView();
  if (!v) {
    console.log("对局不存在");
    process.exit(1);
  }
  if (v.phase === "finished") {
    const rep = (await (await fetch(api(`/matches/${matchId}/replay`), { headers: H })).json()) as {
      scores: Record<string, number> | null;
    };
    console.log("对局结束 · 分数:", JSON.stringify(rep.scores));
    process.exit(0);
  }
  if (v.you.active) {
    const action = decide(v);
    const r = await post(action);
    console.log(`  [第${v.round}轮] 我方出招 ${JSON.stringify(action)} ${r.ok ? "OK" : "被拒(" + (r.error ?? "?") + ")"}`);
    if (!r.ok && action.type === "bid") await post({ type: "challenge" });
  } else {
    await new Promise((r) => setTimeout(r, 200));
  }
}
