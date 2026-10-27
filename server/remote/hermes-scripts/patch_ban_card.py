#!/usr/bin/env python3
"""给 Hermes 内置的飞书适配器打一个「封禁审批卡片」补丁。

为什么必须改这里：
飞书卡片的按钮点击进到网关后，会被适配器转成一条合成命令 `/card button {...}`，
而网关的斜杠命令层不认 `/card`，直接回「未知命令」——审批链路就断在最后一步。
钩子系统（~/.hermes/hooks）只暴露 agent:start / agent:end 这类生命周期事件，
接不住卡片回调，所以只能在适配器里就地分一支。

补丁做三件事：
  1. 补 import subprocess / sys
  2. _handle_card_action_event 里识别 value.hermes_local_action，先于合成命令分流
  3. 新增 _handle_ban_card_action：跑 frp_guard approve/reject，再把原卡片改成结果态

`hermes update` 会覆盖 adapter.py，升级后重跑本脚本即可（幂等）。
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

TARGET = Path("/usr/local/lib/hermes-agent/plugins/platforms/feishu/adapter.py")
MARK = "_handle_ban_card_action"

IMPORT_ANCHOR = "import re\n"
IMPORT_ADD = "import re\nimport subprocess\nimport sys\n"

# 锚点必须带上下一行：`action_value = getattr(action, "value", {})` 在
# _on_card_action_trigger（SDK 路径）和 _handle_card_action_event（webhook 路径）
# 里各出现一次，只锚这一行会打到前者——那里没有 action_tag，运行即 NameError，
# 而真正要改的 webhook 路径纹丝不动。
BRANCH_ANCHOR = (
    '        action_value = getattr(action, "value", {}) or {}\n'
    '        synthetic_text = f"/card {action_tag}"\n'
)
BRANCH_REPLACE_TAIL = '        synthetic_text = f"/card {action_tag}"\n'
# 历史版本：_namespace_from_mapping 会把嵌套 dict 转成 SimpleNamespace，
# 所以 isinstance(value, dict) 和 json.loads(str) 两条都不中，必须认 __dict__。
OLD_BRANCH = '''        # hermes-local: 封禁审批卡片。必须在合成命令之前分流 —— 否则按钮点击会变成
        # `/card button {...}` 被斜杠命令层当成未知命令丢掉。
        # 飞书回传的 value 既可能是对象，也可能是 JSON 字符串，两种都要认。
        _local_action = action_value
        if isinstance(_local_action, str) and _local_action.strip().startswith("{"):
            try:
                _local_action = json.loads(_local_action)
            except Exception:
                _local_action = None
        if isinstance(_local_action, dict) and _local_action.get("hermes_local_action"):
            asyncio.create_task(self._handle_ban_card_action(
                action_value=_local_action, open_id=open_id, operator=operator,
                message_id=str(getattr(context, "open_message_id", "") or "")))
            return
'''
BRANCH_ADD = '''        # hermes-local: 封禁审批卡片。必须在合成命令之前分流 —— 否则按钮点击会变成
        # `/card button {...}` 被斜杠命令层当成未知命令丢掉。
        # value 有三种可能形态：dict、JSON 字符串、以及 _namespace_from_mapping
        # 转出来的 SimpleNamespace（实际就是最后这种，靠 __dict__ 还原）。
        _local_action = action_value
        if isinstance(_local_action, str) and _local_action.strip().startswith("{"):
            try:
                _local_action = json.loads(_local_action)
            except Exception:
                _local_action = None
        elif hasattr(_local_action, "__dict__"):
            _local_action = dict(vars(_local_action))
        if isinstance(_local_action, dict) and _local_action.get("hermes_local_action"):
            asyncio.create_task(self._handle_ban_card_action(
                action_value=_local_action, open_id=open_id, operator=operator,
                message_id=str(getattr(context, "open_message_id", "") or "")))
            return
'''

METHOD_ANCHOR = "    async def _dispatch_synthetic_event(\n"
METHOD_ADD = '''    async def _handle_ban_card_action(
        self, *, action_value: dict, open_id: str, operator: Any, message_id: str,
    ) -> None:
        """封禁审批卡片：点了按钮就直接跑 frp_guard，不经过 agent。

        agent 那条路走不通（合成命令被拒），而且就算走得通也不该让模型来决定
        封不封——审批的意义就是人不经过模型直接下命令。
        """
        action = str(action_value.get("hermes_local_action") or "")
        code = str(action_value.get("code") or "").strip().upper()
        if action not in {"ban_approve", "ban_reject"} or not code:
            return

        operator_ids = {v for v in (
            open_id,
            str(getattr(operator, "user_id", "") or ""),
            str(getattr(operator, "union_id", "") or ""),
        ) if v}
        allowed = set(self._admins) | set(self._allowed_group_users)
        logger.info("[Feishu] Ban card action %s code=%s ids=%s", action, code, sorted(operator_ids))
        if allowed and not (operator_ids & allowed):
            logger.warning(
                "[Feishu] Unauthorized ban card action ids=%s allowed=%s",
                sorted(operator_ids), sorted(allowed))
            return

        approved = action == "ban_approve"
        argv = [sys.executable, "/root/.hermes/scripts/frp_guard.py",
                "approve" if approved else "reject", "--code", code, "--by", "飞书授权"]
        if approved:
            argv.append("--apply")

        def _run(cmd: list) -> tuple:
            done = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
            return done.returncode, (done.stdout or done.stderr or "").strip()

        try:
            rc, out = await asyncio.to_thread(_run, argv)
        except Exception as exc:
            logger.error("[Feishu] Ban card action failed: %s", exc)
            return
        logger.info("[Feishu] Ban card action code=%s rc=%s out=%s", code, rc, out[-200:])

        ok = approved and rc == 0
        state = "approved" if ok else "rejected"
        detail = (out.splitlines()[-1] if out else "")[:120]
        if message_id:
            upd = [sys.executable, "/root/.hermes/scripts/feishu_ban_card.py", "update",
                   "--message-id", message_id, "--state", state,
                   "--code", code, "--detail", detail]
            try:
                await asyncio.to_thread(_run, upd)
            except Exception as exc:
                logger.warning("[Feishu] Ban card update failed: %s", exc)

'''


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")
    if MARK in text:
        if OLD_BRANCH in text:
            shutil.copy2(TARGET, TARGET.with_suffix(f".py.bak.{time.strftime('%Y%m%d-%H%M%S')}"))
            text = text.replace(OLD_BRANCH, BRANCH_ADD, 1)
            compile(text, str(TARGET), "exec")
            TARGET.write_text(text, encoding="utf-8")
            print("refreshed branch (value 兼容 JSON 字符串)")
            return 0
        print("already patched")
        return 0

    for anchor, label in (
        (IMPORT_ANCHOR, "import"), (BRANCH_ANCHOR, "branch"), (METHOD_ANCHOR, "method"),
    ):
        if anchor not in text:
            print(f"❌ 找不到锚点：{label}", file=sys.stderr)
            return 1

    backup = TARGET.with_suffix(f".py.bak.{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(TARGET, backup)

    text = text.replace(IMPORT_ANCHOR, IMPORT_ADD, 1)
    text = text.replace(
        BRANCH_ANCHOR,
        '        action_value = getattr(action, "value", {}) or {}\n'
        + BRANCH_ADD
        + BRANCH_REPLACE_TAIL,
        1,
    )
    text = text.replace(METHOD_ANCHOR, METHOD_ADD + METHOD_ANCHOR, 1)

    compile(text, str(TARGET), "exec")
    TARGET.write_text(text, encoding="utf-8")
    print(f"patched (backup: {backup.name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
