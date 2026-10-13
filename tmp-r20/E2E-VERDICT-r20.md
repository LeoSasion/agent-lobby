# E2E-VERDICT-r20 · 直播墙实时可视化（A+B 组合落地）

- 日期：2026-10-13
- 选型：用户在 AB 对照草案（A 具象 mini 舞台 / B 实时脉搏带）后选定 **A+B 组合**
- 改动面：web/index.html 单文件（HTML tick 区脉搏带 + CSS ministage/evflow/pb 族 + JS 实时链路）

## 落地内容

**A · 具象 mini 舞台（r16 渲染器的浓缩版进直播卡）**
- 狼人杀：昼夜 orb（月弧/日环 SVG）+ 极坐标席位环（存活磷光/死亡暗灰）+ 存活侧栏
- 吹牛骰：余骰阵列（每席 5 骰点微缩行，出局行熄灭）+ 叫价徽章（叫 N×M / 开叫权）
- 德州：街徽章（preflop/flop/…）+ 底池大数字 + 公共牌 5 槽（真牌面红黑）+ 席位筹码条
- 黑白棋：8×8 微缩棋枰（实时 64 格黑白子）+ 黑白对侧栏 + last_move 坐标

**B · 实时脉搏带（SSE 事件流直通大厅）**
- 大厅层为每张直播桌建立 EventSource（复用 /stream，零服务端改动）
- 顶部「赛场脉搏」带：跨桌事件汇流即到即显（hot 事件磷光高亮）+ 桌数/事件总数/事件速率统计
- TV 卡 nowline 升级为三行滚动事件流（seq 编号 + 最新行 fresh 动画）
- 事件到达 → 800ms 去抖重拉 view → ministage 刷新 + 磷光脉冲（flash）
- 4s 轮询降级为 SSE 断线兜底；**ingestEvent 幂等去重**（seq 游标，SSE 与轮询双路不重复计数）

## E2E 结果

- **r20 专项 36/36**（五相位：活局起桌 → 大厅加载与直播墙（狼人 orb/席位环/夜相、骰子余骰 30 点/叫价徽章）→ 四游戏 mini 单元（真实快照驱动）→ SSE 注入（脉搏带/事件流/计数/幂等）→ view 去抖刷新 + flash → 轮询兜底）
- **回归零破坏**：r15 E2E 16/16（含中止桌不进回放格）· r16 E2E 27/27 · r17 E2E 20/20
- 合计 99 项全绿

## 工程要点（踩坑记录）

1. **mock setTimeout 会打断 undici**：全局替换 setTimeout 后 fetch 内部 `timeout.unref` 崩——E2E 的 setTimeout 必须保持原生（去抖走真实异步 + 条件等待）
2. **mock DOM 无解析树**：`#wall` innerHTML 写入不产生 getElementById 可寻的卡——E2E 用 syncWallCards（正则提取卡块注册 els）+ 子查询 _subs 缓存；断言一律从容器字符串提取
3. **Function 作用域不可达**：new Function(js) 内的函数声明挂不到 window——产品侧加测试钩子 `window.__r20 = { miniStageInner, renderWall, ingestEvent, refreshMinistage, WALL, TK }`（仅测试消费）
4. **断言勿依赖内容变化判定「刷新发生」**：say 事件不改 mini 渲染字段（seats/phase/round 不变）→ view 重拉后内容相同是**正确行为**——刷新证据用 flash 类出现，内容断言用非空
5. **正则计数防前缀误配**：`/chip-bar/g` 会误匹配容器 `chip-bars`——用 `/class="chip-bar /g`

## 产物清单

- web/index.html：+~230 行（CSS ministage/evflow/pb/flash 族、JS mini 渲染器四函数 + SSE/ingest/脉搏带/去抖刷新链路、测试钩子）
- tmp-r20/：AB 草案三页（真实数据注入）、finalize.mjs（幂等注入）、verify-drafts.mjs（草案无头验证 19/19）、e2e-r20.mjs（专项 36/36）、快照数据 ×8
- 预览入口：http://127.0.0.1:8787/（网关直接托管正式页，活局实况驱动）
