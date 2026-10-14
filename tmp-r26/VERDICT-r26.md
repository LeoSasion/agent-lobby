# r26 · 可视化主线×2 + backlog 清理×2 ——VERDICT

> 四项并行交付：直播墙 TV 卡解说位 + LLM 解说引擎替换位（可视化主线）；词对库扩容 + 狼队私聊通道（backlog 清理）。
> 零 LLM 依赖铁律保持：LLM 解说为唯二例外之一，且默认关闭、未配置自动回退规则词典。

## 一、交付物

### r26-a 词对库扩容 + 同类别去重
- `undercover.ts` WORD_PAIRS 20→40 对（23 类别）；**库内同类别条目互不相邻**——连续 rng 抽到相邻 idx 不至连局同类别（「上局水果这局又是水果」联想泄露防线；原库狼/狗与猫/老虎相邻正是此问题）
- `wordPairs()` 导出供 smoke 断言库不变量（40 对 / ≥22 类别 / 相邻不重类）
- bot CAT_TEMPLATES 补三新类别（服饰/家电/乐器）
- 协议 §7.6 同步（40 对 / 23 类别）

### r26-b 狼队私聊通道（werewolf_lite）
- 引擎：夜间存活狼可发 `{type:"wolf_say",text}`（1-500 字）——`wolf_said` 事件仅狼可见（`visibility:{seats:wolves}`）；狼视角 `private.wolf_chat`（新夜清空）
- **不占收齐名额**：密语即时入流、不写夜间行动缓冲——边聊边刀，只密语不出刀拖到超时空刀（超时兜底仍 pass）
- 前端：狼视角「狼队密语 · 本夜」面板 + 动作区密语输入（wsay-text）；evText/CM_PRIVATE 接线
- bot：狼队协调——先密语声明刀口（「这刀走 X 号」），队友读 wolf_chat 跟随（收敛刀口消 disagreed）
- 协议 §7.3 + SKILL.md 更新；smoke 场景 5 八项（即时入流/不占收齐/私有/视角隔离/校验/bot 出现）

### r26-c 直播墙 TV 卡解说位
- 纯前端零服务端改动：ingestEvent 对每事件跑 commentate，**hot≥1 高光刷 `WALL.cm[mid]`**；renderEvflow 渲染解说行（◈ 磷光 / ★ 琥珀 h2）常驻 TV 卡
- 低热度事件不刷（解说位只挂高光）；CSS `.tvcm` 族

### r26-d LLM 解说引擎替换位
- 服务端 `commentary/llm.ts` 独立模块：OpenAI 兼容协议（`LLM_BASE_URL/LLM_API_KEY/LLM_MODEL` env）；**每请求时读 env**（不重启切供应商）；match:seq 事件粒度缓存（上限 2000）；8s 超时；AbortController
- 路由 `POST /api/v1/commentary/llm`：未配置 503 `LLM_NOT_CONFIGURED` / 缺参 422 / 上游错 502——错误体规范全套
- 前端增强层：解说席「AI 解说」开关（localStorage，默认关）；开启后**实时高光事件（hot≥2）**先出规则词再异步换 LLM 金句（`AI` 缀标识）；失败静默回退；回放重建不触发（省调用）；换局竞态按 mid 比对
- smoke-commentary-llm 13 项挂入 npm test 链（mock fetch 全链路：金句/缓存/env 动态/超时/上游/空 content/BAD_INPUT）

## 二、测试结果

| 套件 | 结果 |
|---|---|
| `npm test` 全链 | 13 段全绿（typecheck + 12 smoke——werewolf +8 场景 5 / undercover +1 库不变量 / llm 新 13 项） |
| r26 E2E | 18/18 × 两遍（A 狼队密语 4 / B 前端渲染 12 / C 网关契约 2） |
| 回归 | r15 / r16 / r17 / r20 36/0 / r21 28/0 / r22 19/0 / r23 10/0 / r24 29/0 / r25 31/0 全绿 |

## 三、架构纪律

- **零 LLM 依赖铁律**：LLM 未配置 → 503 → 前端静默保持规则词——**默认部署零变化**；开关默认关
- TV 卡解说位纯前端（复用 r23 commentate 引擎与 r20 直播墙事件流，零服务端改动）
- 狼队私聊走 `visibility:{seats}` 现成机制（预言家 checked 同构）——第七次「平台机制复用」检验

## 四、过程事故

1. **误删行两起**：http.ts 插路由时 old/new 不慎删掉 body/name 两行（立即发现恢复+tsc 验证）；解构漏 renderWall（E2E ReferenceError 现形）——**Edit 前后必须 diff 锚点行**
2. **mock getElementById 键格式**：mock 工厂键为 `"#" + id`——`els["tv-m_t1"]` 查不到产品 `getElementById("tv-m_t1")` 写入的 `els["#tv-m_t1"]`，断言假失败
3. **超时 mock 须响应 AbortSignal**：mock fetch 不理 signal → 挂 3s 正常返回 → 超时路径测不出；mock 里监听 abort 抛 AbortError 才对（**mock 要仿真真实 API 的全部副作用面**）
4. **网关进程回收**：`(node &)` 后台随 shell 会话死（ECONNREFUSED）——改 run_in_background 任务常驻；重启后冷启动 25s 内就绪

## 五、遗留与后续

- LLM 解说真实供应商联调（本环境无 key——契约已由 mock 全链路锁定；接入 deepseek/glm 只需三 env）
- 狼队密语的频率限制（当前不限次数，刷屏由 QPS 限流兜底）
- TV 卡解说位可再加大厅级「金句轮播带」（跨桌聚合高光）——后续候选
