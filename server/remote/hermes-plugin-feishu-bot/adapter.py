"""Feishu platform adapter — 出站通知，两条通道。

用途：把 Hermes cron 的告警投递到飞书群。

两条通道，优先用应用机器人：
  · 应用机器人（app_id + app_secret + chat_id）：能指定群、能收消息回调，
    发消息走 im/v1/messages，标题里带身份。
  · 自定义机器人 webhook（https://open.feishu.cn/open-apis/bot/v2/hook/...）：
    只出不进，配好就能用。

优先用应用机器人的理由：面板那边（个人工作台）已经用同一套凭据接了长连接，
"发"和"收"走同一套配置；自定义机器人只能单向发，脚本收不到任何回调。

配置来源，按优先级：
  1. config.yaml 的 platforms.feishu_bot.extra
  2. 环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID
  3. 面板推下来的 ~/.hermes/state/feishu_bot.json（0600，面板是唯一真源）
  4. webhook：FEISHU_BOT_WEBHOOK_URL / FEISHU_BOT_SECRET

平台名：feishu_bot。cron 里写 `--deliver feishu_bot` 即可；
也可以写 `feishu_bot:任意标识`（webhook 模式没有会话概念）。
"""

from __future__ import annotations

import base64
import datetime
import hashlib
import hmac
import json
import logging
import re
import time
from pathlib import Path
from typing import Any, Optional

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:  # pragma: no cover - Hermes 自带 httpx
    HTTPX_AVAILABLE = False
    httpx = None  # type: ignore[assignment]

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms._shared import (
    extra_or_secret as _extra_or_secret,
    get_scoped_secret as _get_scoped_secret,
    send_error,
)
from gateway.platforms.send_targets import parse_nonempty

logger = logging.getLogger(__name__)

PLATFORM_NAME = "feishu_bot"
MAX_MESSAGE_LENGTH = 12000  # 飞书文本上限约 30KB，留足余量
TIMEOUT_SECONDS = 15.0
FEISHU_API = "https://open.feishu.cn/open-apis"

# 面板推下来的那份配置（唯一真源）。读不到就只走 webhook，不算错。
STATE_FILE = Path.home() / ".hermes" / "state" / "feishu_bot.json"


def _webhook_url(extra: dict[str, Any] | None = None) -> str:
    """自定义机器人的 webhook 地址。

    优先级：extra → **面板推下来的 state 文件** → 环境变量。
    之前是 extra → 环境变量，于是助手机 .env 里那个老地址一直盖着面板上
    填的那个，通知发到哪个群取决于哪份配置先被读到 —— 现在以面板为准。
    """
    from_extra = str((extra or {}).get("webhook_url") or "").strip()
    if from_extra:
        return from_extra
    from_state = str(_read_state().get("webhook_url") or "").strip()
    if from_state:
        return from_state
    return str(_extra_or_secret(extra or {}, "webhook_url", "FEISHU_BOT_WEBHOOK_URL") or "").strip()


def _secret(extra: dict[str, Any] | None = None) -> str:
    """签名密钥。与 webhook 同一套优先级：面板推下来的那份优先。"""
    from_extra = str((extra or {}).get("secret") or "").strip()
    if from_extra:
        return from_extra
    from_state = str(_read_state().get("secret") or "").strip()
    if from_state:
        return from_state
    return str(_extra_or_secret(extra or {}, "secret", "FEISHU_BOT_SECRET") or "").strip()


def _read_state() -> dict[str, Any]:
    """读面板推下来的那份配置。读不到就当没有 —— 只影响"用哪条通道"，
    不该让整个插件起不来。"""
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _app_credentials(extra: dict[str, Any] | None = None) -> tuple[str, str, str]:
    """应用机器人三元组。extra/环境变量优先，其次读面板推下来的那份。"""
    app_id = str(_extra_or_secret(extra or {}, "app_id", "FEISHU_APP_ID") or "").strip()
    app_secret = str(_extra_or_secret(extra or {}, "app_secret", "FEISHU_APP_SECRET") or "").strip()
    chat_id = str(_extra_or_secret(extra or {}, "chat_id", "FEISHU_CHAT_ID") or "").strip()
    if not (app_id and app_secret and chat_id):
        state = _read_state()
        app_id = app_id or str(state.get("app_id") or "").strip()
        app_secret = app_secret or str(state.get("app_secret") or "").strip()
        chat_id = chat_id or str(state.get("chat_id") or "").strip()
    return app_id, app_secret, chat_id


# ── 统一的卡片格式 ─────────────────────────────────────────────────────
# 与面板侧 server/services/feishu-bot.js 的 buildNoticeCard 保持一致：
#   标题（header，模板色表示轻重）+ 正文（lark_md）+ 尾注（来源 · 时间）
# 之前这里是裸文本，还带着 Hermes cron 的框架包装
# （"Cronjob Response: …(job_id: …)" + 一行分隔线），群里看过去像三样东西。
NOTICE_TONE = {
    "info": "blue",
    "success": "green",
    "warning": "orange",
    "error": "red",
    "neutral": "grey",
}

_CRON_PREFIX = "Cronjob Response:"


def _now_stamp() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _notice_card(title: str, body: str, tone: str = "info", source: str = "Hermes") -> dict[str, Any]:
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": NOTICE_TONE.get(tone, "blue"),
            "title": {"tag": "plain_text", "content": (title or "通知")[:80]},
        },
        "elements": [
            {"tag": "div", "text": {"tag": "lark_md", "content": (body or "")[:3000]}},
            {"tag": "note", "elements": [{"tag": "plain_text", "content": f"{source} · {_now_stamp()}"}]},
        ],
    }


def _split_cron_text(text: str) -> tuple[str, str]:
    """把 cron 的包装拆成标题/正文。

    原文长这样：
        Cronjob Response: 运维值守·边界攻击研判
        (job_id: 152476278abc)
        ----------
        研判完成：…

    拆不出来就整段当正文 —— 宁可标题难看，也别把内容丢了。
    """
    t = (text or "").strip()
    if t.startswith(_CRON_PREFIX):
        t = t[len(_CRON_PREFIX):].strip()
    title, body = "", t
    if "\n----------" in t:
        head, tail = t.split("\n----------", 1)
        title, body = head.strip(), tail.strip()
    elif t.startswith("----------"):
        body = t.split("----------", 1)[-1].strip()
    title = re.sub(r"\s*\(job_id:[^)]*\)\s*$", "", title).strip()
    if not title and body:
        first, _, rest = body.partition("\n")
        title = first.strip()
        body = rest.strip() or first.strip()
    return title, body


_geo_module = None


def _frp_guard_geo():
    """复用 frp_guard 的地理查询（同一份缓存 ~/.hermes/cache/ip_geo.json）。

    不自己再查一遍：那边已经在用 ip-api 且带缓存与失败退避，
    这里再开一路只会多一次外部请求、两份不一致的缓存。
    """
    global _geo_module
    if _geo_module is None:
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "frp_guard_geo", "/root/.hermes/scripts/frp_guard.py"
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _geo_module = mod
    return _geo_module


def _geo_place(ip: str) -> str:
    try:
        g = _frp_guard_geo().geo_lookup(ip) or {}
        # place 可能是「新加坡 新加坡」这种国家与城市同名的，去掉重复
        parts = [p for p in str(g.get("place") or "").split() if p]
        uniq: list[str] = []
        for p in parts:
            if p not in uniq:
                uniq.append(p)
        return " ".join(uniq)
    except Exception:
        return ""


_IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")


def _enrich_ips(text: str) -> str:
    """正文里的公网 IP 补上地区：「1.2.3.4 爆破」→「1.2.3.4（荷兰 阿姆斯特丹） 爆破」。

    内网与保留段跳过（查了也没意义）。查不到就原样留着 ——
    补一句"未知地区"只会更吵。
    """
    src = text or ""
    hits = _IP_RE.findall(src)
    if not hits:
        return src
    import ipaddress

    places: dict[str, str] = {}
    for ip in set(hits):
        try:
            if not ipaddress.ip_address(ip).is_global:
                continue
        except ValueError:
            continue
        place = _geo_place(ip)
        if place:
            places[ip] = place
    if not places:
        return src

    def repl(m: "re.Match[str]") -> str:
        ip = m.group(0)
        place = places.get(ip)
        if not place:
            return ip
        end = m.end()
        if end < len(src) and src[end] in "）)":
            return ip
        return ip + "（" + place + "）"

    return _IP_RE.sub(repl, src)


def _build_payload(text: str, secret: str, card: dict[str, Any] | None = None) -> dict[str, Any]:
    if card is not None:
        # webhook 的卡片字段叫 card（与 im/v1/messages 的 content 不同）
        payload: dict[str, Any] = {"msg_type": "interactive", "card": card}
    else:
        body = text if len(text) <= MAX_MESSAGE_LENGTH else text[: MAX_MESSAGE_LENGTH] + "\n…（已截断）"
        payload = {"msg_type": "text", "content": {"text": body}}
    if secret:
        ts = str(int(time.time()))
        # 飞书算法：以 "<timestamp>\n<secret>" 为 key，空消息做 HMAC-SHA256 后 base64
        key = f"{ts}\n{secret}".encode("utf-8")
        sign = base64.b64encode(hmac.new(key, b"", digestmod=hashlib.sha256).digest()).decode("utf-8")
        payload["timestamp"] = ts
        payload["sign"] = sign
    return payload


def _response_ok(resp: Any) -> tuple[bool, str]:
    """飞书两代返回格式都认：code==0 或 StatusCode==0。"""
    try:
        data = resp.json()
    except Exception:
        return (200 <= resp.status_code < 300), resp.text[:200]
    code = data.get("code", data.get("StatusCode", data.get("status_code")))
    if code == 0:
        return True, ""
    msg = data.get("msg") or data.get("StatusMessage") or data.get("message") or resp.text[:200]
    return False, f"code={code} {msg}"


async def _post(url: str, text: str, secret: str, card: dict[str, Any] | None = None) -> dict[str, Any]:
    if not HTTPX_AVAILABLE:
        return send_error("飞书投递失败：httpx 未安装")
    if not url:
        return send_error("飞书投递失败：未配置 FEISHU_BOT_WEBHOOK_URL")
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            resp = await client.post(url, json=_build_payload(text, secret, card))
    except Exception as exc:
        return send_error(f"飞书投递失败：{exc}")
    ok, detail = _response_ok(resp)
    if not ok:
        return send_error(f"飞书返回 HTTP {resp.status_code}：{detail}")
    return {"success": True, "platform": PLATFORM_NAME, "message_id": str(int(time.time() * 1000))}


async def _tenant_token(app_id: str, app_secret: str) -> str:
    """换 tenant_access_token。飞书那句原话抛出去 ——
    "app_secret invalid" 比 "发送失败" 有用得多。"""
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        resp = await client.post(
            f"{FEISHU_API}/auth/v3/tenant_access_token/internal",
            json={"app_id": app_id, "app_secret": app_secret},
        )
    try:
        data = resp.json()
    except Exception:
        raise RuntimeError(f"取 tenant_access_token 失败：HTTP {resp.status_code}")
    token = data.get("tenant_access_token")
    if not token:
        raise RuntimeError(f"取 tenant_access_token 失败：{data.get('msg') or resp.status_code}")
    return str(token)


async def _post_app(
    app_id: str,
    app_secret: str,
    chat_id: str,
    text: str,
    card: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """应用机器人发消息。走 im/v1/messages，消息带应用身份。"""
    if not HTTPX_AVAILABLE:
        return send_error("飞书投递失败：httpx 未安装")
    if not chat_id:
        return send_error("飞书投递失败：未配置群 chat_id")
    if card is not None:
        # API 的卡片放在 content 里（webhook 那边字段名是 card，别混了）
        payload: dict[str, Any] = {
            "receive_id": chat_id,
            "msg_type": "interactive",
            "content": json.dumps(card, ensure_ascii=False),
        }
    else:
        body = text if len(text) <= MAX_MESSAGE_LENGTH else text[: MAX_MESSAGE_LENGTH] + "\n…（已截断）"
        payload = {
            "receive_id": chat_id,
            "msg_type": "text",
            "content": json.dumps({"text": body}, ensure_ascii=False),
        }
    try:
        token = await _tenant_token(app_id, app_secret)
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            resp = await client.post(
                f"{FEISHU_API}/im/v1/messages",
                params={"receive_id_type": "chat_id"},
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
            )
    except Exception as exc:
        return send_error(f"飞书投递失败：{exc}")
    ok, detail = _response_ok(resp)
    if not ok:
        return send_error(f"飞书返回 HTTP {resp.status_code}：{detail}")
    message_id = ""
    try:
        message_id = str((resp.json().get("data") or {}).get("message_id") or "")
    except Exception:
        message_id = ""
    return {
        "success": True,
        "platform": PLATFORM_NAME,
        "message_id": message_id or str(int(time.time() * 1000)),
    }


async def _deliver(
    text: str,
    *,
    extra: dict[str, Any] | None = None,
    url: str = "",
    secret: str = "",
    chat_id: str = "",
    title: str | None = None,
    tone: str = "info",
    source: str = "Hermes · 助手机",
) -> dict[str, Any]:
    """统一出口：应用机器人优先，webhook 回落；一律按统一卡片格式发。

    chat_id 参数在 cron 里是"目标标识"（home channel 的名字），不是飞书会话 id；
    只有它长得像 oc_ 开头时才当作真会话用，否则用配置里的那个群。
    """
    head, body = _split_cron_text(text)
    body = _enrich_ips(body)
    card = _notice_card(title or head or "通知", body, tone=tone, source=source)
    app_id, app_secret, app_chat = _app_credentials(extra)
    target = app_chat
    if chat_id and str(chat_id).startswith("oc_"):
        target = str(chat_id)
    if app_id and app_secret and target:
        return await _post_app(app_id, app_secret, target, text, card=card)
    return await _post(url, text, secret, card=card)


# ── 平台探测（gateway status / cron 用）──────────────────────────────

def check_requirements() -> bool:
    return HTTPX_AVAILABLE


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    if _webhook_url(extra):
        return True
    app_id, app_secret, chat_id = _app_credentials(extra)
    return bool(app_id and app_secret and chat_id)


def is_connected(config) -> bool:
    return validate_config(config)


def _env_enablement() -> dict | None:
    app_id, app_secret, chat_id = _app_credentials()
    home = _get_scoped_secret("FEISHU_BOT_HOME_CHANNEL", "").strip() or "feishu-bot"
    if app_id and app_secret and chat_id:
        return {"app_id": app_id, "app_secret": app_secret, "chat_id": chat_id, "home_channel": home}
    url = _webhook_url()
    if not url:
        return None
    return {"webhook_url": url, "home_channel": home}


# ── 适配器（只出站）──────────────────────────────────────────────────

class FeishuBotAdapter(BasePlatformAdapter):
    """Feishu custom bot: no inbound stream, every send POSTs the webhook."""

    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform(PLATFORM_NAME))
        extra = getattr(config, "extra", {}) or {}
        self._extra = extra
        self._url = _webhook_url(extra)
        self._secret = _secret(extra)
        self._app_id, self._app_secret, self._app_chat = _app_credentials(extra)

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not self._url and not (self._app_id and self._app_secret and self._app_chat):
            logger.warning(
                "[%s] 既没有 FEISHU_BOT_WEBHOOK_URL，也没有应用机器人凭据（app_id/app_secret/chat_id）",
                self.name,
            )
            return False
        self._mark_connected()
        logger.info(
            "[%s] 已就绪（出站，%s）",
            self.name,
            "应用机器人" if self._app_id and self._app_secret else "webhook",
        )
        return True

    async def disconnect(self) -> None:
        self._mark_disconnected()

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        """Webhook 模式没有会话概念：chat_id 只是个标识，不查远端。"""
        return {"name": chat_id, "type": "group"}

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> SendResult:
        result = await _deliver(
            content, extra=self._extra, url=self._url, secret=self._secret, chat_id=chat_id
        )
        if result.get("success"):
            return SendResult(success=True, message_id=result.get("message_id"))
        return SendResult(success=False, error=result.get("error") or "飞书投递失败")


# ── cron 独立投递（网关不在或任务由独立进程执行时）──────────────────

async def _standalone_send(
    pconfig,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[list[str]] = None,
    force_document: bool = False,
) -> dict[str, Any]:
    extra = getattr(pconfig, "extra", {}) or {}
    url = _webhook_url(extra) or _get_scoped_secret("FEISHU_BOT_WEBHOOK_URL", "").strip()
    secret = _secret(extra) or _get_scoped_secret("FEISHU_BOT_SECRET", "").strip()
    return await _deliver(message, extra=extra, url=url, secret=secret, chat_id=chat_id)


def register(ctx) -> None:
    """Plugin entry point."""
    ctx.register_platform(
        name=PLATFORM_NAME,
        label="Feishu Bot",
        adapter_factory=lambda cfg: FeishuBotAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        target_ref_syntax_fn=parse_nonempty,
        cron_deliver_env_var="FEISHU_BOT_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        env_enablement_fn=_env_enablement,
        required_env=[],
        max_message_length=MAX_MESSAGE_LENGTH,
        emoji="🤖",
        pii_safe=True,
        platform_hint="飞书出站通知：优先用应用机器人（app_id/app_secret/chat_id），没有则用自定义机器人 webhook；只发不收（接收由个人工作台的长连接负责）。",
    )
