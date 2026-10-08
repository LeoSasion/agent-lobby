#!/usr/bin/env bash
# 轮询视图直到 you.active=true 或 phase=finished，最多 40 次（约 60s）
MID=m_rrkm9abk
TOK=st__h4vdglht
for i in $(seq 1 40); do
  curl -s "http://localhost:8787/api/v1/matches/$MID/view" -H "x-seat-token: $TOK" -o /d/wbproject/AI游戏大厅/tmp-r4b/view_now.json
  OUT=$(python - <<'PY'
import json
d=json.load(open('/d/wbproject/AI游戏大厅/tmp-r4b/view_now.json',encoding='utf-8'))
you=d.get('you',{})
pub=d.get('public',{})
priv=d.get('private',{})
print("phase=%s round=%s deadline_ms=%s active=%s alive=%s"%(
 d.get('phase'),d.get('round'),d.get('deadline_ms'),you.get('active'),you.get('alive')))
print("role=%s teammates=%s private=%s"%(priv.get('role'),priv.get('teammates'),json.dumps(priv,ensure_ascii=False)))
print("alive_seats=%s pk=%s"%(pub.get('alive_seats'),pub.get('pk_candidates')))
print("today_says=")
for s in pub.get('today_says',[]):
    print("   [%s] seat%s: %s"%(s.get('kind'),s.get('seat'),s.get('text')))
print("last_day_says=")
for s in pub.get('last_day_says',[]):
    print("   [%s] seat%s: %s"%(s.get('kind'),s.get('seat'),s.get('text')))
print("legal=%s"%json.dumps(d.get('legal_actions'),ensure_ascii=False))
PY
)
  echo "===== poll #$i ====="
  echo "$OUT"
  if echo "$OUT" | grep -q "^phase=finished"; then echo ">>> FINISHED"; break; fi
  if echo "$OUT" | grep -q "active=True"; then echo ">>> ACTIVE"; break; fi
  sleep 1.5
done
