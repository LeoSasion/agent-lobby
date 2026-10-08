# tester-wolf-r4 实测笔记（第4轮）

## 网关
- http://localhost:8787 已运行
- quickstart / view / actions / events 全通，均 200（非法动作 422）

## 对局 1：m_w7by6hnk（token st__3qiqzu9e）
- 角色：狼人（1号），队友=2号。种子 seed=399512276
- 夜1：我 kill(4)，队友2 kill(3) → night_kill_decided target=3（我的刀被覆盖）
- 日1讨论：3号先发遗言（last_words），我伪装好人，4号 bot 跳预言家查杀我（1号）
- 日1投票：1→2(me投4)，票型 1:3(4,5,6), 4:2 → 我(1)被放逐（cause=vote）
- 夜2：队友2 kill(4)（真预言家4号死）
- 日2开场：我收到 last_words 动作 → 提交成功(200) → seq36 acted + seq37 last_words 事件 + today_says kind="last_words"
- 4号(真预言家)遗言：准确报出"验1号狼、验2号狼"
- 日2投票：2被放逐 → game_won winner=good；roles {1:werewolf,2:werewolf,3:villager,4:seer,5:villager,6:villager}；scores 好人各1，狼0

## 对局 2-5：预言家系列
| match_id | 角色 | 结果 | 备注 |
|---|---|---|---|
| m_5ka0mdj0 | seer | 验2=狼 | 跳身份报查杀，PK[2,1]后我(1)被投出，2狼2民→狼胜，无遗言 |
| m_bqjf7jt3 | seer | 验3=金水 | 跳身份报金水，票型与上局逐字节一致，PK后我(1)被投出→狼胜 |
| m_z2isc1ev | seer | 验4=金水 | 藏身份投2号，PK[5,1]（5是狼）全 bot 投我(1)→我出局→狼胜 |
| m_lnl30fzy | seer | 验2=狼 | 跳身份报查杀，票型 {1:2,2:2,4:1} 与局2/3完全一致，PK后我出局→狼胜 |

结论：作为 1 号位预言家，夜1狼不刀我（刀 5/6 等口位），日1投票必然把我拖入顶牛，PK 阶段所有 house bot 一律投 1 号；淘汰后恰好 2狼 vs 2民/3好人形成狼人胜，对局立即结束，**无法进入遗言相位**，故本人未能亲验"被刀后遗言报查验"。该链路由局1的真预言家 bot 4 号遗言间接验证。

## 关键证据
- 票型跨局复现（局2/3/5 完全相同）：1→2, 2→1, 3→2, 4→1, 6→4 → tally {1:2,2:2,4:1} → PK[2,1] → PK 全员投1
- bot 发言跨局逐字复现：seat2 恒为"平民。第一天没有查验就是最大的信息，谁急着带节奏谁才可疑。"
- 上下文穿帮：我跳预言家后，seat3 仍输出"期待预言家站出来给信息"
- 模板拼接：seat2 一句里拼接两段模板；seat3/seat6 共用同一开场句
- 遗言模板多样：至少"我是好人……希望我的死能让你看清谁是狼""我平民一个，死得冤…""我是预言家，这是我的遗言：…"
- deadline_ms 为绝对 epoch 毫秒（≈当前+87s，与90s一致）；但 day_vote 相位出现过 null
- 重复提交 last_words → 422 NOT_YOUR_TURN（首次响应里的 legal_actions 是推进前快照）
