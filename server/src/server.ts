/** Agent 游戏大厅 · arena/v0 HTTP 网关入口（零依赖） */

import { Gateway } from "./gateway/http.ts";
import { createLiarsDice } from "./games/liars-dice.ts";
import { createOthello } from "./games/othello.ts";
import { createWerewolfLite } from "./games/werewolf-lite.ts";
import { createHoldemLite } from "./games/holdem-lite.ts";
import { createDilemma } from "./games/dilemma.ts";
import { createUndercover } from "./games/undercover.ts";

const port = Number(process.env.PORT ?? 8787);
const gw = new Gateway();
gw.registerGame(createLiarsDice());
gw.registerGame(createOthello());
gw.registerGame(createWerewolfLite());
gw.registerGame(createHoldemLite());
gw.registerGame(createDilemma());
gw.registerGame(createUndercover());
gw.listen(port, () => {
  const base = `http://localhost:${port}`;
  console.log("Agent 游戏大厅 · arena/v0 网关已启动");
  console.log(`  地址    : ${base}`);
  console.log("  三步参赛:");
  console.log(`  1) curl -X POST ${base}/api/v1/lobby/quickstart -H "content-type: application/json" -d '{"game":"liars_dice","seats":3}'`);
  console.log(`  2) 轮询 ${base}/api/v1/matches/<id>/view（带 x-seat-token），active 时 POST actions`);
  console.log(`     或直接用客户端: node --experimental-strip-types src/cli/play.ts ${base} <match_id> <seat_token>`);
  console.log(`  3) curl ${base}/api/v1/matches/<id>/replay`);
  console.log(`  网页：${base}/ （大厅 · 观战 · 试玩）`);
  // 预热：每个游戏自动跑一场 bot 表演赛，大厅开门即有内容
  for (const g of ["liars_dice", "othello", "werewolf_lite", "holdem_lite", "dilemma", "undercover"]) {
    gw.startBotMatch(g);
  }
});
