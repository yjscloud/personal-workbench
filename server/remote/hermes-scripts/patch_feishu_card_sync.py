#!/usr/bin/env python3
"""飞书审批卡与申请单的同步补丁。

背景（页面批准后飞书卡片不动的根因）：
    发卡脚本拿到 message_id 后只 print 出来，没落库；页面批准走的是另一条
    路（桥 → frp_guard approve），它不知道群里那张卡是哪条消息，于是卡片
    永远停在「待审批」，按钮也还在。反过来飞书点按钮那条路反而是通的 ——
    因为它自己拿着 message_id。

这个补丁做三件事：
    1. 发卡后把 message_id 写回 blocks，页面批准时能找回那张卡；
    2. update 支持只给授权码（自动查 message_id），并带上处理人；
    3. 应用凭据以面板设置页为准（app_id / app_secret / chat_id 也从
       ~/.hermes/state/feishu_bot.json 读）—— 发卡应用必须和面板长连接
       是同一个，否则 PATCH 权限不够，卡片照样改不动。

用法（在助手机上）：
    python3 patch_feishu_card_sync.py

已归档（2026-10-28）：这三件事都并进了 feishu_ban_card.py 本体
（fetch_block 带 message_id/geo、发卡后 remember_message、update 支持 --by
与按授权码找卡），App 凭据则统一由 feishu_notify.load_env 以面板为准。
本脚本的锚点因此已经对不上，保留只为追溯这段历史 —— 不要再运行它。
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

TARGET = Path("/root/.hermes/scripts/feishu_ban_card.py")
MARK = "def remember_message"

# ── 1. 应用凭据以面板为准 ──────────────────────────────────────────────
ENV_OLD = """    s = settings_file()
    if s:
        cfg["FEISHU_BOT_ENABLED"] = "1" if s.get("enabled", True) else "0"
        cfg["FEISHU_NOTIFY_BAN"] = "1" if s.get("notify_ban", True) else "0"
        cfg["FEISHU_NOTIFY_OPS"] = "1" if s.get("notify_ops", True) else "0"
        if str(s.get("webhook_url") or "").strip():
            cfg["FEISHU_BOT_WEBHOOK_URL"] = str(s["webhook_url"]).strip()
        if "secret" in s:
            cfg["FEISHU_BOT_SECRET"] = str(s.get("secret") or "")
    return cfg"""

ENV_NEW = """    s = settings_file()
    if s:
        cfg["FEISHU_BOT_ENABLED"] = "1" if s.get("enabled", True) else "0"
        cfg["FEISHU_NOTIFY_BAN"] = "1" if s.get("notify_ban", True) else "0"
        cfg["FEISHU_NOTIFY_OPS"] = "1" if s.get("notify_ops", True) else "0"
        if str(s.get("webhook_url") or "").strip():
            cfg["FEISHU_BOT_WEBHOOK_URL"] = str(s["webhook_url"]).strip()
        if "secret" in s:
            cfg["FEISHU_BOT_SECRET"] = str(s.get("secret") or "")
        # 应用凭据同样以面板为准。这一步不做的话，发卡用的是 .env 里的老
        # App ID，而面板长连接用的是设置页里的那个 —— 两个不是同一个应用时，
        # PATCH 卡片会因为没有权限失败，按钮回调也收不到，表现就是「不同步」。
        for key, skey in (("FEISHU_APP_ID", "app_id"),
                          ("FEISHU_APP_SECRET", "app_secret"),
                          ("FEISHU_BAN_CHAT_ID", "chat_id")):
            val = str(s.get(skey) or "").strip()
            if val:
                cfg[key] = val
    return cfg"""

# ── 2. 申请单带上 message_id / 归属地 ──────────────────────────────────
FETCH_OLD = '''def fetch_block(code: str | None, latest: bool) -> dict | None:
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
    }'''

FETCH_NEW = '''def fetch_block(code: str | None, latest: bool) -> dict | None:
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
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
    }'''

# ── 3. 发卡后记住 message_id ────────────────────────────────────────────
SEND_OLD = '''    mid = post_message(tenant_token(cfg), chat_id, build_card(block))
    print(json.dumps({"ok": True, "message_id": mid, "block": block}, ensure_ascii=False))
    return 0'''

SEND_NEW = '''    mid = post_message(tenant_token(cfg), chat_id, build_card(block))
    remember_message(int(block["id"]), mid)
    print(json.dumps({"ok": True, "message_id": mid, "block": block}, ensure_ascii=False))
    return 0'''

# ── 4. 结果卡：处理人可变 ──────────────────────────────────────────────
RESULT_OLD = '''def build_result_card(b: dict, state: str, detail: str) -> dict:
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
                                    "content": f"**授权码**：{b['ticket']}\\n**处理人**：飞书\\n**结果**：{detail}"}},
        ],
    }'''

RESULT_NEW = '''def build_result_card(b: dict, state: str, detail: str, by: str = "飞书") -> dict:
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
                                    "content": f"**授权码**：{b['ticket']}\\n**处理人**：{by or '未知'}\\n**结果**：{detail}"}},
        ],
    }'''

# ── 5. update 支持按授权码找卡 ────────────────────────────────────────
UPDATE_OLD = '''def cmd_update(args) -> int:
    cfg = load_env()
    block = fetch_block(args.code, latest=False)
    if not block:
        block = {"id": 0, "ip": args.ip or "?", "ticket": args.code or "?"}
    card = build_result_card(block, args.state, args.detail or "")
    patch_message(tenant_token(cfg), args.message_id, card)
    print(json.dumps({"ok": True, "message_id": args.message_id}, ensure_ascii=False))
    return 0'''

UPDATE_NEW = '''def remember_message(bid: int, mid: str) -> None:
    """把卡片 id 记到申请单上。

    页面批准时走的是另一条链路（桥 → frp_guard approve），它没有飞书的
    上下文；不落库的话，那张卡就永远停在「待审批」。
    """
    if not bid or not mid:
        return
    try:
        conn = sqlite3.connect(DB_PATH, timeout=5)
        conn.execute("update blocks set message_id=? where id=?", (mid, bid))
        conn.commit()
        conn.close()
    except sqlite3.Error:
        pass


def cmd_update(args) -> int:
    cfg = load_env()
    block = fetch_block(args.code, latest=False)
    if not block:
        block = {"id": 0, "ip": args.ip or "?", "ticket": args.code or "?"}
    mid = args.message_id or str(block.get("message_id") or "")
    if not mid:
        print("没有可更新的卡片：这条申请单没记录 message_id", file=sys.stderr)
        return 1
    card = build_result_card(block, args.state, args.detail or "", by=args.by)
    patch_message(tenant_token(cfg), mid, card)
    print(json.dumps({"ok": True, "message_id": mid}, ensure_ascii=False))
    return 0'''

# ── 6. 命令行：message-id 可选 + 处理人 ───────────────────────────────
ARGS_OLD = '''    u = sub.add_parser("update", help="把已处理的卡片改成结果态")
    u.add_argument("--message-id", required=True)
    u.add_argument("--state", required=True, choices=["approved", "rejected"])
    u.add_argument("--code", default=None)
    u.add_argument("--ip", default=None)
    u.add_argument("--detail", default="")
    u.set_defaults(func=cmd_update)'''

ARGS_NEW = '''    u = sub.add_parser("update", help="把已处理的卡片改成结果态")
    u.add_argument("--message-id", default=None, help="不传则按授权码自动找")
    u.add_argument("--state", required=True, choices=["approved", "rejected"])
    u.add_argument("--code", default=None)
    u.add_argument("--ip", default=None)
    u.add_argument("--detail", default="")
    u.add_argument("--by", default="飞书", help="处理人（网页 / 飞书 / cli）")
    u.set_defaults(func=cmd_update)'''

PAIRS = (
    (ENV_OLD, ENV_NEW, "env-app-cred"),
    (FETCH_OLD, FETCH_NEW, "fetch-message-id"),
    (SEND_OLD, SEND_NEW, "send-remember"),
    (RESULT_OLD, RESULT_NEW, "result-card-by"),
    (UPDATE_OLD, UPDATE_NEW, "update-by-code"),
    (ARGS_OLD, ARGS_NEW, "args"),
)


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")
    if MARK in text:
        print("already patched")
        return 0

    missing = [label for old, _new, label in PAIRS if old not in text]
    if missing:
        print("❌ 找不到锚点：%s" % "、".join(missing), file=sys.stderr)
        return 1

    backup = TARGET.with_suffix(".bak.%s" % time.strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(TARGET, backup)

    for old, new, _label in PAIRS:
        text = text.replace(old, new, 1)

    compile(text, str(TARGET), "exec")
    TARGET.write_text(text, encoding="utf-8")
    print("patched (backup: %s)" % backup.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
