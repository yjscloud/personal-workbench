#!/usr/bin/env python3
"""给边界守望加「境外 IP 自动封禁」开关。

语义：开关打开后，agent 开到封禁申请单时，只要目标 IP 归属地确定在境外，
就直接批准并执行 ipset，不再等人点按钮。开关关闭（默认）时行为完全不变。

几条刻意保留的护栏：
  · 归属地查不到（接口超时/限流/内网地址）→ 不自动封，照旧开单等人工。
    宁可多问一句，也不要因为查不到就认定「境外」。
  · 港澳台按国内处理，不自动封。
  · 白名单、每日配额、累犯升级这些原有约束全部照旧先跑一遍。
  · 每次自动封都写 settings 变更审计和 auto_approved 审计，事后能查是谁开的、
    什么时候封了谁。

开关状态存在 attacks.db 的 settings 表里（工作台和值守脚本共用这同一个库）。
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

TARGET = Path("/root/.hermes/scripts/frp_guard.py")
MARK = "def auto_ban_enabled"

SCHEMA_ANCHOR = "        create index if not exists idx_bk_status on blocks(status);\n"
SCHEMA_ADD = """        create index if not exists idx_bk_status on blocks(status);

        -- 运行开关（工作台页面与值守脚本共用）。目前只有境外自动封禁一个键：
        --   auto_ban_foreign = 1/0
        create table if not exists settings(
            key text primary key,
            value text not null default '',
            updated_at text not null default '',
            updated_by text not null default ''
        );
"""

GEO_FIELDS_OLD = '"&fields=status,country,regionName,city,isp,as" % ip)'
GEO_FIELDS_NEW = '"&fields=status,country,countryCode,regionName,city,isp,as" % ip)'

GEO_DICT_OLD = '''            geo = {"place": place or "-", "isp": d.get("isp") or "",
                   "asn": (d.get("as") or "").split(" ")[0]}'''
GEO_DICT_NEW = '''            geo = {"place": place or "-", "isp": d.get("isp") or "",
                   "asn": (d.get("as") or "").split(" ")[0],
                   "cc": (d.get("countryCode") or "").upper()}'''

FUNC_ANCHOR = 'def cmd_request(conn, ip, reason, ttl, actor="agent"):'
FUNC_ADD = '''# ── 境外自动封禁开关 ────────────────────────────────────
# 港澳台按国内处理：运维语境里「境外扫描」指的不是它们，自动封掉反而容易误伤。
CN_ALIKE = {"CN", "HK", "MO", "TW"}
AUTO_BAN_KEY = "auto_ban_foreign"


def auto_ban_enabled(conn) -> bool:
    """开关状态。读不到（老库没有 settings 表）一律当关闭。"""
    try:
        row = conn.execute("select value from settings where key=?", (AUTO_BAN_KEY,)).fetchone()
    except sqlite3.Error:
        return False
    return bool(row) and str(row[0]).strip().lower() in {"1", "true", "on", "yes"}


def auto_ban_state(conn) -> dict:
    try:
        row = conn.execute(
            "select value, updated_at, updated_by from settings where key=?",
            (AUTO_BAN_KEY,)).fetchone()
    except sqlite3.Error:
        row = None
    return {
        "enabled": auto_ban_enabled(conn),
        "updated_at": (row[1] if row else "") or "",
        "updated_by": (row[2] if row else "") or "",
    }


def set_auto_ban(conn, enabled: bool, by: str = "") -> None:
    conn.execute(
        "insert into settings(key, value, updated_at, updated_by) values(?,?,?,?) "
        "on conflict(key) do update set value=excluded.value, "
        "updated_at=excluded.updated_at, updated_by=excluded.updated_by",
        (AUTO_BAN_KEY, "1" if enabled else "0", now_str(), (by or "")[:64]))
    conn.commit()
    audit(conn, by or "user",
          "auto_ban_enabled" if enabled else "auto_ban_disabled", "境外 IP 自动封禁")


def is_foreign_ip(ip: str) -> bool:
    """归属地确定在境外才返回真。查不到 / 没 countryCode 一律不算。"""
    geo = geo_lookup(ip)
    if not geo:
        return False
    cc = (geo.get("cc") or "").upper()
    return bool(cc) and cc not in CN_ALIKE


def cmd_autoban(conn, enabled=None, by: str = "cli") -> int:
    """auto-ban [--on|--off] [--by 谁]；不带开关时只读状态。"""
    if enabled is None:
        st = auto_ban_state(conn)
        print("境外自动封禁: %s%s" % (
            "开启" if st["enabled"] else "关闭",
            ("（%s 由 %s 设置）" % (st["updated_at"][:16], st["updated_by"] or "-"))
            if st["updated_at"] else ""))
        return 0
    set_auto_ban(conn, enabled, by)
    print("境外自动封禁已%s（操作人 %s）" % ("开启" if enabled else "关闭", by or "cli"))
    return 0


'''

REQUEST_OLD = '''    print("申请单 #%d · 授权码 %s · 目标 %s · 时长 %s%s\\n理由: %s"
          % (bid, ticket, ip, "永久" if permanent else "%dh" % (ttl // 3600),
             ("（累犯第%d次）" % (n_repeat + 1)) if n_repeat else "", reason))
    return 0
'''
REQUEST_NEW = '''    print("申请单 #%d · 授权码 %s · 目标 %s · 时长 %s%s\\n理由: %s"
          % (bid, ticket, ip, "永久" if permanent else "%dh" % (ttl // 3600),
             ("（累犯第%d次）" % (n_repeat + 1)) if n_repeat else "", reason))

    # 开关打开且确认是境外来源：直接批准执行，不再等人点按钮。
    if auto_ban_enabled(conn) and is_foreign_ip(ip):
        geo = geo_lookup(ip) or {}
        label = "自动封禁·境外 %s" % (geo.get("place") or geo.get("cc") or "?")
        rc = cmd_approve(conn, ticket, label, apply=True)
        audit(conn, "auto-ban", "auto_approved", "#%d %s %s" % (bid, ip, label))
        return rc
    return 0
'''

CHOICES_OLD = '''                             "profile", "drill", "notify", "intel"])'''
CHOICES_NEW = '''                             "profile", "drill", "notify", "intel", "auto-ban"])'''

ARG_OLD = '    ap.add_argument("--by", default="", help="批准人（审计用）")\n'
ARG_NEW = ('    ap.add_argument("--by", default="", help="批准人（审计用）")\n'
           '    ap.add_argument("--on", action="store_true", help="auto-ban：开启")\n'
           '    ap.add_argument("--off", action="store_true", help="auto-ban：关闭")\n')

DISPATCH_OLD = '''    conn = db()

    if args.mode == "profile":'''
DISPATCH_NEW = '''    conn = db()

    if args.mode == "auto-ban":
        enabled = True if args.on else (False if args.off else None)
        return cmd_autoban(conn, enabled, args.by or "cli")

    if args.mode == "profile":'''


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")
    if MARK in text:
        print("already patched")
        return 0

    pairs = (
        (SCHEMA_ANCHOR, SCHEMA_ADD, "schema"),
        (GEO_FIELDS_OLD, GEO_FIELDS_NEW, "geo-fields"),
        (GEO_DICT_OLD, GEO_DICT_NEW, "geo-dict"),
        (FUNC_ANCHOR, FUNC_ADD + FUNC_ANCHOR, "func"),
        (REQUEST_OLD, REQUEST_NEW, "request"),
        (CHOICES_OLD, CHOICES_NEW, "choices"),
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
