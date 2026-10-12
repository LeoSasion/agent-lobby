# r15 E2E 审查报告

- 日期：2026-10-12 · 网关：http://localhost:8787（r15 新代码，真实数据）
- 旅程：大厅加载无回归 → 自己局全程对局 → 终局「复盘本局（我的视角）」入口 → 座位视角切换（自动带 x-seat-token，私有信息 my_dice 渲染/隐藏）→ 他人局观战（视角选项隐藏 + 凭据提示）→ aborted 剔除逻辑
- 结论：**13/13 全部通过**（连续三遍稳定复现）
- 前置：server 全量测试（typecheck + 10 段 smoke，含 smoke-persist 新增第 5-7 幕 17 项断言）全部通过
- 服务端 r15 行为（aborted 壳恢复 / 404 三态 / Bearer 归属四态）由 smoke-persist 覆盖

## 审查中抓出并修复的存量 bug（P1）

**events 端点缺省 since 丢首事件**（`server/src/gateway/http.ts`）：

- 现象：E2E「（我）视角」选项断言失败 → 追查发现观战事件流首条是 #01 phase_started，#00 match_started 缺失
- 根因：`Number(url.searchParams.get("since"))` 在缺省时 `Number(null) === 0`（JS 经典陷阱），since 被解析为 0，`filter(seq > 0)` 静默丢弃 seq=0 的 match_started——**任何不带 since 的全量裸拉都拿不到首事件**（drivers / bot_filled / human_seats 元数据随之丢失）
- 证据：`?since=-1` 返回 91 条含 `(0, match_started)`；缺省返回 90 条首条 `(1, phase_started)`；持久化文件 rawEvents 完好 91 条
- 修复：显式 null → NaN → -1（全量语义）；`?since=0` 增量语义不变
- 幸存原因：所有既有 smoke 都显式带 `?since=-1`、MCP 客户端纪律也是 `since:-1` 一次拿全、真实浏览器走 SSE（`eventsFor(viewer)` 缺省 -1 不受影响）——只有"裸拉 /events"这条路径无人覆盖
- 防回归：smoke-persist 第 2 幕（恢复壳观战裸拉）+ 第 7 幕（Bearer 裸拉）各加一条 seq=0 match_started 首事件断言

## E2E 脚本自身的时序鲁棒性修复

Phase 2/3 原用固定 `sleep(1200)` 等待回放栏渲染：view fetch 与 events 喂送完成顺序不定，慢机上 view 未返回时 `#m-replay` 为空串——「（我）视角」假阴性 + 「凭据提示」假失败（空串双失真，一跑失败二跑通过的抖动源）。改为条件轮询等待（`rbar` 渲染 + `#00` 事件到达 + 链尾 500ms），三遍稳定全绿。页面本身有自愈机制（每条 SSE 事件触发 refreshMatchView → finished 时重渲染回放栏），无需产品改动。
