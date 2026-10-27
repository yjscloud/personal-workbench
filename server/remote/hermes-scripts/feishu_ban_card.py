#!/usr/bin/env python3
"""把「封禁申请单」推成飞书交互卡片，供人工在飞书里点按钮批准/拒绝。

用法：
    feishu_ban_card.py send --code A7F3C1        # 指定授权码
    feishu_ban_card.py send --latest             # 最近一张 pending 单
    feishu_ban_card.py update --message-id om_xx --state approved --detail "已封禁 1.2.3.4"

发送走飞书应用机器人（im/v1/messages），不是自定义机器人 webhook：
自定义机器人的卡片按钮只能跳转链接，回传不了点击，审批就成了死路。

按钮的 value 里带 hermes_local_action，网关的 feishu 适配器在收 card.action.trigger
时直接执行 frp_guard.py approve/reject，不再经过 agent（agent 那条路会被
「Unrecognized slash command /card」拦掉）。

配置（/root/.hermes/.env）：
    FEISHU_APP_ID / FEISHU_APP_SECRET   必填
    FEISHU_BAN_CHAT_ID                  卡片投递的会话 id，默认取「内网监控消息」群
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ENV_PATH = Path("/root/.hermes/.env")
DB_PATH = os.environ.get("ATTACKS_DB", "/var/lib/agent-office/security/attacks.db")
API = "https://open.feishu.cn/open-apis"
DEFAULT_CHAT_ID = "oc_3cf36f0c7ee91ff7aa4a0113af434876"
TIMEOUT = 12


# ── 配置 ────────────────────────────────────────────────────────────────

def load_env() -> dict[str, str]:
    """读 .env。不覆盖已有环境变量（cron / 手动 export 优先）。"""
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
    return cfg


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


# ── 申请单 ──────────────────────────────────────────────────────────────

def fetch_block(code: str | None, latest: bool) -> dict | None:
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        if latest or not code:
            row = conn.execute(
                "select id, ip, reason, ticket, requested_at, expires_at, status "
                "from blocks where status='pending' order by id desc limit 1"
            ).fetchone()
        else:
            row = conn.execute(
                "select id, ip, reason, ticket, requested_at, expires_at, status "
                "from blocks where ticket=? order by id desc limit 1",
                (code.strip().upper(),),
            ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {
        "id": row[0], "ip": row[1], "reason": row[2] or "",
        "ticket": row[3], "requested_at": row[4], "expires_at": row[5], "status": row[6],
    }


def geo_text(ip: str) -> str:
    """复用 frp_guard 的地理查询（同一份缓存），查不到就空着。

    卡片上带一行归属地，是为了让人在点「批准」之前先有个判断依据：
    荷兰机房的段扫描和同城家宽的偶发连接，处理方式不该一样。
    """
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "frp_guard_geo", "/root/.hermes/scripts/frp_guard.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        g = mod.geo_lookup(ip)
        if g:
            # 只给「国家 城市」，和页面保持一种格式；ISP/ASN 在画像里再展开
            return str(g.get("place") or "").strip()
    except Exception:
        pass
    return ""


def build_card(b: dict) -> dict:
    """1.0 卡片结构：客户端全兼容，按钮回传的 value 原样回到网关。"""
    ttl = "永久" if not b.get("expires_at") else f"至 {b['expires_at']}"
    geo = geo_text(b["ip"])
    body = (
        f"**目标 IP**：{b['ip']}\n"
        + (f"**归属地**：{geo}\n" if geo else "")
        + f"**封禁时长**：{ttl}\n"
        f"**申请时间**：{b.get('requested_at') or '-'}\n"
        f"**理由**：{b['reason'] or '-'}\n"
        # 授权码以前直接印在这里，群内任何看到卡片的人都能拿去用。现在只在按钮
        # value 里带一次，面板侧按所有者 open_id 校验点击人；要核对申请单，
        # 在面板「待你授权」里看得到同一串码。
        "（批准请点下方按钮，仅所有者可操作）"
    )
    approve = {"hermes_local_action": "ban_approve", "code": b["ticket"], "ip": b["ip"]}
    reject = {"hermes_local_action": "ban_reject", "code": b["ticket"], "ip": b["ip"]}
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "red",
            "title": {"tag": "plain_text", "content": f"🔒 边界封禁申请 #{b['id']} · 待审批"},
        },
        "elements": [
            {"tag": "div", "text": {"tag": "lark_md", "content": body}},
            {"tag": "hr"},
            {
                "tag": "action",
                "actions": [
                    {
                        "tag": "button", "type": "primary",
                        "text": {"tag": "plain_text", "content": "批准封禁"},
                        "value": approve,
                    },
                    {
                        "tag": "button", "type": "danger",
                        "text": {"tag": "plain_text", "content": "拒绝"},
                        "value": reject,
                    },
                ],
            },
            {
                "tag": "note",
                "elements": [{"tag": "plain_text",
                              "content": "批准后在边界服务器执行 ipset add；授权码一次性、6 小时有效。"}],
            },
        ],
    }


def build_result_card(b: dict, state: str, detail: str) -> dict:
    ok = state == "approved"
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "green" if ok else "grey",
            "title": {
                "tag": "plain_text",
                "content": (f"{'✅ 已批准封禁' if ok else '🚫 已拒绝'} #{b['id']} · {b['ip']}"),
            },
        },
        "elements": [
            {"tag": "div", "text": {"tag": "lark_md",
                                    "content": f"**授权码**：{b['ticket']}\n**处理人**：飞书\n**结果**：{detail}"}},
        ],
    }


# ── 飞书 API ────────────────────────────────────────────────────────────

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


# ── 命令 ────────────────────────────────────────────────────────────────

def cmd_send(args) -> int:
    cfg = load_env()
    chat_id = args.chat or cfg.get("FEISHU_BAN_CHAT_ID") or DEFAULT_CHAT_ID
    block = fetch_block(args.code, args.latest)
    if not block:
        print(f"没有待批的申请单{'（' + args.code + '）' if args.code else ''}", file=sys.stderr)
        return 1
    if block["status"] != "pending":
        print(f"#{block['id']} 状态是 {block['status']}，不重复推送", file=sys.stderr)
        return 1
    mid = post_message(tenant_token(cfg), chat_id, build_card(block))
    print(json.dumps({"ok": True, "message_id": mid, "block": block}, ensure_ascii=False))
    return 0


def cmd_update(args) -> int:
    cfg = load_env()
    block = fetch_block(args.code, latest=False)
    if not block:
        block = {"id": 0, "ip": args.ip or "?", "ticket": args.code or "?"}
    card = build_result_card(block, args.state, args.detail or "")
    patch_message(tenant_token(cfg), args.message_id, card)
    print(json.dumps({"ok": True, "message_id": args.message_id}, ensure_ascii=False))
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="飞书封禁审批卡片")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("send", help="推送一张待批卡片")
    s.add_argument("--code", default=None)
    s.add_argument("--latest", action="store_true")
    s.add_argument("--chat", default=None)
    s.set_defaults(func=cmd_send)

    u = sub.add_parser("update", help="把已处理的卡片改成结果态")
    u.add_argument("--message-id", required=True)
    u.add_argument("--state", required=True, choices=["approved", "rejected"])
    u.add_argument("--code", default=None)
    u.add_argument("--ip", default=None)
    u.add_argument("--detail", default="")
    u.set_defaults(func=cmd_update)

    args = p.parse_args()
    try:
        return args.func(args)
    except Exception as exc:  # 推送失败不该让调用方崩掉
        print(f"❌ {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
