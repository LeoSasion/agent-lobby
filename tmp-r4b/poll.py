#!/usr/bin/env python
# -*- coding: utf-8 -*-
import json, time, sys, urllib.request

MID = "m_rrkm9abk"
TOK = "st__h4vdglht"
BASE = "http://localhost:8787/api/v1/matches/%s/view" % MID

def view():
    req = urllib.request.Request(BASE, headers={"x-seat-token": TOK})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))

def show(d):
    you = d.get("you", {}); pub = d.get("public", {}); priv = d.get("private", {})
    print("phase=%s round=%s deadline_ms=%s active=%s alive=%s" % (
        d.get("phase"), d.get("round"), d.get("deadline_ms"), you.get("active"), priv.get("alive")))
    print("role=%s teammates=%s" % (priv.get("role"), priv.get("teammates")))
    print("alive_seats=%s pk=%s" % (pub.get("alive_seats"), pub.get("pk_candidates")))
    print("today_says:")
    for s in pub.get("today_says", []):
        print("   [%s] seat%s: %s" % (s.get("kind"), s.get("seat"), s.get("text")))
    print("last_day_says:")
    for s in pub.get("last_day_says", []):
        print("   [%s] seat%s: %s" % (s.get("kind"), s.get("seat"), s.get("text")))
    print("legal=%s" % json.dumps(d.get("legal_actions"), ensure_ascii=False))

if __name__ == "__main__":
    maxn = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    for i in range(1, maxn + 1):
        try:
            d = view()
        except Exception as e:
            print("poll #%d ERR %s" % (i, e)); time.sleep(1.5); continue
        print("===== poll #%d =====" % i)
        show(d)
        json.dump(d, open("view_now.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        if d.get("phase") == "finished":
            print(">>> FINISHED"); break
        if d.get("you", {}).get("active"):
            print(">>> ACTIVE"); break
        time.sleep(1.5)
