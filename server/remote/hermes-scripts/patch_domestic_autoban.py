#!/usr/bin/env python3
"""给边界守望加「国内 IP 自动封禁」开关（境外那套的镜像）。

语义：开关打开后，值守开到封禁申请单时，只要目标 IP 归属地确定在国内
（含港澳台，与「境外」判定同一份 CN_ALIKE），就直接批准并执行 ipset，
不再等人点按钮。开关关闭（默认）时行为完全不变。

为什么单独一个键而不是把「境外」改成两档：
  · 两个方向的语义相反、风险也不对等。境外自动封 = 「我不在这边，扫就封」，
    误伤概率低；国内自动封 = 把一整片包含自己人出口的地址段自动拉黑，
    必须能单独打开、单独关掉，不能共用一个开关。
  · 键分开之后，面板上的两个 Toggle 各读各的状态，谁开的、什么时候开的
    分别落在 settings 的 updated_at/updated_by 里。

刻意保留的护栏（与境外那套一致，一条都不放松）：
  · 归属地查不到（接口超时/限流/内网地址）→ 不自动封，照旧开单等人工；
  · 白名单、内网段放行、每日配额、累犯升级全部先跑一遍；
  · 每次自动封都写 auto_approved 审计，label 里带「境内」以便事后区分。

幂等：已经打过（文件里有 AUTO_BAN_DOMESTIC_KEY）就直接退出。
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

TARGET = Path("/root/.hermes/scripts/frp_guard.py")
MARK = "AUTO_BAN_DOMESTIC_KEY"

# 1) 常量：挂在现有那组旁边
CONST_OLD = 'AUTO_BAN_KEY = "auto_ban_foreign"\n'
CONST_NEW = ('AUTO_BAN_KEY = "auto_ban_foreign"\n'
             'AUTO_BAN_DOMESTIC_KEY = "auto_ban_domestic"\n')

# 2) 新函数：插在 cmd_geo 之前（is_foreign_ip 之后、命令实现之前）
FUNC_ANCHOR = "def cmd_geo(ips) -> int:"
FUNC_ADD = '''# ── 国内自动封禁开关（境外那套的镜像）────────────────────
# 这把刀更钝：国内来源里既有真扫描，也有自己人的家宽 / 4G 出口。
# 白名单与内网放行在这之前就已经跑过，所以「加进白名单」仍是最有效的保险。
AUTO_BAN_DOMESTIC_KEY = "auto_ban_domestic"


def _setting_bool(conn, key: str) -> bool:
    """settings 里的布尔开关。读不到（老库没有 settings 表）一律当关闭。"""
    try:
        row = conn.execute("select value from settings where key=?", (key,)).fetchone()
    except sqlite3.Error:
        return False
    return bool(row) and str(row[0]).strip().lower() in {"1", "true", "on", "yes"}


def auto_ban_domestic_enabled(conn) -> bool:
    return _setting_bool(conn, AUTO_BAN_DOMESTIC_KEY)


def auto_ban_domestic_state(conn) -> dict:
    try:
        row = conn.execute(
            "select value, updated_at, updated_by from settings where key=?",
            (AUTO_BAN_DOMESTIC_KEY,)).fetchone()
    except sqlite3.Error:
        row = None
    return {
        "enabled": auto_ban_domestic_enabled(conn),
        "updated_at": (row[1] if row else "") or "",
        "updated_by": (row[2] if row else "") or "",
    }


def set_auto_ban_domestic(conn, enabled: bool, by: str = "") -> None:
    conn.execute(
        "insert into settings(key, value, updated_at, updated_by) values(?,?,?,?) "
        "on conflict(key) do update set value=excluded.value, "
        "updated_at=excluded.updated_at, updated_by=excluded.updated_by",
        (AUTO_BAN_DOMESTIC_KEY, "1" if enabled else "0", now_str(), (by or "")[:64]))
    conn.commit()
    audit(conn, by or "user",
          "auto_ban_domestic_enabled" if enabled else "auto_ban_domestic_disabled",
          "国内 IP 自动封禁（含港澳台）")


def is_domestic_ip(ip: str) -> bool:
    """归属地确定在国内（含港澳台）才返回真。查不到 / 没 countryCode 一律不算。"""
    geo = geo_lookup(ip)
    if not geo:
        return False
    cc = (geo.get("cc") or "").upper()
    return bool(cc) and cc in CN_ALIKE


def auto_ban_scope(conn, geo) -> str:
    """这次开单该走哪种自动封禁：返回「境外」/「境内」/空串（走人工）。

    归属地查不到一律空串 —— 宁可多问一句，也不要因为查不到就猜一个方向。
    """
    cc = ((geo or {}).get("cc") or "").upper()
    if not cc:
        return ""
    if cc not in CN_ALIKE and auto_ban_enabled(conn):
        return "境外"
    if cc in CN_ALIKE and auto_ban_domestic_enabled(conn):
        return "境内"
    return ""


def cmd_autoban_scoped(conn, enabled=None, by: str = "cli", scope: str = "foreign") -> int:
    """auto-ban [--domestic] [--on|--off] [--by 谁]；不给开关时只读两个状态。

    保留原来的 cmd_autoban（只认境外），只是命令行入口改走这里 ——
    值守脚本里若有调用它的地方，行为不变。
    """
    domestic = (scope or "foreign") == "domestic"
    if enabled is None:
        for label, st in (("境外", auto_ban_state(conn)),
                          ("国内", auto_ban_domestic_state(conn))):
            print("%s自动封禁: %s%s" % (
                label, "开启" if st["enabled"] else "关闭",
                ("（%s 由 %s 设置）" % (st["updated_at"][:16], st["updated_by"] or "-"))
                if st["updated_at"] else ""))
        return 0
    if domestic:
        set_auto_ban_domestic(conn, enabled, by)
    else:
        set_auto_ban(conn, enabled, by)
    print("%s自动封禁已%s（操作人 %s）"
          % ("国内" if domestic else "境外", "开启" if enabled else "关闭", by or "cli"))
    return 0


'''

# 3) 判定处：原来只看境外，改成分方向
DECIDE_OLD = '''    geo = geo_lookup(ip) or {}
    auto = auto_ban_enabled(conn) and is_foreign_ip(ip)
'''
DECIDE_NEW = '''    geo = geo_lookup(ip) or {}
    # 方向由归属地决定，开关各管一边；查不到 cc 时 auto_scope 为空 → 走人工
    auto_scope = auto_ban_scope(conn, geo)
    auto = bool(auto_scope)
'''

# 4) 自动封禁的 label：带上方向，事后在 blocks/审计里能分开统计
LABEL_OLD = '        label = "自动封禁·境外 %s" % (geo.get("place") or geo.get("cc") or "?")\n'
LABEL_NEW = '        label = "自动封禁·%s %s" % (auto_scope, geo.get("place") or geo.get("cc") or "?")\n'

# 5) 命令行：多一个 --domestic
ARG_OLD = '    ap.add_argument("--off", action="store_true", help="auto-ban：关闭")\n'
ARG_NEW = ('    ap.add_argument("--off", action="store_true", help="auto-ban：关闭")\n'
           '    ap.add_argument("--domestic", action="store_true",\n'
           '                    help="auto-ban：作用于国内来源（默认只作用于境外）")\n')

DISPATCH_OLD = '''    if args.mode == "auto-ban":
        enabled = True if args.on else (False if args.off else None)
        return cmd_autoban(conn, enabled, args.by or "cli")
'''
DISPATCH_NEW = '''    if args.mode == "auto-ban":
        enabled = True if args.on else (False if args.off else None)
        return cmd_autoban_scoped(conn, enabled, args.by or "cli",
                                  "domestic" if args.domestic else "foreign")
'''


def main() -> int:
    if not TARGET.exists():
        print(f"❌ 找不到 {TARGET}", file=sys.stderr)
        return 1
    text = TARGET.read_text(encoding="utf-8")
    if MARK in text:
        print("already patched")
        return 0

    pairs = (
        (CONST_OLD, CONST_NEW, "const"),
        (FUNC_ANCHOR, FUNC_ADD + FUNC_ANCHOR, "func"),
        (DECIDE_OLD, DECIDE_NEW, "decide"),
        (LABEL_OLD, LABEL_NEW, "label"),
        (ARG_OLD, ARG_NEW, "args"),
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
