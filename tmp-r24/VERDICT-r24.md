# VERDICT-r24 · 囚徒困境·迭代赛（第五游戏 · 双游戏轮之一）

**轮次定位**：用户选定「谁是卧底 + 囚徒困境」双游戏轮——本轮为辅菜（半天量级，补 MVP 路线图 Phase 1 欠账项），同时兑现架构核心承诺「**新游戏 = 一个新模块，平台设施全自动获得**」的第五次检验。

## 交付物

1. **引擎**（server/src/games/dilemma.ts，约 190 行）：
   - 2 席 N 轮（默认 10，配置 1-50）每轮同时选择 cooperate/betray；Axelrod 经典矩阵 T5/R3/P1/S0
   - 同时相位 apply 内自检收齐即结算；round_resolved 公开事件含 `pattern`（CC/CD/DC/DD）+双方选择+单轮收益+累计分+is_final
   - **信息隔离**：acted/timed_out 仅本人可见（actionVisibility）；历史轮完全公开（迭代记忆基础）；submitted_seats 只泄「谁已出手」不泄「交了什么」（votes_cast 同语义）
   - scores 胜负口径与其他游戏一致（1/0/0.5）——**总收益只入事件流供观赏**（game_won.totals），不与排位口径混淆
   - 超时默认 = **背叛**（沉默即不合作——确定性兜底，写进协议 §7.5）
   - initialEvents 钩子：首轮 round_started 入流（r13 纪律）
2. **House bot 五策略族**（dilemma-bot.ts，Axelrod 锦标赛阵容）：tit-for-tat / grim / pavlov / 老好人 / 永久背叛——全确定性（无随机）
3. **smoke-dilemma.ts**：17 项断言六场景（开局不变量/策略族理论值/信息隔离逐帧/确定性回放/超时兜底/Elo 平局）——**TFT vs GRIM 全 CC 平局、TFT vs ALLD 教科书分 9:14、超时方 0:50**（10×T）均与 Axelrod 理论值逐位吻合
4. **前端全链路**（web/index.html）：
   - renderDilemma「对决长桌」：双席对峙大数字 + 收益矩阵（上轮琥珀高亮）+ 轮次轨迹带（合=磷光 C / 叛=琥珀红 D 徽章）+ 私有回显
   - mini 舞台（直播墙）：双列轮次标记带 + 总收益对
   - 动作区：合作/背叛双大钮（磷光/琥珀描边）
   - 解说词典：round_resolved 四 pattern 分档（CC hot0/DD hot1/CD/DC hot2/末轮 hot2）+ game_won 三语义（席位号/draw/狼人阵营共存）——**顺手修掉 commentate 重复 case 遮蔽**（原通用 game_won 分支会被插在前的 dilemma 分支挡住返回 null，狼人终局解说哑火——合并为单一 case 前后有序）
   - evText：round_resolved 双语揭晓 + game_won 通用化（winner 为数字时「X 号胜」——修复原版对非 good/wolves 值误报「狼人阵营胜」）
   - viewStats/HOT_EV（round_resolved 入高亮）/GAME_DESC/SEATS_DEFAULT/PHASES(playing) 常量接线
   - 测试钩子 window.__r24
5. **协议文档 §7.5**（docs/02）：规则骨架/相位/public-private 字段/事件流/超时默认/竞技要点（N 已知无末轮不确定性）；§7 标题改「五个游戏」；SKILL.md 参赛节（策略提示：tit-for-tat 冠军策略/house bot 五策略池反推法）
6. **竞猜层零改动**：r21 通用胜者语义（scores>0）自动覆盖——平局 0.5 双中、胜负单中

## 平台设施全自动获得（第五次检验）

引擎+bot 之外零改动即获得：房间/quickstart/三通道接入/SSE 观战/确定性回放/Elo 排行榜（leaderboard/dilemma 自动出现）/观众竞猜（通用语义）/直播墙（mini 舞台新分支）/解说席（词典新分支）/回放 UI/恢复壳降级——**新游戏接入成本 ≈ 游戏逻辑本身**的架构承诺再次兑现。

## 验证数字

- **smoke-dilemma 17 项全绿**（六场景）
- **专项 E2E 29/29 两遍稳定**（tmp-r24/e2e-r24.mjs）：
  - Part A 词典单元 10 用例（分档+全中文+私有防御）
  - Part B 后端集成 13 项（quickstart 快局驱动/竞猜进行中投+终局 reveal targets/Elo 榜单接线/观战流零 acted/首轮 round_started/10 轮 round_resolved/scores 口径/legal_actions 空）
  - Part C 前端渲染 13 项（对峙长桌/矩阵高亮/轨迹带/mini 舞台/动作双钮/事件文本/常量接线）
- **全套回归（九项全绿）**：r15 13/0 · r16 27/0 · r17 20/0 · r20 36/0 · r21 36/0 · r22 19/0 · r23 10/0 · r24 29/0 · smoke（typecheck + 10 段，含新 smoke:dilemma）全部通过
- 顺带两处既有 E2E 演进：r15「分赛区 4 游戏卡」硬编码改动态断言（注册游戏数——dilemma 入注册后原断言必假失败，同类教训与 r23「断言不得锁死环境状态」一致）；r17 一过性「日志同步截断」flake 复跑全绿（负载时序）

## 过程事故与定位

1. **node strip-types 模板串三元 bug**：`${detail ? " — " + detail}`（省略 else）触发 `ERR_INVALID_TYPESCRIPT_SYNTAX: Expected ':'`——而完整三元 `${cond ? a : b}` 正常。既有 smoke 全用完整三元所以从未踩过。修：照惯例补 `: ""`。（--check 模式不报错、仅运行时报——排查曾绕弯）
2. **commentate 重复 case 遮蔽**：插入 dilemma game_won 分支时未察觉 1373 行已有通用 game_won 分支——switch 同名 case 前者恒命中，**狼人杀终局解说被静默哑火**（返回 null）。E2E 前自查发现，合并为单一 case 并注释排序约定
3. **guess changed 语义澄清**：r21 实现里 changed 仅表示「改票发生」——首次投票 changed:false（old===undefined）。r24 E2E 首版断言 changed===true 假失败，修正为 ok+mine
4. **mock DOM 函数可见性**：new Function body 的函数声明/const 均不挂 globalThis（Node 22）——renderDilemma 等内部函数需产品侧测试钩子 window.__r24（r20/gotoMatch 显式 window.xxx 同源惯例）
5. **E2E 调用参数语义**：miniStageInner(m, v) 收完整 view（内部取 v.public）——测试误传 v.public 导致分支空渲染（产品代码无误）
6. **快速验证局时序**：quickstart 2 席=1 guest+1 bot，guest 每轮 30s 超时×10 轮=5 分钟——E2E 驱动循环（you.active 即提交）压到秒级

## r25 预告（谁是卧底）

同轮第二游戏（主菜）：狼人杀引擎同构（秘密身份+轮流描述+投票放逐）；词对库；竞猜层「猜卧底」复用；圆桌渲染器+解说词典复用。
