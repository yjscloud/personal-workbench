#!/usr/bin/env python3
"""IT 资讯日报的抓取端：把 RSS 抓成一份紧凑清单，喂给模型做摘要。

为什么不用 web_search：
一次日报原来要 20 万输入 token —— 模型反复搜索、每轮把全部上下文重发一遍。
抓取这件事脚本做得又快又准（0 token），模型只需要「读清单、挑重点、写成人话」。
把这两件事拆开，同一份日报的成本能降一个数量级。

输出就是一份纯文本清单（标题 + 链接 + 来源），控制在 6000 字符以内 ——
清单越长，模型越容易漏掉重点，token 也越贵。
"""

from __future__ import annotations

import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from datetime import datetime, timedelta, timezone

FEEDS = [
    ("Hacker News", "https://hnrss.org/frontpage", 8),
    ("36氪", "https://36kr.com/feed", 6),
    ("TechCrunch", "https://techcrunch.com/feed/", 6),
    ("Solidot", "https://www.solidot.org/index.rss", 6),
]

MAX_CHARS = 6000
TITLE_MAX = 90
UA = "Mozilla/5.0 (compatible; it-daily/1.0)"


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=12) as resp:
        raw = resp.read()
    # 部分中文源会夹带控制字符，XML 解析器会直接报 not well-formed
    return re.sub(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]", b"", raw)


def text_of(node) -> str:
    return re.sub(r"<[^>]+>", "", (node.text or "")).strip() if node is not None else ""


def parse_items(raw: bytes) -> list[tuple[str, str, str]]:
    """返回 [(标题, 链接, 时间)]，RSS 2.0 与 Atom 都认。

    有的源（36氪）会吐出不合规的 XML —— 清洗控制字符也救不回来。
    解析失败就退回正则兜底：能捞几条是几条，总比整个源丢掉强。
    """
    try:
        return _parse_xml(raw)
    except ET.ParseError:
        return _parse_regex(raw)


def _parse_regex(raw: bytes) -> list[tuple[str, str, str]]:
    text = raw.decode("utf-8", "replace")
    out: list[tuple[str, str, str]] = []
    for block in re.findall(r"<item\b.*?</item>", text, re.S):
        tm = re.search(r"<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>", block, re.S)
        lm = re.search(r"<link[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>", block, re.S)
        pm = re.search(r"<pubDate[^>]*>(.*?)</pubDate>", block, re.S)
        title = re.sub(r"<[^>]+>", "", tm.group(1)).strip() if tm else ""
        link = lm.group(1).strip() if lm else ""
        if title and link:
            out.append((title, link, pm.group(1).strip() if pm else ""))
    return out


def _parse_xml(raw: bytes) -> list[tuple[str, str, str]]:
    root = ET.fromstring(raw)
    out: list[tuple[str, str, str]] = []

    for it in root.iter("item"):          # RSS 2.0
        title = text_of(it.find("title"))
        link = text_of(it.find("link"))
        pub = text_of(it.find("pubDate"))
        if title and link:
            out.append((title, link, pub))

    if not out:                            # Atom
        ns = "{http://www.w3.org/2005/Atom}"
        for it in root.iter(ns + "entry"):
            title = text_of(it.find(ns + "title"))
            link_el = it.find(ns + "link")
            link = link_el.get("href", "") if link_el is not None else ""
            pub = text_of(it.find(ns + "updated")) or text_of(it.find(ns + "published"))
            if title and link:
                out.append((title, link, pub))
    return out


def fresh(pub: str, hours: int = 30) -> bool:
    """只留最近 N 小时。时间解析不出来就保留（宁多勿漏）。"""
    if not pub:
        return True
    try:
        dt = parsedate_to_datetime(pub)
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
        except ValueError:
            return True
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - dt <= timedelta(hours=hours)


def main() -> int:
    lines: list[str] = [f"# 原始资讯清单 · {datetime.now().strftime('%Y-%m-%d %H:%M')}", ""]
    total = 0
    got = 0
    seen: set[str] = set()

    for name, url, limit in FEEDS:
        try:
            items = [it for it in parse_items(fetch(url)) if fresh(it[2])][:limit]
        except Exception as exc:                    # 单个源挂了不影响整份日报
            print(f"<!-- {name} 抓取失败: {exc} -->", file=sys.stderr)
            continue
        if not items:
            continue
        block = [f"## {name}"]
        for title, link, _pub in items:
            key = title.strip().lower()
            if key in seen:                          # 同一条新闻会被多个源重复收录
                continue
            seen.add(key)
            block.append(f"- {title[:TITLE_MAX]}\n  {link}")
        if len(block) == 1:                          # 整个源都是重复的
            continue
        chunk = "\n".join(block)
        if total + len(chunk) > MAX_CHARS:
            break
        lines.append(chunk)
        lines.append("")
        total += len(chunk)
        got += len(items)

    if not got:
        print("资讯源全部抓取失败，本次跳过。", file=sys.stderr)
        return 1

    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
