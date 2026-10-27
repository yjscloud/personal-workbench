#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拾贝 Harvester · 网页抓取执行器（由工作台数据桥 POST /local/scrape 调用）

输入（JSON，stdin）:
    {"url":"https://...", "selector":".item", "mode":"fast|stealth|dynamic",
     "limit":20, "adaptive":true, "robots":true, "timeout":20,
     "pages":3,                                        # 翻页深度（1..MAX_PAGES，自动找「下一页」）
     "fields":{"标题":".title", "链接":"a@href"},        # 字段映射：css 选择器，@attr 取属性，默认取文本
     "sample":true}                                    # 取样模式：只抓首页，回干净 HTML 样本 + 全页文本

输出（JSON，stdout）:
    {"ok":true, "mode":"fast", "status":200, "title":"...", "count":2, "total":40,
     "items":[{"text":"...","html":"...","fields":{"标题":"..."}}],
     "fields":["标题","链接"], "pages_requested":3, "pages_fetched":2,
     "pages":[{"url":"...","status":200,"count":20,"total":20}], "elapsed_ms":1234}
    失败时 {"ok":false, "error":"..."}

翻页说明：不猜站点的分页规则，而是按 rel=next → 链接文案「下一页/next」→ page=N 递增
的顺序找下一页；找不到就停在当前页，并在 note 里说明原因（不报错）。
字段说明：给了 fields 且给了 selector 时，每条记录一行；只给 fields 不给 selector 时整页一行。

安全策略（SSRF 防护，全部在这一层，是唯一出口）：
 1. 仅允许 http / https
 2. 解析目标全部 IP，命中私有/回环/链路本地/保留网段一律拒绝
    （内网调试可用环境变量 SCRAPE_ALLOW_PRIVATE=1 临时放开，线上请勿开启）
 3. 默认遵守 robots.txt，可用 robots:false 显式跳过
 4. 限制抓取条数、单条长度与总耗时
"""
import ipaddress
import json
import os
import re
import socket
import sys
import time
import urllib.parse
import urllib.request

MAX_LIMIT = 50
MAX_ITEM_CHARS = 2000
MAX_FIELD_CHARS = 300
MAX_HTML_CHARS = 400000
MAX_PAGES = 10          # 翻页深度上限
PAGE_DELAY_S = 0.6      # 翻页之间的礼貌间隔
MAX_FIELDS = 12         # 字段映射最多几个字段
MAX_SAMPLE_CHARS = 12000   # 喂给模型的 HTML 样本上限（控制 token）
MAX_TEXT_CHARS = 200000    # 供回校验用的全页纯文本上限

BLOCKED_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),      # 回环：含本机 Hermes 网关 8642
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),   # link-local：含 169.254.169.254 云元数据
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("192.0.0.0/24"),
    ipaddress.ip_network("198.18.0.0/15"),
]


def log(msg):
    sys.stderr.write("[scrape] %s\n" % msg)


def die(msg):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(0)


def guard(url):
    """SSRF 前置检查，返回 (host, error)"""
    try:
        u = urllib.parse.urlsplit(url.strip())
    except Exception as exc:
        return None, "URL 解析失败: %s" % exc

    if u.scheme not in ("http", "https"):
        return None, "仅支持 http/https，收到: %s" % (u.scheme or "空")
    host = u.hostname
    if not host:
        return None, "URL 缺少主机名"

    # 允许 /etc/agent-office/scrape-allow.txt 里的域名白名单（可选）
    allow_file = os.environ.get("SCRAPE_ALLOW_FILE", "")
    if allow_file and os.path.isfile(allow_file):
        allowed = [ln.strip().lower() for ln in open(allow_file, encoding="utf-8") if ln.strip()]
        if allowed and not any(host.lower() == a or host.lower().endswith("." + a) for a in allowed):
            return None, "域名不在白名单中: %s" % host

    if os.environ.get("SCRAPE_ALLOW_PRIVATE") == "1":
        return host, None

    try:
        port = u.port or (443 if u.scheme == "https" else 80)
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except Exception as exc:
        return None, "DNS 解析失败: %s" % exc

    for _, _, _, _, sockaddr in infos:
        ip_raw = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_raw)
        except ValueError:
            return None, "非法 IP: %s" % ip_raw
        # 用 nginx/网关地址也一并拦掉：即便解析到本机也不放行
        for net in BLOCKED_NETWORKS:
            if ip in net:
                return None, "目标指向内网/保留地址，已拒绝: %s (%s)" % (host, ip)
    return host, None


def robots_allows(url, timeout=6):
    try:
        parts = urllib.parse.urlsplit(url)
        base = "%s://%s" % (parts.scheme, parts.netloc)
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(base + "/robots.txt")
        req = urllib.request.Request(base + "/robots.txt", headers={"User-Agent": "HarvesterBot/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "ignore")
        rp.parse(body.splitlines())
        return rp.can_fetch("HarvesterBot/1.0", url)
    except Exception:
        return True   # 取不到 robots 视为允许


TAIL_PUNCT = "，。,.;；、！？!?:：)）]】}>》\"'"

def normalize_url(raw):
    """把用户随手粘贴的内容整理成合法 URL，返回 (url, note, root)

    - 去掉首尾空白、引号与中文标点
    - 缺协议时补 https://
    - 主机名只保留 ASCII 域名字符；紧跟其后的中文等字符做百分号编码并当作路径
      （"https://gz.ke.com市桥的房价" -> "https://gz.ke.com/%E5%B8%82..."）
    - root 为「站点首页」，用于中文路径 404 时的回退
    """
    u = (raw or "").strip().strip('"\'<>()[]{}「」『』')
    u = u.rstrip(TAIL_PUNCT)
    note = ""

    m = re.match(r'^(https?://)', u, re.I)
    if m:
        scheme = m.group(1).lower()
        rest = u[m.end():]
    else:
        if not re.match(r'^(?:[A-Za-z0-9\-]+\.)+[A-Za-z]{2,}', u):
            return u, "", ""
        scheme = "https://"
        rest = u
        note = "已自动补全 https://"

    m2 = re.match(r'^([A-Za-z0-9\-\._~%:\[\]]+)(.*)$', rest, re.S)
    host, tail = m2.group(1), m2.group(2)
    host = host.rstrip('.:')
    root = scheme + host + "/"

    if tail:
        enc = urllib.parse.quote(tail, safe="/?&=%#:;,+$@!*'()[]~._-")
        if enc and not enc.startswith(('/', '?', '#')):
            enc = "/" + enc
        if enc != tail:
            note = (note + "；" if note else "") + "网址中的中文已百分号编码"
        tail = enc
    return scheme + host + tail, note, root


def do_fetch(url, mode, timeout_s):
    if mode == "fast":
        from scrapling.fetchers import Fetcher
        return Fetcher.get(url, timeout=timeout_s)
    if mode == "dynamic":
        from scrapling.fetchers import DynamicFetcher
        return DynamicFetcher.fetch(url, headless=True, disable_resources=True, timeout=timeout_s * 1000)
    from scrapling.fetchers import StealthyFetcher
    return StealthyFetcher.fetch(url, headless=True, timeout=timeout_s * 1000)


def clean_sample(html):
    """给模型看的干净 HTML：去掉脚本/样式/SVG/注释，压掉空白，保留标签与属性"""
    h = re.sub(r"<!--[\s\S]*?-->", " ", html or "")
    for tag in ("script", "style", "svg", "noscript", "template"):
        h = re.sub(r"<%s[\s\S]*?</%s>" % (tag, tag), " ", h, flags=re.I)
    h = re.sub(r"\s+", " ", h)
    h = re.sub(r">\s+<", "><", h)
    return h.strip()


ATTR_VAL_RE = re.compile(r'(?:href|src|data-[\w-]+)\s*=\s*["\']([^"\']{1,300})["\']', re.I)


def page_attr_values(html):
    """页面上出现过的链接/资源等属性值。

    回校验只对纯文本，会把 a@href 取出来的链接误判成「模型编的」——
    这些值本来就只存在于属性里，所以单独抽出来一起参与核对。
    """
    try:
        vals = [" ".join(ATTR_VAL_RE.findall(html or ""))]
    except Exception:
        vals = []
    return re.sub(r"\s+", " ", " ".join(vals)).strip()


def page_text(html):
    """全页纯文本：回校验用（判断模型给的值到底有没有出现在页面上）"""
    h = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", html or "", flags=re.I)
    h = re.sub(r"<[^>]+>", " ", h)
    h = h.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    h = h.replace("&quot;", '"').replace("&#39;", "'")
    return re.sub(r"\s+", " ", h).strip()


LOGIN_TITLES = ("登录", "登录页", "login", "signin", "sign in", "登入", "请登录", "会员登录")
WALL_HINTS = (
    ("请登录", "login"), ("登录后查看", "login"), ("登录后可见", "login"), ("登录后可", "login"),
    ("安全验证", "verify"), ("人机验证", "verify"), ("滑动验证", "verify"), ("行为验证", "verify"),
    ("访问过于频繁", "verify"), ("验证码", "verify"), ("captcha", "verify"),
    ("sign in to continue", "login"), ("log in to continue", "login"), ("verify you are human", "verify"),
)


def detect_block(title, text):
    """识别登录墙 / 验证墙，返回 (类型, 人话说明)。

    策略保守，宁可漏判也不误伤正常页面：
      1) 标题本身就叫「登录」-> 几乎必是墙（链家那类就是这种）
      2) 正文很短（<1200 字）且出现登录/验证提示 -> 墙
    内容丰富的正常页面上有「登录」按钮（页头）不会被误判。
    """
    ti = re.sub(r"[\s|｜\-—_]+", "", (title or "")).strip().lower()
    if ti in LOGIN_TITLES:
        return "login", "页面标题就是「%s」，返回的是登录页而不是目标内容" % (title or "").strip()[:20]
    body = text or ""
    if len(body) >= 1200:
        return "", ""
    low = body.lower()
    for kw, kind in WALL_HINTS:
        if kw in low:
            return kind, "页面只有 %d 字且出现「%s」提示，被%s挡住了" % (
                len(body), kw, "登录墙" if kind == "login" else "验证墙")
    return "", ""


def select_nodes(page, selector, adaptive):
    """按选择器取节点，返回 (nodes, total)"""
    try:
        nodes = list(page.css(selector, adaptive=adaptive))
    except TypeError:
        try:
            nodes = list(page.css(selector))
        except Exception as exc:
            log("selector 解析失败: %s" % exc)
            nodes = []
    except Exception as exc:
        log("selector 解析失败: %s" % exc)
        nodes = []
    return nodes, len(nodes)


def node_text(node):
    try:
        txt = node.text
    except Exception:
        txt = ""
    if not txt:
        try:
            txt = node.get_all_text()
        except Exception:
            txt = ""
    return re.sub(r"\s+", " ", (txt or "")).strip()


def node_html(node):
    try:
        return str(node)[:MAX_ITEM_CHARS]
    except Exception:
        return ""


ATTR_SUFFIX_RE = re.compile(r"@([A-Za-z_][\w:.-]*)\s*$")


def split_field_selector(expr):
    """字段表达式 -> (css 选择器, 取哪个属性)

    "a@href" -> ("a", "href")；".price" -> (".price", "")，空属性表示取文本。
    "@href"   -> ("", "href") 表示取「记录元素自身」的属性 —— 记录选择器本身就是 <a> 时用得上。
    CSS 选择器里不会出现 @，所以按结尾的 @xxx 拆是安全的。
    """
    e = (expr or "").strip()
    m = ATTR_SUFFIX_RE.search(e)
    if m:
        return e[:m.start()].strip(), m.group(1).lower()
    return e, ""


def field_value(node, expr, adaptive):
    """在 node 子树内取一个字段；取不到返回空串（不抛错）"""
    css, attr = split_field_selector(expr)
    if not css and not attr:
        return ""
    if not css:
        nodes = [node]            # "@href" 这种：直接取本元素的属性
    else:
        nodes, _ = select_nodes(node, css, adaptive)
    if not nodes:
        return ""
    el = nodes[0]
    if attr in ("", "text"):
        return node_text(el)[:MAX_FIELD_CHARS]
    if attr in ("html", "outerhtml"):
        return node_html(el)[:MAX_FIELD_CHARS]
    try:
        return str(el.attrib.get(attr, ""))[:MAX_FIELD_CHARS]
    except Exception:
        return ""


def clean_fields(raw):
    """规整字段映射：最多 MAX_FIELDS 个，键值都限长，避免前端传脏数据"""
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in raw.items():
        name = str(k or "").strip()[:40]
        expr = str(v or "").strip()[:200]
        if not name or not expr:
            continue
        out[name] = expr
        if len(out) >= MAX_FIELDS:
            break
    return out


def row_of(node, fields, adaptive):
    """按字段映射抽一行，返回 (字段字典, 汇总文本)"""
    vals, parts = {}, []
    for name, expr in fields.items():
        v = field_value(node, expr, adaptive)
        vals[name] = v
        if v:
            parts.append(v)
    return vals, " | ".join(parts)


def extract_page(page, selector, limit, adaptive, fields):
    """抽取一页内容，返回 (items, total)

    - 有 fields 且有选择器：每条记录一行，行内再按字段选择器取值
    - 有 fields 无选择器：整页一行（用于「把页面上的标题/时间/正文各取一个」）
    - 无 fields：沿用旧行为（文本列表 / 正文片段）
    """
    if fields:
        rows = []
        if selector:
            nodes, total = select_nodes(page, selector, adaptive)
            for node in nodes[:limit]:
                vals, text = row_of(node, fields, adaptive)
                rows.append({"text": text[:MAX_ITEM_CHARS], "html": "", "fields": vals})
        else:
            vals, text = row_of(page, fields, adaptive)
            total = 1
            rows.append({"text": text[:MAX_ITEM_CHARS], "html": "", "fields": vals})
        return rows, total

    if selector:
        nodes, total = select_nodes(page, selector, adaptive)
        items = [{"text": node_text(n)[:MAX_ITEM_CHARS], "html": node_html(n)} for n in nodes[:limit]]
        return items, total

    html = ""
    try:
        html = page.html_content or ""
    except Exception:
        pass
    body = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", html)
    body = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", body)).strip()
    chunk = 300
    pieces = [body[i:i + chunk] for i in range(0, min(len(body), chunk * limit), chunk)]
    return [{"text": p, "html": ""} for p in pieces], len(pieces)


# 「下一页」的判定：精确文案优先，其次中文关键词，最后看 class/aria-label
NEXT_EXACT = {"下一页", "下页", "后一页", "下一頁", "next", "next page", "nextpage", "older",
              "more", "›", "»", "→", ">", "next ›", "next »", "下一页 ›"}
NEXT_SUBSTR = ("下一页", "下页", "后一页", "下一頁")
PAGE_KEYS = ("page", "p", "pg", "pageno", "pageindex")


def find_next_url(page, base_url, visited):
    """找「下一页」：rel=next -> 链接文案/class -> page=N 递增。返回 (url, 依据)"""
    def resolve(href):
        if not href:
            return None
        href = str(href).strip()
        if href.startswith(("javascript:", "mailto:", "#")):
            return None
        u = urllib.parse.urljoin(base_url, href)
        if urllib.parse.urlsplit(u).scheme not in ("http", "https"):
            return None
        if u == base_url or u in visited:
            return None
        return u

    for sel in ('link[rel="next"]', 'a[rel="next"]'):
        try:
            nodes = page.css(sel)
        except Exception:
            continue
        if nodes:
            u = resolve(nodes[0].attrib.get("href"))
            if u:
                return u, "rel=next"

    anchors = []
    try:
        anchors = list(page.css("a"))
    except Exception:
        pass
    for a in anchors:
        try:
            href = a.attrib.get("href")
            cls = (str(a.attrib.get("class", "")) + " " + str(a.attrib.get("aria-label", ""))
                   + " " + str(a.attrib.get("title", ""))).lower()
        except Exception:
            continue
        u = resolve(href)
        if not u:
            continue
        txt = node_text(a).lower()
        if txt in NEXT_EXACT or any(s in txt for s in NEXT_SUBSTR) or "next" in cls:
            return u, "链接文案「%s」" % node_text(a)[:20]

    cur = urllib.parse.urlsplit(base_url)
    q = urllib.parse.parse_qs(cur.query)
    for key in PAGE_KEYS:
        if key not in q:
            continue
        try:
            n = int(q[key][0]) + 1
        except Exception:
            continue
        nq = dict(q)
        nq[key] = [str(n)]
        u = urllib.parse.urlunsplit((cur.scheme, cur.netloc, cur.path,
                                     urllib.parse.urlencode(nq, doseq=True), cur.fragment))
        if u != base_url and u not in visited:
            return u, "page 参数递增到 %d" % n
    return None, ""


def main():
    t0 = time.time()
    raw = sys.stdin.read()
    try:
        req = json.loads(raw or "{}")
    except Exception as exc:
        return die("请求体不是合法 JSON: %s" % exc)

    raw_url = str(req.get("url") or "").strip()
    if not raw_url:
        return die("缺少 url")
    url, note, root = normalize_url(raw_url)
    if url != raw_url:
        log("URL 规范化: %s -> %s (%s)" % (raw_url, url, note or "无备注"))
    selector = str(req.get("selector") or "").strip()
    mode = str(req.get("mode") or "fast").lower()
    if mode not in ("fast", "stealth", "dynamic"):
        return die("mode 必须是 fast / stealth / dynamic")
    try:
        limit = min(int(req.get("limit") or 20), MAX_LIMIT)
    except Exception:
        limit = 20
    adaptive = bool(req.get("adaptive", True))
    respect_robots = bool(req.get("robots", True))
    fields = clean_fields(req.get("fields"))
    try:
        pages_wanted = min(max(int(req.get("pages") or 1), 1), MAX_PAGES)
    except Exception:
        pages_wanted = 1
    try:
        timeout_s = max(3, min(int(req.get("timeout") or 20), 60))
    except Exception:
        timeout_s = 20

    host, err = guard(url)
    if err:
        log("拒绝: %s -> %s" % (url, err))
        return die(err)

    if respect_robots and not robots_allows(url):
        return die("目标 robots.txt 不允许抓取（可在页面勾选忽略）")

    # ---- sample 模式：只抓首页，回样本给 AI 用（不抽取、不翻页）----
    if req.get("sample"):
        try:
            page = do_fetch(url, mode, timeout_s)
            if getattr(page, "status", None) == 404 and root and root != url:
                try:
                    page2 = do_fetch(root, mode, timeout_s)
                    if getattr(page2, "status", None) != 404:
                        page, url = page2, root
                        note = (note + "；" if note else "") + "该路径 404，已回退到站点首页"
                except Exception:
                    pass
        except Exception as exc:
            return die("取样失败(%s): %s" % (mode, str(exc)[:200]))
        raw_html = ""
        try:
            raw_html = page.html_content or ""
        except Exception:
            pass
        title = ""
        m = re.search(r"<title[^>]*>(.*?)</title>", raw_html, re.S | re.I)
        if m:
            title = re.sub(r"\s+", " ", m.group(1)).strip()[:200]
        sample = clean_sample(raw_html)
        text = page_text(raw_html)
        blocked, blocked_reason = detect_block(title, text)
        print(json.dumps({
            "ok": True, "url": url, "note": note, "host": host, "mode": mode,
            "status": getattr(page, "status", None), "title": title,
            "sample": sample[:MAX_SAMPLE_CHARS],
            "sample_chars": len(sample),
            "sample_truncated": len(sample) > MAX_SAMPLE_CHARS,
            "text": text[:MAX_TEXT_CHARS],
            "verify_text": (text + " " + page_attr_values(raw_html))[:MAX_TEXT_CHARS],
            "blocked": blocked, "blocked_reason": blocked_reason,
            "elapsed_ms": int((time.time() - t0) * 1000),
        }, ensure_ascii=False))
        return

    notes = [note] if note else []
    items, page_reports = [], []
    visited = {url}
    current = url
    first_page = None
    first_status = None

    while len(page_reports) < pages_wanted:
        try:
            page = do_fetch(current, mode, timeout_s)
            # 中文拼出来的路径多半不存在：首页 404 时自动回退站点首页再抓一次
            if not page_reports and getattr(page, "status", None) == 404 and root and root != current:
                log("404，回退站点首页: %s" % root)
                try:
                    page2 = do_fetch(root, mode, timeout_s)
                    if getattr(page2, "status", None) != 404:
                        page, current = page2, root
                        visited.add(root)
                        notes.append("该路径 404，已回退到站点首页")
                except Exception as exc2:
                    log("回退失败: %s" % exc2)
        except Exception as exc:
            msg = str(exc)[:200]
            if not page_reports:
                if "Name or service not known" in msg or "nodename nor servname" in msg:
                    return die("DNS 解析失败：%s（请检查域名是否写对，或该域名在本机不可解析）" % url)
                return die("抓取失败(%s): %s: %s" % (mode, type(exc).__name__, msg))
            notes.append("第 %d 页抓取失败，已停止翻页：%s" % (len(page_reports) + 1, msg[:120]))
            break

        if first_page is None:
            first_page, first_status = page, getattr(page, "status", None)

        page_items, page_total = extract_page(page, selector, limit, adaptive, fields)
        items.extend(page_items)
        page_reports.append({"url": current, "status": getattr(page, "status", None),
                             "count": len(page_items), "total": page_total})

        if len(page_reports) >= pages_wanted:
            break
        # 翻过头了：page=N 递增这类猜法在最后一页之后会继续给出 URL，
        # 用「这一页一条都没匹配到」当结束信号，避免白跑（最多也就 pages 页）。
        if len(page_reports) > 1 and not page_items:
            notes.append("第 %d 页没有匹配到内容，已停止翻页" % len(page_reports))
            break
        nxt, why = find_next_url(page, current, visited)
        if not nxt:
            notes.append("第 %d 页后没有「下一页」链接，已停止翻页" % len(page_reports))
            break
        if respect_robots and not robots_allows(nxt):
            notes.append("「下一页」robots.txt 不允许抓取，已停止翻页")
            break
        log("翻页 -> %s (%s)" % (nxt, why))
        time.sleep(PAGE_DELAY_S)
        visited.add(nxt)
        current = nxt

    if not items and not page_reports:
        return die("没有抓到任何内容")

    html = ""
    try:
        html = (first_page.html_content or "") if first_page is not None else ""
    except Exception:
        pass
    if len(html) > MAX_HTML_CHARS:
        html = html[:MAX_HTML_CHARS]

    title = ""
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    if m:
        title = re.sub(r"\s+", " ", m.group(1)).strip()[:200]

    blocked, blocked_reason = detect_block(title, page_text(html))
    if blocked and not items:
        log("疑似被墙: %s (%s)" % (blocked, blocked_reason))

    result = {
        "ok": True,
        "url": url,
        "note": "；".join(notes),
        "host": host,
        "mode": mode,
        "adaptive": adaptive,
        "selector": selector or "(正文)",
        "status": first_status,
        "title": title,
        "count": len(items),
        "total": sum(r["total"] for r in page_reports),
        "items": items,
        "fields": list(fields),
        "pages_requested": pages_wanted,
        "pages_fetched": len(page_reports),
        "pages": page_reports,
        "blocked": blocked,
        "blocked_reason": blocked_reason,
        "elapsed_ms": int((time.time() - t0) * 1000),
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        die("执行器异常: %s: %s" % (type(exc).__name__, str(exc)[:200]))
