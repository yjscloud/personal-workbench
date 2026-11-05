#!/usr/bin/env python3
"""给「国内 IP 自动封禁」加区域豁免：指定的省份 / 城市不自动封。

场景：出口 IP 在广州（或整个广东），国内自动封禁一打开，自己人的家宽就会被
自己的规则当成攻击者。白名单只能一条条加具体 IP，而家宽的出口是会变的 ——
按区域豁免才是"这一片我的人在这"的正确表达。

语义：
  · 豁免按归属地的省份名 / 城市名做子串匹配（「广州」能匹配「中国 广州市」，
    「广东」能匹配 regionName=广东）；
  · 命中豁免的来源**不自动封**，但仍然会开申请单走人工（不是放行，是降级）；
  · 只作用于国内那把刀，境外自动封禁不受影响；
  · 归属地查不到（接口失败）时按"不确定"处理 → 走人工，绝不因为查不到就自动封；
  · 老缓存里没有省份字段的条目，判定那一刻现查一次（refresh），不搞批量重采。

存储：settings 表 key=auto_ban_domestic_exempt，值是逗号分隔的区域名。
命令行：frp_guard.py auto-ban --domestic-exempt "广州,深圳"（传空串即清空）。

幂等：文件里已有 AUTO_BAN_DOMESTIC_EXEMPT_KEY 就直接退出。
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

TARGET = Path("/root/.hermes/scripts/frp_guard.py")
MARK = "AUTO_BAN_DOMESTIC_EXEMPT_KEY"

# 1) 常量：挂在现有国内开关旁边（锚点带上下一行的函数定义，避免命中同名常量区）
CONST_OLD = '''AUTO_BAN_DOMESTIC_KEY = "auto_ban_domestic"


def _setting_bool(conn, key: str) -> bool:'''
CONST_NEW = '''AUTO_BAN_DOMESTIC_KEY = "auto_ban_domestic"
AUTO_BAN_DOMESTIC_EXEMPT_KEY = "auto_ban_domestic_exempt"


def _setting_bool(conn, key: str) -> bool:'''

# 2) geo_lookup：支持强制刷新 + 落 region/city
SIG_OLD = "def geo_lookup(ip: str) -> dict | None:\n"
SIG_NEW = "def geo_lookup(ip: str, refresh: bool = False) -> dict | None:\n"

CACHE_OLD = '''    if ent and age < (GEO_TTL_OK if ent.get("ok") else GEO_TTL_FAIL) and (
            not cached_geo or "cc" in cached_geo):
        return cached_geo or None
'''
CACHE_NEW = '''    if not refresh and ent and age < (GEO_TTL_OK if ent.get("ok") else GEO_TTL_FAIL) and (
            not cached_geo or "cc" in cached_geo):
        return cached_geo or None
'''

GEO_OLD = '''            geo = {"place": place or "-", "isp": d.get("isp") or "",
                   "asn": (d.get("as") or "").split(" ")[0],
                   "cc": (d.get("countryCode") or "").upper()}
'''
GEO_NEW = '''            geo = {"place": place or "-", "isp": d.get("isp") or "",
                   "asn": (d.get("as") or "").split(" ")[0],
                   "cc": (d.get("countryCode") or "").upper(),
                   # 区域豁免要按省份 / 城市名匹配，所以这两项必须落到缓存里
                   "region": d.get("regionName") or "",
                   "city": d.get("city") or ""}
'''

# 3) auto_ban_scope：国内分支先看豁免
SCOPE_OLD = '''def auto_ban_scope(conn, geo) -> str:
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
'''

SCOPE_NEW = '''# ── 国内自动封禁的区域豁免 ────────────────────────────────
# 家宽出口会变，白名单只能一条条加 IP；按省市豁免才是「这一片是我的人」的表达。
# 命中豁免 = 降级走人工，不是放行 —— 该开的申请单照开，只是不替你做决定。


def parse_region_list(text) -> list:
    """把 "广州, 深圳 / 广东" 这类输入拆成去重后的区域名列表。"""
    raw = str(text or "")
    for sep in ("，", "、", "；", ";", "|", "/", "\\n", "\\t", " ", "\\u3000"):
        raw = raw.replace(sep, ",")
    out = []
    for part in raw.split(","):
        kw = part.strip()
        if not kw or kw in out:
            continue
        out.append(kw[:16])
    return out[:20]


def auto_ban_domestic_exempt(conn) -> list:
    """国内自动封禁的豁免区域。读不到（老库没这行）= 不豁免。"""
    try:
        row = conn.execute("select value from settings where key=?",
                           (AUTO_BAN_DOMESTIC_EXEMPT_KEY,)).fetchone()
    except sqlite3.Error:
        return []
    return parse_region_list(row[0] if row else "")


def set_auto_ban_domestic_exempt(conn, regions, by: str = "") -> list:
    items = parse_region_list(",".join(regions) if isinstance(regions, (list, tuple)) else regions)
    conn.execute(
        "insert into settings(key, value, updated_at, updated_by) values(?,?,?,?) "
        "on conflict(key) do update set value=excluded.value, "
        "updated_at=excluded.updated_at, updated_by=excluded.updated_by",
        (AUTO_BAN_DOMESTIC_EXEMPT_KEY, ", ".join(items), now_str(), (by or "")[:64]))
    conn.commit()
    audit(conn, by or "user", "auto_ban_domestic_exempt_set",
          "国内自动封禁豁免：" + ("、".join(items) if items else "（清空）"))
    return items


def is_domestic_exempt(geo, exempt) -> bool:
    """归属地落在豁免区域里就返回真。省份名与城市名都算，子串匹配、忽略大小写。"""
    if not exempt:
        return False
    g = geo or {}
    hay = " ".join(str(g.get(k) or "") for k in ("place", "region", "city")).lower()
    if not hay.strip():
        return False
    return any(str(kw).lower() in hay for kw in exempt if kw)


def cmd_autoban_exempt(conn, regions, by: str = "cli") -> int:
    """auto-ban --domestic-exempt "广州,深圳"；传空串即清空。"""
    items = set_auto_ban_domestic_exempt(conn, regions, by)
    print("国内自动封禁豁免区域: %s" % ("、".join(items) if items else "（已清空）"))
    return 0


def auto_ban_scope(conn, geo, ip: str = "") -> str:
    """这次开单该走哪种自动封禁：返回「境外」/「境内」/空串（走人工）。

    归属地查不到一律空串 —— 宁可多问一句，也不要因为查不到就猜一个方向。
    国内那把还要过一遍区域豁免：命中就不自动封（改走人工），不确定也走人工。
    """
    cc = ((geo or {}).get("cc") or "").upper()
    if not cc:
        return ""
    if cc not in CN_ALIKE and auto_ban_enabled(conn):
        return "境外"
    if cc in CN_ALIKE and auto_ban_domestic_enabled(conn):
        exempt = auto_ban_domestic_exempt(conn)
        if not exempt:
            return "境内"
        if not (geo or {}).get("region"):
            # 老缓存没有省份字段：判定这一刻现查一次，不批量重采
            geo = geo_lookup(ip, refresh=True) if ip else geo
            if not (geo or {}).get("region"):
                return ""      # 查不到省份就说不清是不是豁免区 → 交给人
        return "" if is_domestic_exempt(geo, exempt) else "境内"
    return ""
'''

# 4) 调用处把 ip 带上（豁免要靠它现查省份）
CALL_OLD = "    auto_scope = auto_ban_scope(conn, geo)\n"
CALL_NEW = "    auto_scope = auto_ban_scope(conn, geo, ip)\n"

# 5) 只读状态里把豁免一起打出来（否则改完看不见生效没有）
PRINT_OLD = '''    if enabled is None:
        for label, st in (("境外", auto_ban_state(conn)),
                          ("国内", auto_ban_domestic_state(conn))):
            print("%s自动封禁: %s%s" % (
                label, "开启" if st["enabled"] else "关闭",
                ("（%s 由 %s 设置）" % (st["updated_at"][:16], st["updated_by"] or "-"))
                if st["updated_at"] else ""))
        return 0
'''
PRINT_NEW = '''    if enabled is None:
        for label, st in (("境外", auto_ban_state(conn)),
                          ("国内", auto_ban_domestic_state(conn))):
            print("%s自动封禁: %s%s" % (
                label, "开启" if st["enabled"] else "关闭",
                ("（%s 由 %s 设置）" % (st["updated_at"][:16], st["updated_by"] or "-"))
                if st["updated_at"] else ""))
        exempt = auto_ban_domestic_exempt(conn)
        print("国内豁免区域: %s" % ("、".join(exempt) if exempt else "（无）"))
        return 0
'''

# 6) 命令行
ARG_OLD = '''    ap.add_argument("--domestic", action="store_true",
                    help="auto-ban：作用于国内来源（默认只作用于境外）")
'''
ARG_NEW = '''    ap.add_argument("--domestic", action="store_true",
                    help="auto-ban：作用于国内来源（默认只作用于境外）")
    ap.add_argument("--domestic-exempt", default=None, metavar="广州,深圳",
                    help="auto-ban：设置国内豁免区域（传空串清空）")
'''

DISPATCH_OLD = '''    if args.mode == "auto-ban":
        enabled = True if args.on else (False if args.off else None)
'''
DISPATCH_NEW = '''    if args.mode == "auto-ban":
        if args.domestic_exempt is not None:
            return cmd_autoban_exempt(conn, args.domestic_exempt, args.by or "cli")
        enabled = True if args.on else (False if args.off else None)
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
        (SIG_OLD, SIG_NEW, "geo-sig"),
        (CACHE_OLD, CACHE_NEW, "geo-cache"),
        (GEO_OLD, GEO_NEW, "geo-fields"),
        (SCOPE_OLD, SCOPE_NEW, "scope"),
        (CALL_OLD, CALL_NEW, "call"),
        (PRINT_OLD, PRINT_NEW, "print"),
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
