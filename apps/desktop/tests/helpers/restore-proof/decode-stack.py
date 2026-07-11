#!/usr/bin/env python3
# Decode cg-windows.swift output (front-to-back JSON array of a PID's on-screen
# windows) into the restored-window front->back order, mapping each window back
# to its slug by x-origin. All staged windows are y=90 w=240 h=200 with distinct
# x in {90,190,...,790}.
import json, sys

SLOTS = {90: "P1", 190: "P2", 290: "P3", 390: "P4", 490: "P5",
         590: "T1", 690: "T2", 790: "T3"}
TOL = 25

def slug_for(x):
    for sx, name in SLOTS.items():
        if abs(x - sx) <= TOL:
            return name
    return None

data = json.load(open(sys.argv[1]))
order = []
extras = []
for w in data:
    # Normal app windows live on layer 0; skip panels/menubar/other layers.
    if w.get("layer", -999) != 0:
        continue
    s = slug_for(w.get("x", -9999))
    if s:
        order.append(s)
    else:
        extras.append("?(x=%s w=%s h=%s name=%r layer=%s)" % (
            w.get("x"), w.get("w"), w.get("h"), w.get("name"), w.get("layer")))

print("FRONT->BACK staged windows: " + (" ".join(order) if order else "(none matched)"))
print("TARGET (PASS if equal):     P1 P2 P3 P4 P5 T1 T2 T3")
print("PASS" if order == ["P1", "P2", "P3", "P4", "P5", "T1", "T2", "T3"] else "FAIL")
if extras:
    print("other layer-0 windows (ignored): " + " | ".join(extras))
