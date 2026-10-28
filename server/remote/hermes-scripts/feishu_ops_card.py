#!/usr/bin/env python3
"""把运维值守的研判结论发成飞书卡片。

agent 的输出是一段散文，落到飞书里就是一大坨 `**粗体**` 加 `-------------`；
而人扫一眼只想确认三件事：有没有事、证据是什么、要不要我做点什么。所以排版
交给卡片，cron 那条文本消息只留一行摘要。

用法：
    feishu_ops_card.py send --file /tmp/ops_report.json
    feishu_ops_card.py send --file - --test          # 从 stdin 读，标题标成自测

JSON 结构（缺的键就省略，不要塞空字符串）：
    {"title": "...", "level": "ok|warn|crit", "verdict": "...",
     "evidence": ["..."], "penetrated": "是|否|未知", "actions": ["..."],
     "note": "可选，替换掉默认脚注"}

发送层在 feishu_notify（不要改回从 feishu_ban_card 借）：ban 只管带按钮的
审批卡，它的发送函数已经被收窄过一轮，历史上就是因为这里 import 了它，
ban 一重构这张卡片就整条发不出去。kind="ops" 让开关只看「值守报告」那一栏。
"""

from __future__ import annotations

import argparse
import json
import sys

import feishu_notify as base

LEVEL_TEMPLATE = {"ok": "green", "warn": "orange", "crit": "red"}


def _lines(items) -> str:
    return "\n".join(str(x).strip() for x in items if str(x).strip())


def build_card(d: dict, test: bool = False) -> dict:
    lvl = str(d.get("level") or "warn").lower()
    tpl = LEVEL_TEMPLATE.get(lvl, "orange")
    title = str(d.get("title") or "边界守望 · 研判结论")
    if test:
        title = "🧪 %s（样式自测）" % title
        tpl = "blue"

    els: list[dict] = []
    verdict = str(d.get("verdict") or "").strip()
    if verdict:
        els.append({"tag": "div",
                    "text": {"tag": "lark_md", "content": "**结论**\n%s" % verdict}})

    evidence = d.get("evidence") or []
    if evidence:
        if els:
            els.append({"tag": "hr"})
        els.append({"tag": "div",
                    "text": {"tag": "lark_md",
                             "content": "**关键证据**\n%s"
                                        % _lines("• %s" % x for x in evidence)}})

    sections = d.get("sections") or []
    for sec in sections:
        if not isinstance(sec, dict):
            continue
        sec_title = str(sec.get("title") or "").strip()
        sec_body = _lines(sec.get("lines") or [])
        if sec_title and sec_body:
            els.append({"tag": "div",
                        "text": {"tag": "lark_md",
                                 "content": "**%s**\n%s" % (sec_title, sec_body)}})

    pen = str(d.get("penetrated") or "").strip()
    if pen:
        els.append({"tag": "div",
                    "text": {"tag": "lark_md", "content": "**是否打穿**\n%s" % pen}})

    actions = [x for x in (d.get("actions") or []) if str(x).strip()]
    if actions:
        els.append({"tag": "div",
                    "text": {"tag": "lark_md",
                             "content": "**建议动作**\n%s"
                                        % _lines("%d. %s" % (i + 1, x)
                                                 for i, x in enumerate(actions))}})

    note = str(d.get("note") or "").strip() or "运维值守自动研判 · 只读诊断，封禁需人工确认"
    els.append({"tag": "note", "elements": [{"tag": "plain_text", "content": note}]})

    return {
        "config": {"wide_screen_mode": True},
        "header": {"template": tpl,
                   "title": {"tag": "plain_text", "content": title}},
        "elements": els,
    }


def cmd_send(args) -> int:
    raw = sys.stdin.read() if args.file == "-" else open(args.file, encoding="utf-8").read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print("❌ JSON 解析失败：%s" % e)
        return 2
    if not isinstance(data, dict):
        print("❌ 顶层必须是对象")
        return 2

    cfg = base.load_env()
    # --chat 以前解析了却没往下传，指定群等于没指定
    mid = base.send_card(build_card(data, test=args.test), cfg,
                         kind="ops", chat=args.chat)
    print("✅ 已推送研判卡片 → %s" % mid)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="运维值守研判卡片")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("send", help="按 JSON 发一张研判卡片")
    s.add_argument("--file", required=True, help="JSON 路径；- 表示从 stdin 读")
    s.add_argument("--chat", default=None)
    s.add_argument("--test", action="store_true", help="标题标注样式自测，配色改蓝")
    s.set_defaults(func=cmd_send)
    args = p.parse_args()
    try:
        return args.func(args)
    except base.NotifyDisabled as exc:   # 设置页把这类型关了，跳过即可
        print("⏭ 已跳过：%s" % exc)
        return 0
    except Exception as exc:  # 发卡失败不该让 agent 崩掉
        print("❌ %s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
