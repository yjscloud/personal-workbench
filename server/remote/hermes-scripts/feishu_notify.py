#!/usr/bin/env python3
"""飞书通知的公共发送层：审批卡之外的所有卡片与文本都从这里走。

为什么要单开一份：读配置、取 tenant_access_token、发/改消息、判断"这类
通知关了没有"这几件事，封禁卡和值守研判卡都要用。它们一度长在
feishu_ban_card 里，后来 ban 被收窄成"只做审批卡"，这些函数连同
NotifyDisabled 一起被删掉 —— ops 那边 `import feishu_ban_card as base`
就炸成 AttributeError: send_card，正式发卡链路整条断掉。

所以现在的分界是：
    feishu_notify    发送层（配置 / 开关 / HTTP），谁都能 import
    feishu_ban_card  审批卡（带按钮，必须走应用机器人，不能被开关静默吞掉）
    feishu_ops_card  值守研判卡（纯通知，受开关约束）

配置优先级：面板推下来的 ~/.hermes/state/feishu_bot.json
          > ~/.hermes/.env
          > 进程环境变量
面板是唯一真源：人在页面上刚改的才算数，.env 是老配置；"面板里清空密钥"
也必须生效，所以 state 里的空串会照样覆盖。

开关：enabled 是总闸，notify_ban / notify_ops 是分类闸。关掉时抛
NotifyDisabled —— 那是"跳过"，不是失败，调用方打一行日志正常退出即可。
"""

from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

ENV_PATH = Path("/root/.hermes/.env")
STATE_PATH = Path(os.path.expanduser("~/.hermes/state/feishu_bot.json"))
API = "https://open.feishu.cn/open-apis"
DEFAULT_CHAT_ID = "oc_3cf36f0c7ee91ff7aa4a0113af434876"
TIMEOUT = 12

# 开关的三种关闭写法都认：面板推的是 JSON 布尔，.env 里人可能写 false / no
_OFF = ("0", "false", "False", "no")


class NotifyDisabled(RuntimeError):
    """设置页把这类通知关了。不是失败，调用方按"跳过"处理。"""


# ── 配置 ────────────────────────────────────────────────────────────────

def settings_file() -> dict:
    """面板推过来的那份配置。读不到 / 读坏了都当"没配过"，不抛。"""
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def load_env() -> dict[str, str]:
    """读配置：设置页那份优先，.env 兜底。"""
    cfg: dict[str, str] = {}
    try:
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip().strip("'\"")
    except OSError:
        pass
    for k, v in os.environ.items():
        cfg.setdefault(k, v)

    s = settings_file()
    if s:
        cfg["FEISHU_BOT_ENABLED"] = "1" if s.get("enabled", True) else "0"
        cfg["FEISHU_NOTIFY_BAN"] = "1" if s.get("notify_ban", True) else "0"
        cfg["FEISHU_NOTIFY_OPS"] = "1" if s.get("notify_ops", True) else "0"
        if str(s.get("webhook_url") or "").strip():
            cfg["FEISHU_BOT_WEBHOOK_URL"] = str(s["webhook_url"]).strip()
        if "secret" in s:
            cfg["FEISHU_BOT_SECRET"] = str(s.get("secret") or "")
        # 应用凭据同样以面板为准。不做这一步的话，发卡用的是 .env 里的老
        # App ID，而面板长连接用的是设置页里的那个 —— 两个不是同一个应用时，
        # PATCH 卡片会因为没有权限失败，按钮回调也收不到，表现就是「不同步」。
        for key, skey in (("FEISHU_APP_ID", "app_id"),
                          ("FEISHU_APP_SECRET", "app_secret"),
                          ("FEISHU_BAN_CHAT_ID", "chat_id")):
            val = str(s.get(skey) or "").strip()
            if val:
                cfg[key] = val
    return cfg


def _check_switch(cfg: dict, kind: str | None) -> None:
    """总开关 + 分类开关。关了就是关了，不要默默发出去。"""
    if str(cfg.get("FEISHU_BOT_ENABLED", "1")) in _OFF:
        raise NotifyDisabled("飞书机器人在设置页被关掉了")
    key = {"ban": "FEISHU_NOTIFY_BAN", "ops": "FEISHU_NOTIFY_OPS"}.get(kind or "")
    if key and str(cfg.get(key, "1")) in _OFF:
        raise NotifyDisabled("这类通知在设置页被关掉了（%s）" % kind)


# ── 飞书 API ────────────────────────────────────────────────────────────

def tenant_token(cfg: dict[str, str]) -> str:
    app_id = cfg.get("FEISHU_APP_ID", "")
    app_secret = cfg.get("FEISHU_APP_SECRET", "")
    if not app_id or not app_secret:
        raise RuntimeError("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET")
    body = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode()
    req = urllib.request.Request(
        f"{API}/auth/v3/tenant_access_token/internal",
        data=body, headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        data = json.loads(resp.read())
    if data.get("code") != 0:
        raise RuntimeError(f"取 tenant_access_token 失败：{data.get('msg')}")
    return data["tenant_access_token"]


def post_message(token: str, chat_id: str, card: dict) -> str:
    payload = {"receive_id": chat_id, "msg_type": "interactive",
               "content": json.dumps(card, ensure_ascii=False)}
    req = urllib.request.Request(
        f"{API}/im/v1/messages?receive_id_type=chat_id",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        data = json.loads(resp.read())
    if data.get("code") != 0:
        raise RuntimeError(f"发卡片失败：{data.get('code')} {data.get('msg')}")
    return str((data.get("data") or {}).get("message_id") or "")


def post_text(token: str, chat_id: str, text: str) -> str:
    """纯文本消息。自动封禁已经执行完，不需要按钮 —— 带按钮的卡片只会让人
    以为还得点一下。"""
    payload = {"receive_id": chat_id, "msg_type": "text",
               "content": json.dumps({"text": text}, ensure_ascii=False)}
    req = urllib.request.Request(
        f"{API}/im/v1/messages?receive_id_type=chat_id",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        data = json.loads(resp.read())
    if data.get("code") != 0:
        raise RuntimeError(f"发消息失败：{data.get('code')} {data.get('msg')}")
    return str((data.get("data") or {}).get("message_id") or "")


def patch_message(token: str, message_id: str, card: dict) -> None:
    req = urllib.request.Request(
        f"{API}/im/v1/messages/{message_id}",
        data=json.dumps({"content": json.dumps(card, ensure_ascii=False)}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="PATCH",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        data = json.loads(resp.read())
    if data.get("code") != 0:
        raise RuntimeError(f"更新卡片失败：{data.get('code')} {data.get('msg')}")


# ── 自定义机器人（webhook）───────────────────────────────────────────────

def webhook_url(cfg: dict | None = None) -> str:
    cfg = cfg or {}
    return str(cfg.get("FEISHU_BOT_WEBHOOK_URL") or "").strip()


def _signed(payload: dict, secret: str) -> dict:
    """自定义机器人开了「签名校验」时，timestamp + 空串的 HMAC 要一起带上。"""
    if not secret:
        return payload
    import base64
    import hashlib
    import hmac
    import time
    ts = str(int(time.time()))
    key = f"{ts}\n{secret}".encode("utf-8")
    payload["timestamp"] = ts
    payload["sign"] = base64.b64encode(
        hmac.new(key, b"", digestmod=hashlib.sha256).digest()).decode("utf-8")
    return payload


def post_webhook(payload: dict, cfg: dict | None = None) -> str:
    cfg = cfg or load_env()
    url = webhook_url(cfg)
    if not url:
        raise RuntimeError("未配置 FEISHU_BOT_WEBHOOK_URL")
    body = json.dumps(_signed(payload, str(cfg.get("FEISHU_BOT_SECRET") or "")),
                      ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=body,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        data = json.loads(resp.read())
    code = data.get("code", data.get("StatusCode", 0))
    if code != 0:
        raise RuntimeError("webhook 返回 %s %s" % (code, data.get("msg")))
    return "webhook"


# ── 通知类发送（受开关约束）──────────────────────────────────────────────

def send_card(card: dict, cfg: dict | None = None, kind: str | None = None,
              chat: str | None = None) -> str:
    """通知类卡片：优先走自定义机器人（和 cron 摘要同一个发送者）。

    没配 webhook 才退回应用机器人 —— 那条路要 app_id/secret，且群里会多出
    一个头像。带按钮的审批卡不要走这里，自定义机器人收不到按钮回调。
    """
    cfg = cfg or load_env()
    _check_switch(cfg, kind)
    if webhook_url(cfg):
        return post_webhook({"msg_type": "interactive", "card": card}, cfg)
    chat_id = chat or cfg.get("FEISHU_BAN_CHAT_ID") or DEFAULT_CHAT_ID
    return post_message(tenant_token(cfg), chat_id, card)


def send_text(text: str, cfg: dict | None = None, chat: str | None = None) -> str:
    cfg = cfg or load_env()
    _check_switch(cfg, None)
    if webhook_url(cfg):
        return post_webhook({"msg_type": "text", "content": {"text": text}}, cfg)
    chat_id = chat or cfg.get("FEISHU_BAN_CHAT_ID") or DEFAULT_CHAT_ID
    return post_text(tenant_token(cfg), chat_id, text)
