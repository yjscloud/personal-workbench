#!/usr/bin/env python3
"""研判任务降 token：让 monitor 在平静期输出恒定，给模型一个精简的 brief。

两个改动：

1. render_monitor 平静期只输出一行「边界: 平静」。
   原来输出 4 个档位（威胁等级 / 高危来源数量 / 敏感类别 / 段扫描），
   档位在边界来回跳（少量↔多个）也算变化，145 次调度唤醒了 72 次，
   大半是扫描器换 IP 造成的抖动。现在只有「高以上威胁 / 段扫描 / 敏感服务被打」
   才让快照变化 —— 没危险就永远不叫模型。

2. 新增 brief 模式：只给结论 + Top3，几百 token。
   模型看到的越少，后面越不会「再查证一次」，工具往返少一轮就是省两万 token。
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

TARGET = Path("/root/.hermes/scripts/frp_guard.py")
MARK = "def render_brief"

MONITOR_OLD = '''    t = tier(high_cnt, [1, 3, 6])
    return "\\n".join([
        "边界威胁等级: " + lvl,
        "高危来源: %s" % ["无", "少量", "多个", "大量"][t],
        "敏感服务类别: " + ("、".join(sorted(kinds)) if kinds else "无"),
        "段扫描: " + ("有" if any(s["severity"] in ("HIGH", "CRITICAL")
                                  for s in an["subnets"].values()) else "无"),
    ])
'''
MONITOR_NEW = '''    subnet_scan = any(s["severity"] in ("HIGH", "CRITICAL") for s in an["subnets"].values())

    # 平静期输出恒定一行，永不与上一轮产生 diff —— cron 看到没变化就不叫模型。
    # 之前的四个档位里，「高危来源 少量↔多个」这种扫描器换 IP 造成的抖动也触发，
    # 145 次调度叫醒了 72 次，真正需要人看的没几次。
    if worst < 3 and not subnet_scan and not kinds:
        return "边界: 平静"

    t = tier(high_cnt, [1, 3, 6])
    return "\\n".join([
        "边界威胁等级: " + lvl,
        "高危来源: %s" % ["无", "少量", "多个", "大量"][t],
        "敏感服务类别: " + ("、".join(sorted(kinds)) if kinds else "无"),
        "段扫描: " + ("有" if subnet_scan else "无"),
    ])
'''

BRIEF_ANCHOR = "# ── 输出：report（白饭研判，一次拿全）──────────────────"
BRIEF_ADD = '''# ── 输出：brief（研判专用，只给结论）────────────────────
def render_brief(conn, hours=1):
    """研判专用：结论 + Top3，不给原始明细。

    report 是给人看的，动辄几 KB；brief 是给模型看的，控制在几百 token。
    模型拿到的上下文越小，越不会顺手再查证一轮 —— 一轮工具往返就是两万 token。
    """
    an = analyze(conn, int(hours * 60))
    hits = [r for r in an["ips"].values() if r["severity"] in ("HIGH", "CRITICAL", "MED")]
    hits.sort(key=lambda r: -r["score"])
    rank = {"LOW": 1, "MED": 2, "HIGH": 3, "CRITICAL": 4}
    worst = max([rank.get(r["severity"], 1) for r in an["ips"].values()] or [1])

    lines = ["【边界速报】%s · 窗口 %d 分钟" % (an["generated_at"], int(hours * 60)),
             "总连接 %d · 外部来源 %d · 关注以上 %d · 最差 %s"
             % (an["total"], len(an["ips"]), len(hits),
                ["", "低", "关注", "高", "严重"][worst])]
    for i, r in enumerate(hits[:3], 1):
        g = geo_lookup(r["ip"]) or {}
        lines.append("%d) %s %s score=%d 连%d次 %s%s"
                     % (i, r["ip"], r["severity"], r["score"], r["hits"],
                        ",".join(list(r.get("proxies") or [])[:2]) or "-",
                        (" · " + g["place"]) if g.get("place") else ""))
    if not hits:
        lines.append("窗口内无关注级别来源。")
    shell = [r for r in hits if r.get("shell")]
    if shell:
        lines.append("⚠️ 疑似进入 shell: " + ", ".join(r["ip"] for r in shell[:3]))
    return "\\n".join(lines)


'''

CHOICES_OLD = '"profile", "drill", "notify", "intel", "auto-ban"])'
CHOICES_NEW = '"profile", "drill", "notify", "intel", "auto-ban", "brief"])'

DISPATCH_OLD = '    elif args.mode == "monitor":\n        print(render_monitor(an))'
DISPATCH_NEW = ('    elif args.mode == "monitor":\n        print(render_monitor(an))\n'
                '    elif args.mode == "brief":\n'
                '        print(render_brief(conn, args.hours if args.hours else 1))')


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")
    if MARK in text:
        print("already patched")
        return 0

    pairs = (
        (MONITOR_OLD, MONITOR_NEW, "monitor"),
        (BRIEF_ANCHOR, BRIEF_ADD + BRIEF_ANCHOR, "brief"),
        (CHOICES_OLD, CHOICES_NEW, "choices"),
        (DISPATCH_OLD, DISPATCH_NEW, "dispatch"),
    )
    for old, _new, label in pairs:
        if old not in text:
            print(f"❌ 找不到锚点：{label}", file=sys.stderr)
            return 1

    backup = TARGET.with_suffix(f".bak.{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(TARGET, backup)

    for old, new, _label in pairs:
        text = text.replace(old, new, 1)

    compile(text, str(TARGET), "exec")
    TARGET.write_text(text, encoding="utf-8")
    print(f"patched (backup: {backup.name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
