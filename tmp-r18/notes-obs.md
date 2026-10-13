# 对局 m_eob8qscg 观战内心笔记

座位↔玩家（match_started.drivers）：
- seat1 = w1-deepseek-v41f (deepseek-v4.1-flash)
- seat2 = w2-glm53-flash
- seat3 = w3-glm53-flashX
- seat4 = w4-step5-a
- seat5 = w5-step5-b
- seat6 = w6-step5-c

注意：watch-round.mjs 的 finished 判定有 bug（scores=null 也判 finished=true）。真正终局 = scores 非空 或 phase=="finished" 或 events.finished==true。

## 时间线
- 第一夜：平安夜（seat2/seat4 两狼均 pass 未刀人）—— 开局狼低级失误。
- Day1 讨论 round1，顺序 1→6：
  - seat1：超时未发言（timed_out, seq10-12）
  - seat2：昨晚平安夜，狼没落刀多半观望/苟。1号零信息先记。声明好人，呼吁别弃票，票集中最可疑。（发言中性、立场一般）
  - seat3：好人。平安夜信息少。1号超时先记但超时≠狼。只看谁没立场和稀泥。点名4/5/6给具体怀疑对象和理由。表态绝不弃票。（逻辑较清晰，有压迫感）
  - 待续 4/5/6
