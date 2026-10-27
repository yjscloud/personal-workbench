#!/usr/bin/env python3
"""给边界守望报告里的 IP 补上地理位置。

数据源用 ip-api.com 的免费接口（无需 key，中文返回），结果落 30 天文件缓存：
同一批扫描 IP 会反复出现在不同窗口里，不缓存的话每次 report 都要重新出网。

刻意不做成硬依赖：查不到 / 限流 / 内网地址一律返回空串，报告照常出。
地理位置只是帮人一眼判断「这波从哪来」，不能参与封禁判定。
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

TARGET = Path("/root/.hermes/scripts/frp_guard.py")
MARK = "def geo_lookup"

IMPORT_ANCHOR = "import sys\nfrom datetime import datetime, timedelta\n"
IMPORT_ADD = "import sys\nimport time\nfrom datetime import datetime, timedelta\n"

FUNC_ANCHOR = "def intel_check(ip):"
FUNC_ADD = '''GEO_CACHE_FILE = os.path.join(HOME, ".hermes/cache/ip_geo.json")
GEO_TTL_OK = 30 * 86400      # 归属地变化很慢，30 天足够
GEO_TTL_FAIL = 86400         # 失败只记一天，避免接口恢复后还在用旧的空结果


def _geo_cache() -> dict:
    try:
        with open(GEO_CACHE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _geo_cache_save(cache: dict) -> None:
    try:
        os.makedirs(os.path.dirname(GEO_CACHE_FILE), exist_ok=True)
        tmp = GEO_CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
        os.replace(tmp, GEO_CACHE_FILE)
    except OSError:
        pass


def geo_lookup(ip: str) -> dict | None:
    """返回 {place, isp, asn}；内网地址、接口失败一律 None。"""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return None
    if not addr.is_global:      # 保留段/内网查了也没意义
        return None

    cache = _geo_cache()
    ent = cache.get(ip) or {}
    age = int(time.time()) - int(ent.get("at") or 0)
    if ent and age < (GEO_TTL_OK if ent.get("ok") else GEO_TTL_FAIL):
        return ent.get("geo") or None

    geo = None
    try:
        from urllib.request import Request, urlopen
        url = ("http://ip-api.com/json/%s?lang=zh-CN"
               "&fields=status,country,regionName,city,isp,as" % ip)
        req = Request(url, headers={"User-Agent": "frp_guard-geo"})
        with urlopen(req, timeout=3) as resp:
            d = json.loads(resp.read().decode("utf-8", "replace"))
        if d.get("status") == "success":
            place = " ".join(x for x in (d.get("country"), d.get("city") or d.get("regionName")) if x)
            geo = {"place": place or "-", "isp": d.get("isp") or "",
                   "asn": (d.get("as") or "").split(" ")[0]}
    except Exception:
        geo = None

    cache[ip] = {"at": int(time.time()), "ok": bool(geo), "geo": geo}
    if len(cache) > 2000:       # 单用户场景，砍掉最旧的一半就够
        keep = sorted(cache.items(), key=lambda kv: -int(kv[1].get("at") or 0))[:1200]
        cache = dict(keep)
    _geo_cache_save(cache)
    return geo


def geo_suffix(ip: str) -> str:
    """报告里跟在 IP 行尾的短标签；查不到就什么都不加。"""
    g = geo_lookup(ip)
    if not g:
        return ""
    bits = [g.get("place") or ""]
    if g.get("isp"):
        bits.append(g["isp"])
    text = " / ".join(b for b in bits if b)
    return ("  · " + text) if text else ""


'''

REPORT_OLD = '''        lines.append("%d) %s  %s  score=%d  连接 %d 次（frps %d / haproxy %d）"
                     % (i, r["ip"], r["severity"], r["score"], r["hits"],
                        r.get("hits_frps", 0), r.get("hits_haproxy", 0)))
'''
REPORT_NEW = '''        lines.append("%d) %s  %s  score=%d  连接 %d 次（frps %d / haproxy %d）%s"
                     % (i, r["ip"], r["severity"], r["score"], r["hits"],
                        r.get("hits_frps", 0), r.get("hits_haproxy", 0),
                        geo_suffix(r["ip"])))
'''

JSON_OLD = '''        ips.append({"ip": r["ip"], "hits": r["hits"], "hits_eff": r.get("hits_eff"),
                    "score": r["score"], "severity": r["severity"],
'''
JSON_NEW = '''        ips.append({"ip": r["ip"], "hits": r["hits"], "hits_eff": r.get("hits_eff"),
                    "score": r["score"], "severity": r["severity"],
                    "geo": geo_lookup(r["ip"]) or {},
'''


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")
    if MARK in text:
        print("already patched")
        return 0

    for anchor, label in (
        (IMPORT_ANCHOR, "import"), (FUNC_ANCHOR, "func"),
        (REPORT_OLD, "report"), (JSON_OLD, "json"),
    ):
        if anchor not in text:
            print(f"❌ 找不到锚点：{label}", file=sys.stderr)
            return 1

    backup = TARGET.with_suffix(f".bak.{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(TARGET, backup)

    text = text.replace(IMPORT_ANCHOR, IMPORT_ADD, 1)
    text = text.replace(FUNC_ANCHOR, FUNC_ADD + FUNC_ANCHOR, 1)
    text = text.replace(REPORT_OLD, REPORT_NEW, 1)
    text = text.replace(JSON_OLD, JSON_NEW, 1)

    compile(text, str(TARGET), "exec")
    TARGET.write_text(text, encoding="utf-8")
    print(f"patched (backup: {backup.name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
