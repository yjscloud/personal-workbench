#!/usr/bin/env python3
"""修正「运维值守·边界攻击研判」的 prompt：说清自动封禁分支。

问题：prompt 里写「用 request 拿授权码，把授权码写进摘要等确认」「你没有封禁
权限」，但 cmd_request 命中「境外 + 自动封禁开关开」时会**当场执行**并返回已封
结果，根本不给授权码。模型于是把「已经封了」说成「等你确认」，人再点一次只会
拿到「已使用过」。

改法：只补一句分支说明，其余口径不动（只读约束保持原样）。
重复执行安全：已改过就直接退出 0。
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

TARGET = Path("/root/.hermes/cron/jobs.json")
JOB_KEY = "边界攻击研判"

OLD = ("需要封禁时仍用 frp_guard.py request --ip X --reason ... 拿授权码，"
       "把授权码写进摘要等确认。\n你没有封禁权限，绝不要自己执行 approve 或 ipset。")

NEW = ("需要封禁时仍用 frp_guard.py request --ip X --reason ... 拿授权码，"
       "把授权码写进摘要等确认。\n"
       "**分支**：如果「境外 IP 自动封禁」开关是开着的、且目标 IP 归属地在境外"
       "（不含港澳台），request 会直接执行封禁、返回已封结果，不会给授权码 —— "
       "这时摘要写「已自动封禁 #id」，不要写成「等你确认」。\n"
       "你没有封禁权限，绝不要自己执行 approve 或 ipset。")

MARK = "request 会直接执行封禁"


def main() -> int:
    data = json.loads(TARGET.read_text(encoding="utf-8"))
    jobs = data.get("jobs") if isinstance(data, dict) else data
    if not isinstance(jobs, list):
        print("❌ jobs.json 结构不认识", file=sys.stderr)
        return 1

    hit = 0
    for job in jobs:
        if JOB_KEY not in str(job.get("name") or ""):
            continue
        prompt = str(job.get("prompt") or "")
        if MARK in prompt:
            print("already patched")
            return 0
        if OLD not in prompt:
            print("❌ 找不到锚点（prompt 可能已被改过），未做修改", file=sys.stderr)
            return 1
        job["prompt"] = prompt.replace(OLD, NEW, 1)
        hit += 1

    if not hit:
        print("❌ 没有找到「%s」任务" % JOB_KEY, file=sys.stderr)
        return 1

    if isinstance(data, dict):
        data["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S+08:00")

    backup = TARGET.with_suffix(".json.bak-%s" % time.strftime("%Y%m%d-%H%M%S"))
    shutil.copy2(TARGET, backup)
    TARGET.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print("patched %d job(s) (backup: %s)" % (hit, backup.name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
