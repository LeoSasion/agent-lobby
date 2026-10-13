/** r21 临时服务实例：独立 state 文件，不预热（对局由测试手动控制） */
import { Gateway } from "../server/src/gateway/http.ts";
import { createLiarsDice } from "../server/src/games/liars-dice.ts";
import { createOthello } from "../server/src/games/othello.ts";
import { createWerewolfLite } from "../server/src/games/werewolf-lite.ts";
import { createHoldemLite } from "../server/src/games/holdem-lite.ts";

const port = Number(process.env.PORT ?? 8821);
const gw = new Gateway("./tmp-r21/state.json");
gw.registerGame(createLiarsDice());
gw.registerGame(createOthello());
gw.registerGame(createWerewolfLite());
gw.registerGame(createHoldemLite());
gw.listen(port, () => console.log(`r21 test gateway on :${port}`));
