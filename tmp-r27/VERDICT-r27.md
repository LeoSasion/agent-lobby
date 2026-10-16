# VERDICT · r27 闭环优化轮

**日期**：2026-10-16 · **性质**：backlog 清障 + 可视化主线续作 + 计划外 P0 修复
**提交**：（见 git log · r27）

## 交付四项 + 计划外 P0 一项

| # | 项 | 层 | 内容 |
|---|---|---|---|
| r27-a | 狼队密语频率限制 | 引擎 | 每狼每夜 ≤5 条（validate 级；QPS 兜底之外的引擎级防线）；smoke 场景 5 第 6 条被拒+队友不受影响 |
| r27-b | 大厅级金句轮播带 | 前端 | 「金 句 频 道」带（直播墙标题下）：跨桌聚合 commentate hot≥2 金句，新句插队置顶、4.2s 轮播环回、点击跳桌、容量 12、同句去抖；暖场文案冷启动兜底。纯前端零服务端改动（复用 SSE/轮询喂流） |
| r27-c | holdem runout 补发 phase_started | 引擎 | runoutRest 用 NEXT map 循环补发 flop/turn/river 全街相位（此前单 apply 连发多街直抵 finished，内核 announcePhase 只见终态——全街相位丢失）。smoke 双断言：正常局 344 相位 0 重复（不与内核双发）+ runout 手相位完整 |
| r27-d | undercover 平票 PK 两轮制 | 引擎+前端+文档 | State 加 pkRound（0/1/2）：首轮平票→PK1；PK1 再平→PK2（候选收敛为本次平票者）；PK2 再平→无人出局进下一轮。vote_pk 带 pk_round；view 加 pk_round；evText/解说词典（PK2 升 hot2）/renderUndercover（「再平无人出局」警示）三消费面；协议 §7.6 去「v0 简化」标注。**顺手勘误**：checkWin 的 `round > 3` 在 round 自增前调用——要打到第 4 轮才终局，改 `>= 3` 恰在第 3 轮投票结算收口（与「3 轮上限」文档对齐） |
| r27-e | **幻影遗言 P0（计划外）** | 内核+引擎+冒烟 | 详见下节 |

## r27-e · 幻影遗言缺陷链（P0，测试暴露的产品级正确性缺陷）

**发现路径**：全套链 smoke-http-gap 连败两次 → 探针时间线 + 单元级事件 dump 定位 → stash 验证 HEAD 也受累（r26 起即有的 ~40% 概率 flake，r26 全链通过 = 幻影掩盖 + 运气）。

**缺陷链**（三因合谋）：
1. r26-b 两步夜（狼先 wolf_say 声明后 kill）让夜间横跨多个 step；内核每 step 清空 `received` → **已交 check 的预言家在第二步被重复驱动重交 check**；
2. 第二步同批 apply 循环内，先手狼的 kill 收齐即结算推进相位到 day_discuss → 预言家这份**陈旧 check 落进遗言分支**（apply 不校验发言权）→ 空文本「幻影遗言」入流，**吞掉夜亡者真遗言**（遗言是狼人杀核心社交推理特性——r26 起所有 quickstart 局夜亡者全部失声）；
3. `eventVisibility` 在循环内逐席位计算，后手席位看到已被先手推进的相位 → **预言家 check 目标以 all 可见性写库**（验人目标全场可见——竞技公平性缺陷）。

**冒烟表现**：刀口=人类 1 号时（seat 2 ∈ 狼队 → 声明目标恒 1 号，~40% 概率）人类遗言被吞 → you.active 永不出现 → smoke-http-gap 失败 + TypeError 崩溃；刀口=bot 时反而**因幻影吞掉遗言让 seat 1 提前一个间隙位活跃而侥幸通过**——bug 掩盖 bug。

**修复**：
- `werewolf-lite activeSeats/legalActions`：夜间已交行动者退出活跃集与法表（you.active=false；重复 POST 拒 NOT_YOUR_TURN）——结构性消灭「同批后手席位」：收齐结算恒发生在本批最后一个 apply；
- `match.ts`：acted 可见性**批次前统一裁定**（visBatch 快照）——同时相位批次共享提交时相位，防御纵深对全体游戏生效（现行为零变化：无中段突变即等价）；
- `smoke-http-gap`：轮询窗口 6000→16000（两步夜+遗言步的间隙链预算 ≈12s）+ 窗口耗尽干净收场（不再 TypeError 掩盖真因）；
- `smoke-werewolf 场景 6`：多 seed（24 局）扫描三不变量——last_words 恒非空 / 夜亡者（对局继续时）必有遗言 / kill-check acted 恒非 all。**注意 seed 6666（场景 1.5 的 P0 脱敏断言）恰好没踩中幻影排布**——golden seed 盲区的实证，多 seed 扫描是补法。

**回放兼容性**：replayEvents 逐 acted 原样重放（不经 validate/activeSeats）——旧对局流（含幻影）重放保真，新对局流干净；未加 apply 侧发言权守卫正是为此（守卫会使旧流回放发散）。

## 验证矩阵

- `npm test` 13 段全绿（typecheck + 12 smoke）——其中 smoke-undercover 28 项（场景 F 两轮制 8 项 + 场景 G 候选收敛 4 项）、smoke-werewolf 场景 5 加限频断言 + 场景 6 三不变量、smoke-holdem runout 双断言、smoke-gap 16s 窗口
- smoke-http-gap 连跑 **7 遍全过**（修复前 ~40% 失败率）
- r27 专项 E2E `tmp-r27/e2e-r27.mjs` **25 项两遍全绿**：A 幻影遗言 live 回归（真 bot 局四断言）/ B PK 两轮制渲染（evText+解说+圆桌三面+狼人杀兼容）/ C 金句频道（渲染/去抖/置顶/轮播环回/容量/hot 阈值集成）/ D 密语 5 条上限 live（抽狼席位逐条发+第 6 条 422）
- 全套回归九项：r15(13)+r16(27)+r17(20)+r20(36)+r21(28)+r22(19)+r23(10)+r25(31)+r26(18) = **202 断言全绿**——r26 A 部（狼队密语后端隔离）在新活跃集语义下不受影响

## 教训沉淀

1. **「测试通过」≠「行为正确」**：幻影遗言让 smoke-gap 在 bot 刀口下*因*缺陷而通过——缺陷互补 masking；一个 ~40% 概率的 flake 背后可能是 100% 概率的产品缺陷（r26 起夜亡者全失声）。
2. **golden seed 盲区**：场景 1.5 的脱敏断言只在 seed 6666 上跑，恰未踩中「预言家座位>狼」的幻影排布——结构性缺陷须多 seed 扫描或多排布构造。
3. **事件顺序即证据**：`player_died` 先于 `acted@6` 的顺序违反「acted 先于其 apply 产物」的内核不变量——读事件流顺序能直接定位「结算发生在谁的 apply 内」。
4. **修复选择要顾及回放保真**：apply 侧发言权守卫会令存量流回放发散——权限语义放 activeSeats/legalActions（驱动面）而非 apply（重放面）。
5. minPhaseMs 是 per-step 而非 per-phase——多步相位（两步夜）的时间预算要按步数×间隙计，测试窗口留足。

## backlog 清账

- ✅ 狼队密语频率限制（QPS 兜底→引擎级 5 条/夜）
- ✅ holdem runout 漏发 phase_started
- ✅ undercover 平票 PK 两轮制（v0 简化标注移除）
- ✅ 大厅级金句轮播带（r26-c 后续候选）
- 遗留：多桌 SSE 并发聚合端点（服务端聚合，候选）；api_key 身份代用（P1）等见 MEMORY backlog 节
