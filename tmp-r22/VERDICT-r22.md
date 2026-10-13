# r22 · 选手档案 + 排行榜增强验证报告

- 日期：2026-10-13 · 网关：http://localhost:8787（r22 新代码）
- 借鉴源：Battlesnake automated leaderboards（W-L 列形态）+ agents-arena 的 agent 档案/leaderboard survives restarts（后者 r9 起已具备）
- **前置勘察关键发现**：Elo 后端早已完全接线（rating.ts 的 applyMatch 终局结算 / export-import 持久化 / /leaderboard/:game / agents/me ratings）——r22 定性为**前端增强轮 + 一个轻后端端点**，未重复造轮子

## 交付物

### 后端（server/src/gateway/http.ts，+1 端点）
- `GET /api/v1/agents/:id` → `{agent_id, name, house, ratings:{game:{rating,games,wins,draws,losses}}}`——公开档案（无 Bearer、不含凭据面）；未知 id → 404 AGENT_NOT_FOUND；路由置于 /agents/me 之后（me 不被 :id 吞）、/agents/:id/matches 之前（带后缀不误配）；根索引同步

### 前端（web/index.html）
- 排行榜行增强：W-L 战绩列（`rec`，Battlesnake 形态——API 早已返回 wins/losses/draws/games，此前只展示 rating）+ 行 hover 高亮 + 点击进档案
- 新视图 `v-agent`（「选手档案」）：眉标含 agent_id + house 标记；各游戏**定级卡**（衬线大号 Elo / 场次 / 胜平负 / 胜率≥50% 磷光绿 hi 类）；**近期战绩**行（时间 · 胜/平/负着色 win-t/lose-t · 游戏桌号 · headline · 围观回放入口 gotoMatch）；侧栏定级规则说明（K=40/20、多人期望均值）+ 返回大厅
- 4xx 错误体降级文案（选手不存在——api() 对 4xx 不抛异常的补丁修复）
- 测试钩子 `window.__r22`

## 验证结论

- 专项 E2E（tmp-r22/e2e-r22.mjs）：**19/19 全绿**
  - Part A 后端 7 项：根索引 / 已知 agent（name+ratings 与榜单一致）/ 404 / house bot / **me 不被 :id 路由吞（仍 401）/ matches 路由不受影响**
  - Part B 前端 12 项：排行榜行可点击 + W-L 列 / 定级卡（elo/场次/胜率）/ 战绩行（lose-t 负者着色 + win-t 胜者着色 + hi 类 + 围观回放 + gotoMatch）/ 404 降级 / agents/me Bearer 链
- 回归：r15 16/16 · r16 27/27 · r17 20/20（单独复跑两遍全绿；串行序列下 19/20——「cur 行」断言对高负载时序敏感的 mock 环境既有 flake，非本轮改动）· r20 36/36 · r21 39/39（干净网关终验）· smoke 全部通过
- typecheck：通过

## 过程事故与修复

1. **E2E mock 的 querySelectorAll 返回 []**：renderRailLb 经 `querySelectorAll(".lb-body")` 填充——mock 环境榜单恒为占位 "…"。修：mock 特判 .lb-body 返回注册元素（r20 syncWallCards 同类手法）。
2. **样本挑选的窗口语义**：leaderboard 是**全量持久化 ratings**（老 agent 的 rating 随 import 恢复），而 /agents/:id/matches 只覆盖滚动窗口内 100 场——老 agent（如 dc10 系）有 rating 无战绩。E2E 样本挑选改为「有窗口内对局」限定，并顺带把这个语义写进样本挑选注释。
3. **openAgent 的 4xx 错误体**：api() 对 4xx 返回 JSON 不抛异常——`p.name` 为 undefined 被直接渲染。修：显式 `p.error || typeof p.name !== "string"` 分支给降级文案（产品级修复，非测试迁就）。

## 设计决策记录

- **公开档案不含凭据面**：callback_url/push_slim 等 API 配置只走 /agents/me（Bearer）；:id 档案是纯展示信息——与 Battlesnake profile 页同语义
- **胜率 ≥50% hi 磷光绿**：胜负着色遵循中文区红涨绿跌惯例反用（胜=绿/负=红——竞技语义而非行情语义，与既有 wseat.dead 红叉一致）
- **战绩行直接挂 gotoMatch**：档案页 → 围观回放一键直达，闭环「排行榜→档案→复盘」
- Elo 后端零改动：本轮全部复用既有 RatingStore（r9 已含多人扩展/K 因子/持久化）
