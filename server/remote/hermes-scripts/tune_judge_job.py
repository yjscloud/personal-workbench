#!/usr/bin/env python3
"""收紧研判任务的提示词 + 工具集，把「能用脚本判断的不要问模型」落到配置里。

提示词改三处：
  · report --since 1  → brief --hours 1（输出从几 KB 降到几百 token）
  · 工具预算 2 次 → 默认 0 次，只有需要具体 IP/目标证据时才调一次
  · 明确禁止 ssh 查证和反复查库（每次往返两万 token）

工具集只留 terminal：cron 任务不需要浏览器、桌面、文档那些能力，
它们每个都往上下文里塞工具 schema，光基线就两万 token。
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

JOBS = Path("/root/.hermes/cron/jobs.json")
JOB_ID = "152476278abc"

PROMPT = """你是运维值守 Agent，判断边界扫描是否构成真实攻击。只做只读诊断：禁止封禁、禁止改 frps 配置、禁止重启任何服务。

输入是边界守望快照的差异（威胁等级 / 高危来源档 / 敏感服务类别 / 段扫描）。
脚本已经把平静期的抖动滤掉了，能叫醒你就说明有东西越过了阈值。

【不需要报告 —— 整条回复只有 [SILENT]，不写任何解释，不要附加标点或说明】
- 威胁等级没跨档，只是扫描器换了 IP / 换了端口；
- 上次已报告过、本次没有新进展的同一件事。

【需要报告】
- 威胁等级跨档（关注→高、高→严重）；
- 首次出现对 SSH / RDP / PVE / 数据库 的集中攻击；
- 出现新的 /24 段协同扫描；
- 拿不准是否有风险的情况。

工具预算：默认 0 次 —— 输入里的档位通常就够判断了。
只有需要具体 IP / 目标 / 流量证据时才调用，且只调一次：
    python3 ~/.hermes/scripts/frp_guard.py brief --hours 1
禁止调用 report、禁止 ssh 去目标机查证、禁止反复查库：每一次额外往返都是两万 token。
仅在怀疑已经被打穿时，才允许第二次调用（去看认证日志）。

输出：中文，400 字以内，结论 → 关键证据 → 是否打穿(是/否/未知) → 建议动作。
提到 IP 时带上归属地（brief 里已经带了）。
需要封禁时用 frp_guard.py request --ip X --reason ... 拿授权码，把授权码告诉用户等确认。
你没有封禁权限，绝不要自己执行 approve 或 ipset。
"""


def main() -> int:
    raw = json.loads(JOBS.read_text(encoding="utf-8"))
    is_list = isinstance(raw, list)
    jobs = raw if is_list else raw.get("jobs", raw)
    seq = jobs if isinstance(jobs, list) else list(jobs.values())

    hit = None
    for j in seq:
        if j.get("id") == JOB_ID:
            hit = j
            break
    if hit is None:
        print("找不到任务", JOB_ID, file=sys.stderr)
        return 1

    backup = JOBS.with_suffix(f".json.bak.{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(JOBS, backup)

    hit["prompt"] = PROMPT
    hit["enabled_toolsets"] = ["terminal"]

    JOBS.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    print("updated", JOB_ID, "| toolsets=", hit["enabled_toolsets"], "| prompt=", len(PROMPT), "字")
    return 0


if __name__ == "__main__":
    sys.exit(main())
