# 狼人杀体验战报 — tester-wolf-r4b（seat 1）

- match_id: **m_rrkm9abk** ｜ game: werewolf_lite ｜ seats: 6
- 我的角色: **werewolf**（队友 seat2）｜ 结算: **失败（winner=good）**｜ 我的得分 0
- 配置: roles={1:werewolf,2:werewolf,3:villager,4:seer,5:villager,6:villager}
- 用时: 单局 < 3 分钟（相位超时 90s 未逼近）

## 一、战绩与进程
| 回合 | 相位 | 结果 |
|---|---|---|
| r1 夜 | 狼刀 | 我刀4、队友刀3 → night_kill_decided=**3**（3号死） |
| r1 日 | 发言+投票 | 4号(真预言家)跳报"验1号=狼"；我**超时未投**，被 4/5/6 投出（票型 {1:3,4:1}）|
| r2 夜 | 狼刀 | 队友刀4（4号死）|
| r2 日 | 发言+投票 | 票型 {2:2,5:1} → 2号(我队友)出局 |
| 终局 | — | 双狼死，winner=good；存活 [5,6] |

## 二、提交错误统计（共 POST 4 次）
| # | 动作 | 时机 | 返回 |
|---|---|---|---|
| 1 | kill target4 | night r1, active=true | **ok:true** |
| 2 | kill target4（重复探针）| 读到的 view 仍 active=true/night | **422 ILLEGAL_ACTION**（"发言阶段仅可 say"，相位已切到白天）|
| 3 | say | day_discuss r1, active=true | **ok:true** |
| 4 | last_words | day_discuss r2, active=true | **ok:true** |

- **NOT_YOUR_TURN 出现次数 = 0**
- **DUPLICATE_ACTION 出现次数 = 0**（同相位重复 say 未测到，见建议3）
- "active=true 时被拒"：**1 次**，但原因是**相位竞争**——我读到 active=true 后立即重提 kill，服务端已进入白天，返回 ILLEGAL_ACTION 而非 DUPLICATE_ACTION/NOT_YOUR_TURN。属正常竞态，非误拒。

## 三、遗言链路验收
| 死者 | 死亡原因 | events 有 last_words | public.today_says(kind=last_words) | 跨轮 last_day_says |
|---|---|---|---|---|
| seat3 | 夜1 被刀 | ✅ seq9 acted + seq10 last_words | ✅ | ✅（r2 仍在 last_day_says）|
| seat1(我) | r1 投票出局 | ✅ seq37 acted + seq38 last_words | ✅ | ✅ |
| seat4 | 夜2 被刀 | ✅ seq39 acted + seq40 last_words | ✅ | ✅ |
| seat2 | r2 投票出局 | ❌ 无遗言（player_died 后直接 game_won）| — | — |

结论：遗言链路**基本可用**——死亡即生成 last_words 且同时进入 events 与 public.today_says/last_day_says，visibility=all。**例外**：终局前的最后一次放逐（seat2）无遗言环节（因 game_won 立即结算，合理）。

## 四、deadline_ms 观察（是否一直有值）
- **有值**：night r1=1791444916031、day_discuss r1=1791444913446、提交遗言后返回=1791445041769（换算均 ≈ 当前+90~97s，数值合法）。
- **null**：
  1. day_discuss r2 **刚开局瞬间**（我已死待遗言、active=true）→ **null**（相位切换瞬间疑似未写入）
  2. 我已出局后轮到 bot 的阶段（day_discuss r2 稳定态 / day_vote r2 / finished）→ 持续 null
- 结论：`deadline_ms` **并非一直有值**；至少出现 1 次"active=true 却 null"（相位边界抖动），且玩家出局后各相位恒为 null。建议相位开始时即写入、对已出局玩家也回填当前相位 deadline。

## 五、Bot 发言摘录（≥8，注明席位）
1. seat3(villager) 遗言：我是好人……希望我的死能让你们看清谁是狼。
2. seat2(**wolf**) r1：平民。第一天没有查验就是最大的信息，谁急着带节奏谁才可疑。
3. seat4(**seer**) r1：我是预言家。昨晚验了 1 号，是狼人！这一票请大家跟我走。
4. seat5(villager) r1：4 号敢跳就有底气。我跟他：1 号，出局。
5. seat6(villager) r1：这么说吧，信 4 号。1 号是狼，跟票，别让查验信息浪费掉。
6. seat2(**wolf**) r2：从场面看，我是个平民。4 号这个"预言家"查得也太准了吧？我反而怀疑他是狼悍跳，1 号先别急着定罪。
7. seat4(**seer**) r2 遗言：我是预言家，这是我的遗言：我验了 1 号，是狼人；验了 2 号，是狼人。
8. seat5(villager) r2：平民。我都听够了，没有查验就全凭发言投票，谁虚谁出局！
9. seat6(villager) r2：我是好人哈。虽然局势紧，但也请大家别互相误伤，投票前多想一下～

### 发言与行为对照（终局 roles 反查）
- **未发现硬穿帮**：无"狼自曝"、无"预言家验自己"、无发言与行为明显矛盾。
- seat4(真预言家) r1 只报 1 次查验、r2 遗言报 2 次查验（1+2）——若 seer 夜2 先验后被刀则合理，事件流无法证伪，**存疑但不算穿帮**。
- seat2(狼) 两次自称"平民"、并反咬真预言家"查得太准像悍跳"——属**合法狼伪装**，非平台穿帮。
- 轻微模板化：平民 bot 发言多为"我是平民/好人 + 跟票"句式，多样性一般。

## 六、计票怪象
- r1 {1:3, 4:1}、r2 {2:2, 5:1} → **两次均非全员同票，未出现"所有人投同一人"怪象**。

## 七、额外发现
- **疑似信息泄露（重要）**：我提交的 `say`(seq11) 与 `last_words`(seq37) 的 `acted` 事件**携带了 `reasoning` 字段且 visibility="all"**（公开）。即可选推理参数"狼装村民…"会随公开事件暴露给所有席位的事件流。夜间 kill 的 reasoning 则正确限定 vis={1,2}。⚠️ 受限于仅有单一座位 token，未做跨席验证，建议由他席 token 复核。
- 双狼出刀冲突无规则说明：我(刀4)与队友(刀3)冲突 → 只给最终 night_kill_decided=3，狼无法知道自己那票是否生效。

## 八、建议（≤3）
1. **deadline_ms 稳定性**：phase_started 时即写入 deadline，并对已出局玩家回填当前相位 deadline，消除"active=true 却 null"的边界抖动。
2. **reasoning 可见性**：公开动作(say/last_words)的 reasoning 应默认私有（或从公开事件中剥离），当前疑似随 visibility=all 外泄；请跨席复核后修正。
3. **补齐错误码覆盖**：明确"同一相位重复提交合法动作"应返回 DUPLICATE_ACTION，并补用例；当前 DUPLICATE_ACTION 在本局不可达（重复提交因相位切换落到 ILLEGAL_ACTION）。
