#!/usr/bin/env python3
"""申请单一创建就推飞书审批卡。

为什么必须补：值守是 7x24 跑的，而面板不可能一直开着。原来的 cmd_request
只写库 + 打印一行，人只有主动打开「边界守望」才知道有人在申请封禁 ——
等看到时，那张单可能已经因为授权码过期（6 小时）作废了。

发卡是 best-effort：飞书没配、群 id 不对、网络抖动都只打印警告，
申请单本身照常创建（页面那条路仍可批准）。

配合 patch_feishu_card_sync.py 一起用：
    send 发卡 → message_id 落库 → 页面/飞书任一批准 → 卡片改成结果态。
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

TARGET = Path("/root/.hermes/scripts/frp_guard.py")
MARK = "def notify_ban_card"

FUNC = '''def notify_ban_card(ticket, bid, ip):
    """把待批申请单推成飞书卡片，人可以直接在群里点批准/拒绝。

    不推的话，值守是 7x24 跑的、面板不可能一直开着 —— 人只有主动打开页面
    才会知道有人在申请封禁。发卡失败不影响申请单本身（页面照样能批）。
    """
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "feishu_ban_card.py")
    if not os.path.exists(script):
        return
    try:
        r = subprocess.run([sys.executable, script, "send", "--code", ticket],
                           capture_output=True, timeout=25)
        if r.returncode != 0:
            msg = (r.stderr or r.stdout or b"").decode("utf-8", "ignore").strip()
            print("⚠️ 飞书审批卡未送达：%s" % msg[:160])
    except Exception as e:
        print("⚠️ 飞书审批卡异常：%s" % str(e)[:160])


'''

ANCHOR = 'def cmd_request(conn, ip, reason, ttl, actor="agent"):'

CALL_OLD = '''    conn.commit()
    audit(conn, actor, "block_requested", info)
    print("申请单 #%d · 授权码 %s · 目标 %s · 时长 %s%s\\n理由: %s"
          % (bid, ticket, ip, "永久" if permanent else "%dh" % (ttl // 3600),
             ("（累犯第%d次）" % (n_repeat + 1)) if n_repeat else "", reason))
    return 0'''

CALL_NEW = '''    conn.commit()
    audit(conn, actor, "block_requested", info)
    print("申请单 #%d · 授权码 %s · 目标 %s · 时长 %s%s\\n理由: %s"
          % (bid, ticket, ip, "永久" if permanent else "%dh" % (ttl // 3600),
             ("（累犯第%d次）" % (n_repeat + 1)) if n_repeat else "", reason))
    # 落库之后再推卡：卡片读的是同一个库，早一步会读到「没有这张单」
    notify_ban_card(ticket, bid, ip)
    return 0'''


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")
    if MARK in text:
        print("already patched")
        return 0
    if ANCHOR not in text:
        print("❌ 找不到 cmd_request 锚点", file=sys.stderr)
        return 1
    if CALL_OLD not in text:
        print("❌ 找不到 cmd_request 结尾锚点", file=sys.stderr)
        return 1

    backup = TARGET.with_suffix(".bak.%s" % time.strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(TARGET, backup)

    text = text.replace(ANCHOR, FUNC + ANCHOR, 1)
    text = text.replace(CALL_OLD, CALL_NEW, 1)

    compile(text, str(TARGET), "exec")
    TARGET.write_text(text, encoding="utf-8")
    print("patched (backup: %s)" % backup.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
