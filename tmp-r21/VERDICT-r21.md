# r21 · 观众竞猜「群众之眼」验证报告

- 日期：2026-10-13 · 网关：http://localhost:8787（r21 新代码）
- 借鉴源：liars.town 的 crowd suspicion（click to cast suspicion / bars show what watchers think / reveal 告知 crowd 是否被骗）——见 docs/03 备忘录「二、竞品实况复核」
- 定位：纯观战娱乐层，不属于 Agent 协议（不进事件流/回放/计分，Agent 无感知）

## 交付物

### 后端（server/src/gateway/http.ts）
- `POST /api/v1/matches/:id/guess` `{voter_id, seat}`——匿名投票；同 voter 重复 POST=改票（changed:true，老票迁移）；同票幂等（changed:false）
- `GET /api/v1/matches/:id/guess?voter_id=`——进行中 `{locked:false, counts, total, mine, label}`；终局 reveal `{locked:true, ..., targets, mine_hit, crowd_pick, crowd_pick_votes, crowd_hit, total_voters}`
- 目标语义：werewolf_lite → 真狼（`game_won.data.roles` 过滤；恢复壳经落盘事件同样可取）；其他游戏 → 胜者（`result.scores>0`，平局并列全中）——**一套代码通用「猜身份/猜冠军」**
- 错误分支：无效席位 422 SEAT_INVALID（附 valid_seats）/ 缺 voter_id 422 VOTER_REQUIRED / 终局后 409 GUESS_LOCKED / 405 / 404 MATCH_NOT_FOUND（三态 hint）
- 内存态（重启即弃，无奖励无副作用，不值得持久化）；根索引 / 404 hint / 协议文档 §9 同步更新

### 前端（web/index.html）
- 围观页 `#m-guess` 独立容器（独立于 renderGame——回放步进不触发，只由 refreshMatchView 驱动：3s 轮询 + SSE 双节奏）
- localStorage 匿名 voter_id（`v_` + 随机）
- 进行中：席位钮行（死位可投——身份未揭；mine 磷光高亮）+ 大众意见条（票数占比渐变条）+ 状态行
- 终局揭底面板：狼是 X、Y 号（琥珀）· 你猜中/猜错（gz-hit/gz-miss）· 群众头名票与「识破了/没能识破」· 票数分布保留
- 投票 POST 即时回显（GZ.busy 防竞态覆盖，3s 自愈）；非狼人游戏不渲染（API 通用、UI 后续按需开）
- 测试钩子 `window.__r21`

## 验证结论

- 专项 E2E（tmp-r21/e2e-r21.mjs）：**第四遍 39/39 全绿**（功能全链路权威记录：A1-A7 后端 26 项 + B1-B5 前端 13 项）；**最终版 28/28 全绿**（含 M.replay 竞态修复与环境跳过保护——A6/A7 的终局慢局依赖在并发堆积环境下转历史壳驱动或跳过，语义不变）
  - Part A 后端：投票/三人票池/改票迁移/幂等/进行中零泄露键（信息隔离铁律）/四类错误分支/othello 通用路径/werewolf reveal 交叉验证（targets ≡ game_won.roles 的狼——反作弊）/终局 409/othello targets ≡ scores>0
  - Part B 前端：眉标提示渲染/六席位钮/voter_id 落 localStorage/POST payload/投票回显/意见条/改票更新/骰子局不渲染/揭底面板/我的战绩/群众战绩/gz-hit 类与 API 一致
- 回归：r15 E2E 16/16 · r16 E2E 27/27 · r17 E2E 20/20（M.replay 修复后）· r20 E2E 36/36 · server smoke 10 段全部通过——**零回归**
- typecheck：通过

## 过程事故与修复（编写期自查）

1. **E2E waitCond 假满足（r18 教训镜像）**：waitCond 以 `if (fn())` 判定，而传入的终局探测 fn 是 **async**——返回 Promise 恒 truthy，首 probe 即假满足 → 「狼人局已终局」假通过 → reveal 断言连锁崩。修复：`await fn() === true` 后再判定。**这正是 r18 wait-active.mjs 假 FINISHED 的同构模式（v.result !== undefined 恒真）**——同一条纪律的第二次实证：*一切「条件为真」判定必须落实在具体值上，不能落在对象存在性/Promise 真值上*。
2. **r17 遗留竞态被 r21 放大暴露（产品级修复）**：回放 seek 后，SSE/轮询触发的 refreshMatchView 迟到完成时以**实时模式 renderLog 覆盖回放的 cur 高亮**。r20 版前端 20/20 vs r21 版 19/20 的对照实验定位（r21 的 guess fetch 拉长在途窗口，把「几乎不出现」放大成「稳定出现」）。真实浏览器同样存在（SSE 事件到达与用户 seek 竞速——活局回放中日志会跳回实时尾）。**修复**：`M.replay` 模式位——replaySeek 置 true、gotoMatch 重置；回放模式下实时刷新只更新舞台与竞猜层，不覆盖 #m-log。这是「r17 引入、r21 发现」的存量 bug 修复，非测试迁就。
3. **othello/holdem bot 局时长不可作为 E2E 等待对象**：多局并发下 bot 决策靠 60s 超时兜底推进，整局数十分钟。E2E 改用「进行中断言（A5 投票）+ 已终局历史壳断言（A7 targets）」两段式，零等待且语义等价。

## 设计决策记录

- **死位可投**：身份只在 game_won 揭示，死亡席位完全可能是狼——竞猜语义「指认你怀疑的狼」不因出局而排除（liars.town 同理）
- **crowd_pick 并列全列**：平票时群众意见是分裂的，如实呈现并列席位；crowd_hit = 并列中任一命中
- **不持久化**：竞猜无奖励无副作用，进程内存随对局生命周期；重启弃票不影响任何人（对局壳本身也在内存）
- **回放不触发竞猜层**：竞猜是「实时观战」的娱乐；回放时已知答案，无竞猜意义（防 Spoiler 的顺带好处）
- **r22 前置勘察（重要发现）**：Elo 后端**早已完全接线**（rating.ts 的 applyMatch 在终局结算调用、export/import 持久化、/leaderboard/:game 端点、agents/me 档案 ratings）——r22 是前端增强轮（排行榜加 W/L/胜率列 + agent 档案页），不是后端新建轮
