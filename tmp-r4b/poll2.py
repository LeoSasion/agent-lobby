#!/usr/bin/env python
# -*- coding: utf-8 -*-
import json, time, sys, urllib.request
MID, TOK = "m_rrkm9abk", "st__h4vdglht"
URL = "http://localhost:8787/api/v1/matches/%s/view" % MID

def view():
    req = urllib.request.Request(URL, headers={"x-seat-token": TOK})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))

last_seq = -1
for i in range(1, 120):
    d = view()
    pub = d.get("public", {})
    print("[%02d] phase=%s r=%s dl=%s active=%s alive=%s alive_seats=%s pk=%s" % (
        i, d.get("phase"), d.get("round"), d.get("deadline_ms"),
        d.get("you", {}).get("active"), d.get("private", {}).get("alive"),
        pub.get("alive_seats"), pub.get("pk_candidates")))
    for s in pub.get("today_says", []):
        print("      today [%s] seat%s: %s" % (s.get("kind"), s.get("seat"), s.get("text")))
    for s in pub.get("last_day_says", []):
        print("      lastday [%s] seat%s: %s" % (s.get("kind"), s.get("seat"), s.get("text")))
    print("      legal=%s" % json.dumps(d.get("legal_actions"), ensure_ascii=False))
    json.dump(d, open("view_last.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    if d.get("phase") == "finished":
        print(">>> FINISHED"); break
    time.sleep(2)
