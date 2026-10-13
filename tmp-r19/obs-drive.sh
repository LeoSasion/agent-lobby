#!/usr/bin/env bash
# r19 观众循环驱动（前台有界）：运行 watch-round，追加日志，检测到终局即退出
# 用法: bash obs-drive.sh [maxRounds]   默认 6 轮（每轮约 80s）
cd D:/wbproject/AI游戏大厅/tmp-r19 || exit 1
LOG=obs-deepseek-v41f.log
MAX=${1:-6}
for i in $(seq 1 "$MAX"); do
  echo "===== ROUND $(date +%H:%M:%S) =====" >> "$LOG"
  out=$(node watch-round.mjs r__0bjzdkbm sk__mpisy5au 2>&1)
  echo "$out" >> "$LOG"
  if echo "$out" | grep -q '"finished":true'; then
    echo "TERMINAL_DETECTED" >> "$LOG"
    echo "TERMINAL"
    exit 0
  fi
done
echo "BATCH_DONE"
