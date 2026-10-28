#!/usr/bin/env python3
"""把「封禁申请单」推成飞书交互卡片，供人工在飞书里点按钮批准/拒绝；
另外给 frp_guard 提供两种已经执行完的通知（结果卡 / 纯文本）。

用法：
    feishu_ban_card.py send --code A7F3C1        # 指定授权码
    feishu_ban_card.py send --latest             # 最近一张 pending 单
    feishu_ban_card.py update --message-id om_xx --state approved --detail "已封禁 1.2.3.4"
    feishu_ban_card.py auto --ip 1.2.3.4 --reason "..." --id 73   # 自动封禁结果卡
    feishu_ban_card.py notify --text "..."                        # 一句话通知

发送走飞书应用机器人（im/v1/messages），不是自定义机器人 webhook：
自定义机器人的卡片按钮只能跳转链接，回传不了点击，审批就成了死路。
审批卡（send / update）因此**不受通知开关约束** —— 它是要人做决定的工作流，
被"通知关了"静默吞掉只会让人以为没人来申请。

配置与开关判定都在 feishu_notify 里（那份文件是发送层的唯一真源）：
    FEISHU_APP_ID / FEISHU_APP_SECRET   必填
    FEISHU_BAN_CHAT_ID                  卡片投递的会话 id，默认取「内网监控消息」群

auto / notify 属于"通知"，走 notify.send_card(kind="ban")：设置页关掉
「自动封禁」通知时会抛 NotifyDisabled，这里按"跳过"处理并返回 0 ——
封禁本身已经执行完，通知没发不该让 frp_guard 记成失败。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sqlite3
import sys

import feishu_notify as notify

DB_PATH = os.environ.get("ATTACKS_DB", "/var/lib/agent-office/security/attacks.db")
DEFAULT_CHAT_ID = notify.DEFAULT_CHAT_ID

load_env = notify.load_env


# ── 申请单 ──────────────────────────────────────────────────────────────

def fetch_block(code: str | None, latest: bool) -> dict | None:
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        # 连 message_id 一起取：页面批准走的是另一条链路（桥 → frp_guard approve），
        # 它没有飞书的上下文，只认这张卡落在哪条消息上。
        cols = ("select id, ip, reason, ticket, requested_at, expires_at, status, "
                "coalesce(message_id,'') mid, coalesce(geo,'') geo ")
        if latest or not code:
            row = conn.execute(
                cols + "from blocks where status='pending' order by id desc limit 1"
            ).fetchone()
        else:
            row = conn.execute(
                cols + "from blocks where ticket=? order by id desc limit 1",
                (code.strip().upper(),),
            ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {
        "id": row[0], "ip": row[1], "reason": row[2] or "",
        "ticket": row[3], "requested_at": row[4], "expires_at": row[5], "status": row[6],
        "message_id": row[7] or "", "geo": row[8] or "",
    }


def remember_message(bid, mid: str) -> None:
    """把卡片 id 记到申请单上。

    页面批准时走的是另一条链路（桥 → frp_guard approve），它没有飞书的
    上下文；不落库的话，那张卡就永远停在「待审批」，按钮也还在。
    """
    if not bid or not mid:
        return
    try:
        conn = sqlite3.connect(DB_PATH, timeout=5)
        conn.execute("update blocks set message_id=? where id=?", (mid, int(bid)))
        conn.commit()
        conn.close()
    except sqlite3.Error:
        pass


def geo_text(ip: str) -> str:
    """复用 frp_guard 的地理查询（同一份缓存），查不到就空着。

    卡片上带一行归属地，是为了让人在点「批准」之前先有个判断依据：
    荷兰机房的段扫描和同城家宽的偶发连接，处理方式不该一样。
    """
    try:
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
    # 申请单上已经存过归属地就别再查一遍（frp_guard 开单时查过一次）
    geo = b.get("geo") or geo_text(b["ip"])
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


def build_result_card(b: dict, state: str, detail: str, by: str = "飞书") -> dict:
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
                                    "content": f"**授权码**：{b['ticket']}\n**处理人**：{by or '未知'}\n**结果**：{detail}"}},
        ],
    }


def build_auto_ban_card(b: dict) -> dict:
    """自动封禁结果卡。

    几个刻意的选择：
    - 字段两列排（fields），理由单独一段 —— 理由经常很长，塞进字段会被压成一行。
    - 没有按钮：执行已经发生，"批准 / 拒绝"在这里是误导。
    - 失败时换橙色 + 多一段「执行结果」，不用红色：红色留给"有人正在打进来"。
    """
    ok = b.get("ok", True)
    test = b.get("test", False)
    place = b.get("place") or geo_text(b["ip"]) or "未知"
    exp = b.get("expires_at") or "永久"

    if test:
        title, tpl = "🧪 自动封禁卡片（样式自测）", "blue"
    elif ok:
        title, tpl = "🛡️ 境外来源已自动封禁", "red"
    else:
        title, tpl = "⚠️ 自动封禁未执行成功", "orange"

    pairs = [
        ("目标 IP", b["ip"]),
        ("归属地", place),
        ("到期时间", exp),
        ("申请单", ("#%s" % b["id"]) if b.get("id") else "-"),
    ]
    fields = [{"is_short": True,
               "text": {"tag": "lark_md", "content": "**%s**\n%s" % (k, v)}}
              for k, v in pairs]

    elements = [
        {"tag": "div", "fields": fields},
        {"tag": "hr"},
        {"tag": "div",
         "text": {"tag": "lark_md",
                  "content": "**为什么封它**\n%s" % (b.get("reason") or "-")}},
    ]
    if not ok and not test:
        elements.append(
            {"tag": "div",
             "text": {"tag": "lark_md",
                      "content": "**执行结果**\n`ipset add` 没有成功，这条规则需要人工补执行。"}})
    elements.append(
        {"tag": "note",
         "elements": [{"tag": "plain_text",
                       "content": ("这条是样式自测，没有执行任何封禁。"
                                   if test else
                                   "境外来源（不含港澳台）开单即封，未经过人工审批；"
                                   "记录留在「边界守望」页，可随时解封。")}]})

    return {"config": {"wide_screen_mode": True},
            "header": {"template": tpl,
                       "title": {"tag": "plain_text", "content": title}},
            "elements": elements}


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
    # 审批卡直发，不走 send_card：它不受"通知开关"约束（见文件头）
    mid = notify.post_message(notify.tenant_token(cfg), chat_id, build_card(block))
    remember_message(block["id"], mid)
    print(json.dumps({"ok": True, "message_id": mid, "block": block}, ensure_ascii=False))
    return 0


def cmd_update(args) -> int:
    cfg = load_env()
    block = fetch_block(args.code, latest=False)
    if not block:
        block = {"id": 0, "ip": args.ip or "?", "ticket": args.code or "?"}
    # 页面批准时只有授权码，没有 message_id —— 从申请单上找回来
    mid = args.message_id or str(block.get("message_id") or "")
    if not mid:
        print("没有可更新的卡片：这条申请单没记录 message_id", file=sys.stderr)
        return 1
    card = build_result_card(block, args.state, args.detail or "", by=args.by)
    notify.patch_message(notify.tenant_token(cfg), mid, card)
    print(json.dumps({"ok": True, "message_id": mid}, ensure_ascii=False))
    return 0


def cmd_auto(args) -> int:
    """推一张自动封禁结果卡（供 frp_guard 调用）。"""
    cfg = load_env()
    b = {"id": args.id, "ip": args.ip, "reason": args.reason or "-",
         "place": args.place or "", "expires_at": args.expires,
         "ok": not args.failed, "test": args.test}
    mid = notify.send_card(build_auto_ban_card(b), cfg, kind="ban", chat=args.chat)
    print(f"✅ 已推送自动封禁卡片 → {mid}")
    return 0


def cmd_notify(args) -> int:
    """发一条纯文本通知（自动封禁用）。--text - 表示从 stdin 读。"""
    cfg = load_env()
    text = sys.stdin.read() if args.text == "-" else args.text
    text = (text or "").strip()
    if not text:
        print("❌ --text 为空")
        return 2
    mid = notify.send_text(text, cfg, chat=args.chat)
    print(f"✅ 已发送通知 → {mid}")
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
    u.add_argument("--message-id", default=None, help="不传则按授权码自动找")
    u.add_argument("--state", required=True, choices=["approved", "rejected"])
    u.add_argument("--code", default=None)
    u.add_argument("--ip", default=None)
    u.add_argument("--detail", default="")
    u.add_argument("--by", default="飞书", help="处理人（网页 / 飞书 / cli）")
    u.set_defaults(func=cmd_update)

    # frp_guard 的调用形状（不要改参数名）：auto --ip .. --place .. --reason ..
    # --expires .. --id .. [--failed]
    a = sub.add_parser("auto", help="推送自动封禁结果卡（frp_guard 用）")
    a.add_argument("--ip", required=True)
    a.add_argument("--place", default="")
    a.add_argument("--reason", default="")
    a.add_argument("--expires", default="永久")
    a.add_argument("--id", default="")
    a.add_argument("--failed", action="store_true")
    a.add_argument("--test", action="store_true", help="样式自测：标题标注且不暗示真封禁")
    a.add_argument("--chat", default=None)
    a.set_defaults(func=cmd_auto)

    n = sub.add_parser("notify", help="发一条纯文本通知（自动封禁，无按钮）")
    n.add_argument("--text", required=True, help="正文；传 - 从 stdin 读")
    n.add_argument("--chat", default=None)
    n.set_defaults(func=cmd_notify)

    args = p.parse_args()
    try:
        return args.func(args)
    except notify.NotifyDisabled as exc:  # 设置页关了这类通知：跳过，不算失败
        print(f"⏭ 已跳过：{exc}")
        return 0
    except Exception as exc:  # 推送失败不该让调用方崩掉
        print(f"❌ {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
