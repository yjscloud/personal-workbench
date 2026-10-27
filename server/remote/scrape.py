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
 3. 校验用的地址就是连接的地址：浏览器模式把它钉进 --host-resolver-rules，
    不让抓取器自己再解析一遍（防 DNS rebinding）；fast 模式钉不住，只能靠
    Scrapling 自带的 follow_redirects="safe"
 4. 重定向最多 MAX_REDIRECTS 跳，翻页链接逐跳重新校验，落地后再看一次最终地址；
    robots.txt 的请求同样逐跳校验
 5. 默认遵守 robots.txt，可用 robots:false 显式跳过
 6. 限制抓取条数、单条长度与总耗时
"""
import ipaddress
import json
import os
import re
import socket
import sys
import time
import urllib.error
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
MAX_REDIRECTS = 3          # 重定向跳数上限（和面板侧 http.js 的那个 3 对齐）

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
    ipaddress.ip_network("192.0.2.0/24"),     # 文档示例段
    ipaddress.ip_network("198.51.100.0/24"),
    ipaddress.ip_network("203.0.113.0/24"),
    ipaddress.ip_network("198.18.0.0/15"),    # RFC2544 保留段，见 guard() 里的 fake-ip 例外
]

# 本机 DNS 走了透明代理的 fake-ip 模式：公网域名一律解析成 198.18.x.x 的占位
# 地址，真正连的是代理（实测连上去 200）。把它当内网拦掉的话，这台机器上一个
# 公网站点都抓不了 —— 所以只对「域名解析出来的」放行，域名直接写成
# 198.18.x.x 的照旧拒绝：那种才是真在打这个网段。
FAKE_IP_NET = ipaddress.ip_network("198.18.0.0/15")


def log(msg):
    sys.stderr.write("[scrape] %s\n" % msg)


def die(msg):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(0)


def guard(url):
    """SSRF 前置检查，返回 (host, pinned_ip, error)

    pinned_ip 是这次校验**用的那个地址**。把它交给抓取器钉死（浏览器模式走
    --host-resolver-rules，fast 模式做不到，见 do_fetch），校验的地址和真正
    连的地址才是同一个 —— 否则中间换成内网 IP 就是一次 DNS rebinding。
    字面量 IP 或放开内网调试（SCRAPE_ALLOW_PRIVATE=1）时不给钉子。
    """
    try:
        u = urllib.parse.urlsplit(url.strip())
    except Exception as exc:
        return None, None, "URL 解析失败: %s" % exc

    if u.scheme not in ("http", "https"):
        return None, None, "仅支持 http/https，收到: %s" % (u.scheme or "空")
    host = u.hostname
    if not host:
        return None, None, "URL 缺少主机名"

    # 允许 /etc/agent-office/scrape-allow.txt 里的域名白名单（可选）
    allow_file = os.environ.get("SCRAPE_ALLOW_FILE", "")
    if allow_file and os.path.isfile(allow_file):
        allowed = [ln.strip().lower() for ln in open(allow_file, encoding="utf-8") if ln.strip()]
        if allowed and not any(host.lower() == a or host.lower().endswith("." + a) for a in allowed):
            return None, None, "域名不在白名单中: %s" % host

    if os.environ.get("SCRAPE_ALLOW_PRIVATE") == "1":
        return host, None, None

    try:
        ipaddress.ip_address(host.strip("[]"))
        literal = True
    except ValueError:
        literal = False

    try:
        port = u.port or (443 if u.scheme == "https" else 80)
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except Exception as exc:
        return None, None, "DNS 解析失败: %s" % exc

    ips = []
    for _, _, _, _, sockaddr in infos:
        ip_raw = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_raw)
        except ValueError:
            return None, None, "非法 IP: %s" % ip_raw
        # 用 nginx/网关地址也一并拦掉：即便解析到本机也不放行
        for net in BLOCKED_NETWORKS:
            if ip in net:
                if net == FAKE_IP_NET and not literal:
                    break          # 透明代理的 fake-ip 占位地址，见 FAKE_IP_NET
                return None, None, "目标指向内网/保留地址，已拒绝: %s (%s)" % (host, ip)
        ips.append(str(ip))

    if literal:
        return host, None, None        # 本来就是字面量 IP，没什么可钉的
    # 去重保序，钉第一个：一条 MAP 规则只能给一个地址，浏览器本来也只挑一个用
    return host, (list(dict.fromkeys(ips))[0] if ips else None), None


class _GuardedRedirect(urllib.request.HTTPRedirectHandler):
    """robots.txt 的请求也要逐跳校验：一个 302 就能把它带去内网。

    urlopen 默认会自己跟重定向，且不看落点；这里在跳之前先过一遍 guard。
    """
    max_redirections = MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _, _, err = guard(newurl)
        if err:
            raise urllib.error.URLError("重定向被拒绝: %s" % err)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_ROBOTS_OPENER = urllib.request.build_opener(_GuardedRedirect())


def robots_allows(url, timeout=6):
    try:
        parts = urllib.parse.urlsplit(url)
        base = "%s://%s" % (parts.scheme, parts.netloc)
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(base + "/robots.txt")
        req = urllib.request.Request(base + "/robots.txt", headers={"User-Agent": "HarvesterBot/1.0"})
        with _ROBOTS_OPENER.open(req, timeout=timeout) as resp:
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


def resolver_rule(url, pinned_ip):
    """把「域名 -> 校验过的那个 IP」写进 Chromium 的解析器。

    Scrapling 没有给固定 DNS 的参数（fast / dynamic / stealth 都没有），
    但浏览器模式的 extra_flags 是原样拼进启动参数的，所以用 Chromium 自己的
    --host-resolver-rules 钉住：它解析这个域名时只会拿到我们校验过的地址，
    也就关掉了「校验时是公网、连接时变成内网」的窗口。IPv6 要加方括号。
    """
    if not pinned_ip:
        return None
    host = urllib.parse.urlsplit(url).hostname
    if not host:
        return None
    ip = "[%s]" % pinned_ip if ":" in pinned_ip else pinned_ip
    return "--host-resolver-rules=MAP %s %s" % (host, ip)


# 本轮被抓掉的地址，只用来给报错补一句人话
_BLOCKED_URLS = []


def route_guard(page):
    """给浏览器加一层请求拦截：子资源（图片 / iframe / XHR）打内网时直接掐掉。

    --host-resolver-rules 只钉得住起始域名，页面里塞一个指向
    http://192.168.1.1/ 的 <img>，Chromium 照样会连过去。这里每个请求判一次
    （按主机名缓存结果，不会每个子资源都去解析一遍）。

    一个必须说清楚的边界：Playwright 的 page.route **拦不到重定向产生的新请求**
    （实测 302 到 127.0.0.1 时事件根本不触发），所以主文档被跳转只能靠
    fetch_page 落地后的最终地址校验兜底 —— 那一跳的内容已经拉回来了，只是
    不往上层返。子资源这一层是真拦在发出之前的。
    """
    seen = {}

    def allowed(target):
        if target.startswith(("data:", "blob:", "about:", "chrome:", "devtools:")):
            return True
        try:
            host = urllib.parse.urlsplit(target).hostname or ""
        except Exception:
            return False
        if not host:
            return True
        if host not in seen:
            seen[host] = guard(target)[2] is None
        return seen[host]

    def handler(route):
        target = route.request.url
        if allowed(target):
            route.continue_()
        else:
            if len(_BLOCKED_URLS) < 5:
                _BLOCKED_URLS.append(target)
            route.abort()

    page.route("**/*", handler)


def do_fetch(url, mode, timeout_s, pinned_ip=None):
    """抓一页。pinned_ip 来自 guard()，浏览器模式下会被钉死。"""
    if mode == "fast":
        from scrapling.fetchers import Fetcher
        # fast 走 curl_cffi，没有钉 DNS 的口子（只能连 IP 再手动补 Host 头，
        # 那样 https 的证书校验就没法看了）。它自带的重定向策略能顶一部分：
        # follow_redirects="safe" 会拒绝跳到内网/保留地址的重定向。默认就是
        # 它，这里写明是为了不被上游改默认值悄悄带走；跳数也从 30 收到 3。
        return Fetcher.get(url, timeout=timeout_s,
                           follow_redirects="safe", max_redirects=MAX_REDIRECTS)

    flags = resolver_rule(url, pinned_ip)
    extra = [flags] if flags else None
    if mode == "dynamic":
        from scrapling.fetchers import DynamicFetcher
        return DynamicFetcher.fetch(url, headless=True, disable_resources=True,
                                    timeout=timeout_s * 1000, extra_flags=extra,
                                    page_setup=route_guard)
    from scrapling.fetchers import StealthyFetcher
    return StealthyFetcher.fetch(url, headless=True, timeout=timeout_s * 1000,
                                 extra_flags=extra, page_setup=route_guard)


def fetch_page(url, mode, timeout_s, pinned_ip=None):
    """抓一页，并且确认它最终落在允许的地址上。

    两层保险：跳之前每个请求都过 route_guard（浏览器模式），落地后再看一次
    最终地址 —— 万一哪条路绕过了拦截，内容和样本也一律不往上层返。
    """
    del _BLOCKED_URLS[:]
    try:
        page = do_fetch(url, mode, timeout_s, pinned_ip)
    except Exception as exc:
        if _BLOCKED_URLS:
            raise RuntimeError("拦截了指向内网/保留地址的请求: %s" % _BLOCKED_URLS[0])
        # curl 那边把内网 IP 直接写进英文错误里（Redirect to internal IP ...）：
        # 换成人话，也别把地址原样回显出去
        if "SSRF protection" in str(exc):
            raise RuntimeError("目标站点重定向到内网/保留地址，已拒绝")
        raise
    final = str(getattr(page, "url", "") or url)
    _, _, err = guard(final)
    if err:
        raise RuntimeError("重定向到了不允许的地址: %s" % err)
    return page


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

    host, pinned_ip, err = guard(url)
    if err:
        log("拒绝: %s -> %s" % (url, err))
        return die(err)

    if respect_robots and not robots_allows(url):
        return die("目标 robots.txt 不允许抓取（可在页面勾选忽略）")

    # ---- sample 模式：只抓首页，回样本给 AI 用（不抽取、不翻页）----
    if req.get("sample"):
        try:
            page = fetch_page(url, mode, timeout_s, pinned_ip)
            if getattr(page, "status", None) == 404 and root and root != url:
                try:
                    page2 = fetch_page(root, mode, timeout_s, pinned_ip)
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
    current_ip = pinned_ip
    first_page = None
    first_status = None

    while len(page_reports) < pages_wanted:
        try:
            page = fetch_page(current, mode, timeout_s, current_ip)
            # 中文拼出来的路径多半不存在：首页 404 时自动回退站点首页再抓一次
            if not page_reports and getattr(page, "status", None) == 404 and root and root != current:
                log("404，回退站点首页: %s" % root)
                try:
                    page2 = fetch_page(root, mode, timeout_s, current_ip)
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
        # 「下一页」是站点给的链接，可能直接写着内网地址：每一跳都重新校验，
        # 并且用这一跳自己解析出来的 IP 去钉，不沿用首页那一个
        _, nxt_ip, nxt_err = guard(nxt)
        if nxt_err:
            notes.append("「下一页」指向不允许的地址（%s），已停止翻页" % nxt_err)
            break
        if respect_robots and not robots_allows(nxt):
            notes.append("「下一页」robots.txt 不允许抓取，已停止翻页")
            break
        log("翻页 -> %s (%s)" % (nxt, why))
        time.sleep(PAGE_DELAY_S)
        visited.add(nxt)
        current, current_ip = nxt, nxt_ip

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
