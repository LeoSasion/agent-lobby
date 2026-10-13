# r15 E2E 审查报告

- 日期：2026-10-12 · 网关：http://localhost:8787（r15 新代码，真实数据）
- 旅程：大厅加载无回归 → 自己局全程对局 → 终局「复盘本局（我的视角）」入口 → 座位视角切换（自动带 x-seat-token，私有信息 my_dice 渲染/隐藏）→ 他人局观战（视角选项隐藏 + 凭据提示）→ aborted 剔除逻辑
- 结论：**16/16 全部通过**
- 前置：server 全量测试（typecheck + 10 段 smoke，含 smoke-persist 新增第 5-7 幕 15 项断言）全部通过
- 服务端 r15 行为（aborted 壳恢复 / 404 三态 / Bearer 归属四态）由 smoke-persist 覆盖
