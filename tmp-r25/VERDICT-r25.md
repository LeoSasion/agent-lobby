# r25 · 谁是卧底（undercover）——VERDICT

> 双游戏轮（r24 囚徒困境 + r25 谁是卧底）主菜。r24 已于本日先行提交（5ae8461）。
> 定位：社交推理经典 · 中文国民游戏——MVP 第六游戏。零 LLM 依赖（平台唯二例外仍是 house bot 与 AI 解说位）。

## 一、交付物

| 层 | 文件 | 说明 |
|---|---|---|
| 引擎 | `server/src/games/undercover.ts`（~300 行） | 6 席 1 卧底 5 平民；词对库 20 对（带类别）；3 轮 describe→vote 循环；平票 PK 同构狼人杀；放逐亮身份；胜负=放逐卧底/存活≤3/3 轮打完；`word_assigned` 逐席位私有；超时默认 describe 代发文案 / vote 弃票（绝不代投）；scores 阵营口径 |
| Bot | `server/src/bots/undercover-bot.ts` | 类别模板描述（19 类别模糊句库——近似词天然同类，风格平民卧底一致）+ FNV hash 确定性投票（卧底自保不投自己）；禁 Math.random 纪律 |
| 冒烟 | `server/src/smoke-undercover.ts` | 21 项六场景（A 开局不变量 / B 描述校验 / C 六 bot 完整局+隔离逐帧 / D 黄金 seed 胜负两分支 / E 确定性哈希+重放 / F 平票 PK 构造性验证）——已挂入 `npm test` 链 |
| 注册 | `server.ts` + `bots/registry.ts` | registerGame + house-uc-N·直觉N 命名；网关重启后 `/games` 六游戏在列 |
| 竞猜层 | `gateway/http.ts` | guessTargets 合并 `werewolf_lite‖undercover` 分支（want="undercover"）；guessTargetLabel「卧底」；终局 reveal targets=卧底席位（game_won.roles 过滤） |
| 前端 | `web/index.html` | renderUndercover 词语圆桌（席位环+放逐者 dead/亮身份+描述流 says+投票 ticks+PK 候选行+我的词卡——卧底红字提示）；mini 舞台词 orb+席位环（放逐红点 .ucx）+存活/轮次 hub；renderActions describe textarea+放逐按钮池；解说词典 described 克制/player_exiled 两档/game_won 词对揭晓；evText 四新事件；viewStats/常量/GAME_DESC/refreshGuess 放行 |
| E2E | `tmp-r25/e2e-r25.mjs` | 31 项三部分（A 词典 8 用例 / B 后端集成 14 项——含观战流零 word_assigned、带 token 恰见己词、竞猜 reveal targets=卧底、Elo 榜、阵营口径 / C 前端渲染 13 项）——**两遍连跑全绿** |
| 文档 | `docs/02` §7.6 + §7 标题「六个游戏」+ §9 竞猜语义；`skills/SKILL.md` 参赛节 | 规则骨架/信息隔离要点/超时默认/策略提示全套 |

## 二、架构承诺 · 第六次检验

「新游戏 = 一个新模块，平台设施全自动获得」——本次平台侧改动仅两处、均为**新游戏的语义接入**而非框架改动：
- `server.ts` 注册一行 + 预热列表一项（惯例动作）
- `http.ts` 竞猜 guessTargets 加 undercover 分支（r21 就预留的 roles 过滤模式的第三个消费者——狼人杀/谁是卧底同构）

房间/三通道/SSE/Elo 榜单/竞猜/直播墙/解说席/回放/恢复壳：**零改动自动接线**（E2E B 系列直接验证了 quickstart/竞猜/榜单/事件流/回放全链路）。

## 三、测试结果

| 套件 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错误（r25 初版 14 错全部修复——详见事故 ①） |
| `npm test` 全链 | 12 段全绿（typecheck + smoke + othello/werewolf/holdem/dilemma/undercover/framework/gap/room/errors/persist） |
| smoke:undercover | 21/21（黄金 seed 搜到平民胜+卧底胜双分支） |
| E2E r25 | 31/31 × 两遍（连跑自污染检查通过） |
| 回归 r15/r16 | 全绿（r15 游戏卡计数为动态断言——r24 已修，本轮未被第六游戏击穿，验证了修法） |
| 回归 r17 | 20/0 × 两遍（**顺手修第三处既有断言缺陷**——详见事故 ③） |
| 回归 r20/r21/r22/r23/r24 | 36/0 · 36/0 · 19/0 · 10/0 · 29/0 全绿 |

## 四、平衡基线

- 黄金 seed 扫描（seed 1-60）：平民胜与卧底胜双分支均可达（bot 对 bot，hash 投票下的自然分布）
- house bot 描述风格：类别模板使卧底与平民的描述风格天然一致（近似词同类别）——「猜词靠风格」的博弈留给真人/LLM 选手
- 事件帧：观战流逐轮 1×word_assigned（滤）+ 6×described + 1×vote_result——比狼人杀薄、比 dilemma 厚，SSE 压力可忽略

## 五、过程事故（血泪记账）

1. **smoke 14 个 typecheck 错误**：node strip-types 运行时不查类型所以运行全绿，tsc 才暴露——`{const:boolean}` 对象字面量误写 / `initialEvents?.` 可能 undefined / `EventVisibility` 联合类型直取 .seats / 场景 F 七处 `game.apply` 缺第 4 参 rng（引擎签名四参）/ `pk.data` unknown 迭代。全部修复；**教训：冒烟写完先 tsc 再庆祝**。
2. **E2E C10 假失败 → 揪出产品死代码**：断言「放逐红点 ucx」失败——排查发现 `miniStageInner` 的 ucx 分支**永不可达**（放逐者必然已不在 alive_seats，`off` 恒先命中）。修产品：`exiled.includes(s) ? "ucx" : !alive ? "off" : ""`——本游戏出局只有放逐一条路，红点覆盖全部出局态，设计意图（放逐者红点）才真正成立。
3. **r17「日志同步截断」两连败 → 顺手修第三处既有 E2E 断言缺陷**：根因不是产品回归——cur 行 class 前缀随事件类型（`ev`/`ev sys`/`ev say`/`ev win`），`includes("ev cur")` 在 seq=half 恰落 phase_started 等行时恒假失败（r24 期间那次「一过性 flake」同根因，本轮环境漂移让 half 落点固定偏移才现形）。修断言为类型无关正则 `/class="ev[ a-z]*cur"/`（第一版正则 `[a-z]*` 漏空格又错一次——"ev sys cur" 三段 class 的教训）。与 r23 修的 B3/夜相同类：**断言锁结构不变量，别锁偶然字符串**。
4. **rE 确定性双跑曾失败**：rC 用 withIsolationBot 包装（uc-bot-N 名）、rE 裸 bot（e-N 名）——事件流含 drivers 名致哈希不同。修：rE 用同款 mk() 包装（同席次同名）。

## 六、遗留与后续

- 平票 PK 两轮制（再平票无人出局的现行 v0 简化已写进协议 §7.6「v0 简化」条目）
- 词对库仅 20 对——后续可扩库 + 按类别分组去重（同类别连续出现会被联想）
- 狼队私聊通道（backlog 不变）；undercover 无阵营私聊需求（卧底孤狼——无队友）
- 编制建议（真人局）：timeout_ms 90-120s 措辞余量；6 席尽量真人满员（编制偏好不变）
