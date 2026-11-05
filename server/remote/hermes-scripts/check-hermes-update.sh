#!/bin/bash
# Hermes版本监控脚本
# 修复 2026-10-18：原先 timeout 10 秒过短（实测 hermes update --check 需 14.3s），
# 命令被 kill 后输出为空，脚本落到 else 分支误报"已是最新版本"。
# 调整 2026-11-05：60 秒仍然不够 —— `hermes update --check` 要去 GitHub 比对，
# 快的时候 4 秒、早上网络抖的时候 60~110 秒都有（实测 11-03 那次整条作业跑了 118s），
# 于是几乎每天落进"检查超时（>60s）"。上游 cron 执行器对脚本本身给的是 1 小时，
# 真正的上限只有这里，所以放宽到 180 秒：既覆盖慢网络，又不至于让一条日报挂太久。

echo "=== Hermes Agent 版本检查 ==="
echo ""

# ---- 信号一：hermes --version 自带的更新提示（零网络开销，最可靠） ----
# 仍然套一层 timeout：CLI 卡住时这条路也要能自己结束，不要连累后面的检查
VERSION_LINE=$(timeout 30 hermes --version 2>&1 | head -1)
echo "当前版本: ${VERSION_LINE:-（读取超时或失败）}"
echo ""

if echo "$VERSION_LINE" | grep -qi "Update available"; then
    echo "🚀 发现新版本！"
    echo "$VERSION_LINE" | grep -i "Update available"
    echo ""
    echo "运行 'hermes update' 进行更新"
    exit 0
fi

# ---- 信号二：主动拉取远端比对 ----
echo "检查是否有新版本..."
UPDATE_CHECK=$(timeout 180 hermes update --check 2>&1)
RC=$?

echo "$UPDATE_CHECK" | head -8
echo ""

# 超时：状态未知，绝不能当成"已是最新"
if [ "$RC" -eq 124 ]; then
    echo "⚠️  检查超时（>180s），版本状态未知"
    echo "手动运行: hermes update --check"
    exit 0
fi

# 空输出：同样是未知，不是"已最新"
if [ -z "$(echo "$UPDATE_CHECK" | tr -d '[:space:]')" ]; then
    echo "⚠️  检查无输出，版本状态未知（不要当作已最新）"
    echo "手动运行: hermes update --check"
    exit 0
fi

if echo "$UPDATE_CHECK" | grep -qi "Update available\|commits behind"; then
    echo "🚀 发现新版本！"
    echo ""
    echo "运行 'hermes update' 进行更新"
elif echo "$UPDATE_CHECK" | grep -qi "Network error\|unable to access\|Failed to connect\|timed out\|Could not resolve"; then
    echo "⚠️  网络连接失败，无法检查更新"
    echo "请检查网络后手动运行: hermes update --check"
else
    # 只有明确读到"最新"的措辞才敢下这个结论
    if echo "$UPDATE_CHECK" | grep -qi "up to date\|already up.to.date\|no update"; then
        echo "✅ 已是最新版本"
    else
        echo "⚠️  输出无法识别，版本状态未知"
        echo "手动运行: hermes update --check"
    fi
fi
