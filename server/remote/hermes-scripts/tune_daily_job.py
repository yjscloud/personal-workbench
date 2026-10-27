#!/usr/bin/env python3
"""IT 资讯日报改成「脚本抓 + 模型写」，并把工具集清零。

原来这个任务每次跑 19.8 万输入 token：模型自己用 web_search 搜、搜一轮重发一遍上下文。
现在 it_daily.py 负责抓（0 token、可控、可去重），模型只做「挑重点、翻中文、写成人话」。
enabled_toolsets 设成 [] —— 它一个工具都不需要，工具 schema 也就不进上下文了。
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

JOBS = Path("/root/.hermes/cron/jobs.json")
JOB_ID = "7ecefb26c1ec"

PROMPT = """随本任务附带的是一份原始资讯清单（标题 + 链接），由脚本抓取，已去重。

请整理成一份中文日报：
1. 挑 8–12 条真正值得看的，优先 AI/LLM、云计算与基础设施、安全、大厂动态；
   跳过融资八卦、纯观点专栏、论文预印本。
2. 每条一行：`- **要点**：一句话说清发生了什么`。英文标题翻成中文，不要照抄。
3. 同一话题只留一条，别把同一新闻的多篇报道都列出来。
4. 结尾一句话点出今天最值得关注的一件事。

总长 600 字以内。不要写「以下是今天的日报」这类开场白，直接给条目。
"""


def main() -> int:
    raw = json.loads(JOBS.read_text(encoding="utf-8"))
    jobs = raw if isinstance(raw, list) else raw.get("jobs", raw)
    seq = jobs if isinstance(jobs, list) else list(jobs.values())

    hit = None
    for j in seq:
        if j.get("id") == JOB_ID:
            hit = j
            break
    if hit is None:
        print("找不到任务", JOB_ID, file=sys.stderr)
        return 1

    shutil.copy2(JOBS, JOBS.with_suffix(f".json.bak.{time.strftime('%Y%m%d-%H%M%S')}"))

    hit["prompt"] = PROMPT
    hit["script"] = "it_daily.py"
    hit["enabled_toolsets"] = []

    JOBS.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    print("updated", JOB_ID, "| script=", hit["script"], "| toolsets=", hit["enabled_toolsets"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
