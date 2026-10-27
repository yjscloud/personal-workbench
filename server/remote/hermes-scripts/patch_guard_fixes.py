#!/usr/bin/env python3
"""边界守望修复补丁：解封正确性、第二源失明告警、配额分池、口径一致性。

一次性修掉排查里确认的几处问题：

P0-1  cmd_unblock 以前先 ssh 再无条件置 revoked —— frps 不通时库里显示
      「已撤销」、ipset 里 IP 还在，界面在撒谎。现在只有真删掉才改状态。
P0-2  maintain_blocks 解封失败置 expire_failed 之后就再不处理，
      集合没开 timeout → 这条 IP 永久封死。现在 expire_failed 也参与重试。
P1-1  haproxy 这条「判断有没有打穿」的证据源挂了不计入 fail_streak，
      等于静默失明。现在单独计数、单独告警（连续 3 次）。
P1-2  自动封禁和人工封禁共用 MAX_BLOCK_PER_DAY：境外爆发的一天会把人工
      额度吃光。现在自动封禁走独立上限（MAX_AUTO_BLOCK_PER_DAY，默认 60）。
P2-1  cmd_request 的重复申请检查不看 expires_at：frps 不通时一条早已到期
      的 executed 单会永远挡住新申请。补齐判断，和 cmd_block 对齐。
P2-2  配额 SQL 里的 'approved' 是根本不存在的状态（死状态），一并清掉。
P2-3  blocks 补 geo / message_id 两列：前者让页面/卡片能显示归属地，
      后者让「页面批准的封禁」能把飞书那张卡改成结果态。
P2-4  health 里暴露告警实际通道（webhook / cron），避免「以为有推送」。

用法（在助手机上）：
    python3 patch_guard_fixes.py
重复执行安全：检测到已打补丁就直接退出。
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

TARGET = Path("/root/.hermes/scripts/frp_guard.py")
MARK = "def _ipset_already_gone"

# ── P1-2 配额分池的常量 ────────────────────────────────────────────────
CONST_OLD = """MAX_BLOCK_PER_DAY = 30  # 每日封禁配额
DEFAULT_BLOCK_TTL = 86400  # 默认封禁 24 小时"""

CONST_NEW = """MAX_BLOCK_PER_DAY = 30  # 每日封禁配额（人工池：申请 + 手动封禁）
# 自动封禁单独一个池。境外扫描爆发时不该把人工额度吃光 —— 否则真正需要
# 人决策的境内单会被配额挡在门外，而自动封禁那边本来就无人值守在正常执行。
MAX_AUTO_BLOCK_PER_DAY = int(os.environ.get("MAX_AUTO_BLOCK_PER_DAY", "60"))
DEFAULT_BLOCK_TTL = 86400  # 默认封禁 24 小时"""

# ── P2-3 老库补列 ──────────────────────────────────────────────────────
SCHEMA_OLD = """    acols = {r[1] for r in conn.execute("pragma table_info(assets)")}
    if "external" not in acols:
        try:
            conn.execute("alter table assets add column external integer default 0")
        except sqlite3.OperationalError:
            pass
    conn.commit()"""

SCHEMA_NEW = """    acols = {r[1] for r in conn.execute("pragma table_info(assets)")}
    if "external" not in acols:
        try:
            conn.execute("alter table assets add column external integer default 0")
        except sqlite3.OperationalError:
            pass

    # 封禁单补两列，都是老库升级时补、不重建表：
    #   geo         申请时的归属地，页面和飞书卡都要拿它给人判断依据
    #   message_id  飞书审批卡片的 id；页面批准后靠它把群里那张卡改成结果态
    bcols = {r[1] for r in conn.execute("pragma table_info(blocks)")}
    for name, ddl in (("geo", "alter table blocks add column geo text default ''"),
                      ("message_id", "alter table blocks add column message_id text default ''")):
        if name not in bcols:
            try:
                conn.execute(ddl)
            except sqlite3.OperationalError:
                pass
    conn.commit()"""

# ── P1-2 / P2-2 cmd_block 的配额（人工池） ─────────────────────────────
BLOCK_QUOTA_OLD = """    today = datetime.now().strftime("%Y-%m-%d")
    cnt = conn.execute("select count(*) from blocks where requested_at like ? and status in ('executed','approved')",
                       (today + "%",)).fetchone()[0]
    if cnt >= MAX_BLOCK_PER_DAY:
        print("⛔ 今日封禁已达配额 %d 条，拒绝" % MAX_BLOCK_PER_DAY)
        audit(conn, actor, "block_rejected_quota", ip)
        return 3"""

BLOCK_QUOTA_NEW = """    today = datetime.now().strftime("%Y-%m-%d")
    # 人工池配额：只算「不是自动封禁」的单。自动封禁的 approved_by 统一以
    # 「自动封禁」开头，用它区分两池；顺手清掉原来那个根本不存在的 'approved'。
    cnt = conn.execute(
        "select count(*) from blocks where requested_at like ? "
        "and status in ('pending','executed') and coalesce(approved_by,'') not like ?",
        (today + "%", "自动封禁%")).fetchone()[0]
    if cnt >= MAX_BLOCK_PER_DAY:
        print("⛔ 今日人工封禁已达配额 %d 条，拒绝" % MAX_BLOCK_PER_DAY)
        audit(conn, actor, "block_rejected_quota", ip)
        return 3"""

# ── P2-1 / P1-2 cmd_request：重复判断 + 配额分池 ───────────────────────
REQUEST_OLD = r"""    dup = conn.execute(
        "select id,ticket from blocks where ip=? and status in ('pending','executed') order by id desc limit 1",
        (ip,)).fetchone()
    if dup:
        print("ℹ️ %s 已有申请单 #%d（状态 pending/executed），无需重复申请" % (ip, dup[0]))
        return 0

    today = datetime.now().strftime("%Y-%m-%d")
    cnt = conn.execute("select count(*) from blocks where requested_at like ? and status in ('pending','executed','approved')",
                       (today + "%",)).fetchone()[0]
    if cnt >= MAX_BLOCK_PER_DAY:
        print("⛔ 今日封禁申请已达配额 %d 条" % MAX_BLOCK_PER_DAY)
        return 3

    ticket = make_ticket()
    ttl, permanent, n_repeat, last_at = escalate_ttl(conn, ip, ttl)
    if n_repeat:
        reason = ("%s · 累犯第%d次" % (reason, n_repeat + 1)).strip(" ·")
    exp = None if permanent else \
        (datetime.now() + timedelta(seconds=ttl)).strftime("%Y-%m-%d %H:%M:%S")
    # 先判定要不要自动封禁：命中时下面要「插入 + 执行」一次提交，中间不能 commit
    auto = auto_ban_enabled(conn) and is_foreign_ip(ip)"""

REQUEST_NEW = r"""    # executed 但已过期的单不该拦住新申请：frps 不通时 maintain_blocks 转不动它，
    # 原来的写法会让这个 IP 永远申请不了（cmd_block 那边一直有 expires_at 判断）。
    dup = conn.execute(
        "select id, ticket from blocks where ip=? and (status='pending' or "
        "(status='executed' and (expires_at is null or expires_at > ?))) "
        "order by id desc limit 1",
        (ip, now_str())).fetchone()
    if dup:
        print("ℹ️ %s 已有申请单 #%d（待批或封禁中），无需重复申请" % (ip, dup[0]))
        return 0

    ticket = make_ticket()
    ttl, permanent, n_repeat, last_at = escalate_ttl(conn, ip, ttl)
    if n_repeat:
        reason = ("%s · 累犯第%d次" % (reason, n_repeat + 1)).strip(" ·")
    exp = None if permanent else \
        (datetime.now() + timedelta(seconds=ttl)).strftime("%Y-%m-%d %H:%M:%S")
    # 先判定要不要自动封禁：命中时下面要「插入 + 执行」一次提交，中间不能 commit
    geo = geo_lookup(ip) or {}
    auto = auto_ban_enabled(conn) and is_foreign_ip(ip)

    # 配额分池：自动封禁走独立上限，不吃人工额度（境外爆发日不该把人工单挤掉）
    today = datetime.now().strftime("%Y-%m-%d")
    if auto:
        cnt = conn.execute(
            "select count(*) from blocks where requested_at like ? and approved_by like ?",
            (today + "%", "自动封禁%")).fetchone()[0]
        quota, what = MAX_AUTO_BLOCK_PER_DAY, "自动封禁"
    else:
        cnt = conn.execute(
            "select count(*) from blocks where requested_at like ? "
            "and status in ('pending','executed') and coalesce(approved_by,'') not like ?",
            (today + "%", "自动封禁%")).fetchone()[0]
        quota, what = MAX_BLOCK_PER_DAY, "封禁申请"
    if cnt >= quota:
        print("⛔ 今日%s已达配额 %d 条" % (what, quota))
        audit(conn, actor, "block_rejected_quota", ip)
        return 3"""

# cmd_request 里自动分支原本自己再查一次 geo，现在已在上面查过（走同一份缓存）
AUTO_GEO_OLD = """        geo = geo_lookup(ip) or {}
        label = "自动封禁·境外 %s" % (geo.get("place") or geo.get("cc") or "?")"""

AUTO_GEO_NEW = """        label = "自动封禁·境外 %s" % (geo.get("place") or geo.get("cc") or "?")"""

# 申请单落库时带上归属地
INSERT_OLD = """    cur = conn.execute(
        "insert into blocks(ip,reason,requested_by,requested_at,ticket,expires_at,status,backend) "
        "values(?,?,?,?,?,?,?,?)",
        (ip, reason, actor, now_str(), ticket, exp, "pending", "ipset"))"""

INSERT_NEW = """    cur = conn.execute(
        "insert into blocks(ip,reason,requested_by,requested_at,ticket,expires_at,status,backend,geo) "
        "values(?,?,?,?,?,?,?,?,?)",
        (ip, reason, actor, now_str(), ticket, exp, "pending", "ipset",
         str(geo.get("place") or "")))"""

# ── P0-1 / P0-2 解封两条路径 ───────────────────────────────────────────
UNBLOCK_OLD = '''def cmd_unblock(conn, ip, apply=False):
    row = conn.execute(
        "select id from blocks where ip=? and status='executed' order by id desc limit 1",
        (ip,)).fetchone()
    del_cmd = "ipset del %s %s" % (IPSET_NAME, ip)
    if not apply:
        print("🔍 DRY-RUN 将执行: %s" % del_cmd)
        return 0
    ok, out, err = ssh(del_cmd)
    if row:
        conn.execute("update blocks set status='revoked' where id=?", (row[0],))
        conn.commit()
    audit(conn, "cli", "unblock", ip)
    print(("✅ 已解封 %s" % ip) if ok else ("⚠️ 解封返回: %s" % (err or out)))
    return 0 if ok else 4


def maintain_blocks(conn):
    """到期自动解封 + 清理超时未批的申请单。只处理我们自己加的记录。"""
    # 超时未授权的申请单作废，避免一直占着 pending 挡住新的申请
    cut = (datetime.now() - timedelta(seconds=TICKET_TTL)).strftime("%Y-%m-%d %H:%M:%S")
    stale = conn.execute(
        "update blocks set status='expired_ticket' where status='pending' and requested_at < ?",
        (cut,)).rowcount
    if stale:
        conn.commit()

    rows = conn.execute(
        "select id, ip from blocks where status='executed' and expires_at is not null and expires_at <= ?",
        (now_str(),)).fetchall()
    if not rows:
        return
    for bid, ip in rows:
        ok, out, err = ssh("ipset del %s %s" % (IPSET_NAME, ip))
        conn.execute("update blocks set status=?, result=? where id=?",
                     ("expired" if ok else "expire_failed", (out or err)[:200], bid))
    conn.commit()
    audit(conn, "system", "auto_unblock", ",".join(ip for _, ip in rows))'''

UNBLOCK_NEW = '''def _ipset_already_gone(out, err):
    """ipset del 对「本来就不在集合里」返回非 0 —— 目的已达成就该算成功。

    不这么判的话，一条早被云镜或手工删掉的 IP 会被永久标成「解封失败」，
    每轮重试都在做无用功。
    """
    return "not found" in ((out or "") + (err or "")).lower()


def cmd_unblock(conn, ip, apply=False, by="cli"):
    """手动解封。**只有 ipset del 真的成功才改状态。**

    以前是先 ssh 再无条件置 revoked：frps 不通时库里显示「已撤销」、ipset
    里 IP 还在 —— 界面在撒谎，人以为放行了。失败时留在 expire_failed，
    交给 maintain_blocks 下一轮继续重试。
    """
    row = conn.execute(
        "select id from blocks where ip=? and status in ('executed','expire_failed') "
        "order by id desc limit 1",
        (ip,)).fetchone()
    del_cmd = "ipset del %s %s" % (IPSET_NAME, ip)
    if not apply:
        print("🔍 DRY-RUN 将执行: %s" % del_cmd)
        return 0
    ok, out, err = ssh(del_cmd)
    done = ok or _ipset_already_gone(out, err)
    if row:
        conn.execute("update blocks set status=?, result=? where id=?",
                     ("revoked" if done else "expire_failed",
                      "" if done else (out or err)[:200], row[0]))
        conn.commit()
    audit(conn, by, "unblock" if done else "unblock_failed",
          "%s%s" % (ip, "" if done else " · " + (out or err)[:120]))
    if done:
        print("✅ 已解封 %s" % ip)
        return 0
    print("⚠️ 解封失败（仍处于封禁中）: %s" % (err or out))
    return 4


def maintain_blocks(conn):
    """到期自动解封 + 清理超时未批的申请单。只处理我们自己加的记录。

    expire_failed 也在扫描范围内：解封失败一次之后不能就此放手 —— 集合没开
    timeout，放着不管就是这条 IP 被永久封死。
    """
    # 超时未授权的申请单作废，避免一直占着 pending 挡住新的申请
    cut = (datetime.now() - timedelta(seconds=TICKET_TTL)).strftime("%Y-%m-%d %H:%M:%S")
    stale = conn.execute(
        "update blocks set status='expired_ticket' where status='pending' and requested_at < ?",
        (cut,)).rowcount
    if stale:
        conn.commit()

    rows = conn.execute(
        "select id, ip from blocks where status in ('executed','expire_failed') "
        "and expires_at is not null and expires_at <= ? order by id",
        (now_str(),)).fetchall()
    if not rows:
        return
    done, stuck = [], []
    for bid, ip in rows:
        ok, out, err = ssh("ipset del %s %s" % (IPSET_NAME, ip))
        if ok or _ipset_already_gone(out, err):
            conn.execute("update blocks set status='expired', result=? where id=?",
                         ("" if ok else "ipset 中已无此条记录", bid))
            done.append(ip)
        else:
            conn.execute("update blocks set status='expire_failed', result=? where id=?",
                         ((out or err)[:200], bid))
            stuck.append("%s(#%s)" % (ip, bid))
    conn.commit()
    if done:
        audit(conn, "system", "auto_unblock", ",".join(done))
    if stuck:
        audit(conn, "system", "auto_unblock_failed", ",".join(stuck))'''

# ── P1-1 第二源（haproxy）单独计数 ─────────────────────────────────────
COLLECT_OLD = """    st["fail_streak"] = st.get("fail_streak", 0) + 1 if (e1 and not n1) else 0
    st["last_fetch_at"] = _t.time()"""

COLLECT_NEW = """    st["fail_streak"] = st.get("fail_streak", 0) + 1 if (e1 and not n1) else 0
    # 第二源单独计数：haproxy 是判断「有没有打穿」的关键证据（靠字节数区分
    # 认证失败和真的进了 shell）。它瞎了不会让 frps 的 fail_streak 涨，
    # 等于静默漏掉一种最危险的失明。
    st["fail_streak_haproxy"] = st.get("fail_streak_haproxy", 0) + 1 if (e2 and not n2) else 0
    st["last_fetch_at"] = _t.time()"""

WATCHDOG_OLD = """        if args.mode == "watchdog" and st.get("fail_streak", 0) >= 3:
            print("⚠️ 边界守望采集异常（连续 %d 次）: %s" % (st.get("fail_streak", 0), err))
            return 1"""

WATCHDOG_NEW = """        if args.mode == "watchdog":
            if st.get("fail_streak", 0) >= 3:
                print("⚠️ 边界守望采集异常（连续 %d 次）: %s" % (st.get("fail_streak", 0), err))
                return 1
            # 第二源失明单独报：它只影响「是否打穿」的判断，容易被当成小事，
            # 但真出事时这是唯一的证据来源。
            if st.get("fail_streak_haproxy", 0) >= 3:
                print("⚠️ 边界守望第二源失明（haproxy 连续 %d 次）: %s\\n"
                      "   这一源用来区分「认证失败」和「真的进了 shell」；"
                      "它不通时，打穿事件判不出来。" % (st.get("fail_streak_haproxy", 0), err))
                return 1"""

# ── P2-4 告警通道可观测 ────────────────────────────────────────────────
HEALTH_OLD = """    return {"sources": out,
            "degraded": [x["src"] for x in out if x["level"] == "down"],
            "stale": [x["src"] for x in out if x.get("stale")],
            "blind": [x["src"] for x in out if x["level"] == "off"]}"""

HEALTH_NEW = """    return {"sources": out,
            "degraded": [x["src"] for x in out if x["level"] == "down"],
            "stale": [x["src"] for x in out if x.get("stale")],
            "blind": [x["src"] for x in out if x["level"] == "off"],
            # 告警实际走哪条路。没配 webhook 就只有 cron 投递一条 ——
            # 那条链路断了告警就没了，页面要能把这件事说出来。
            "alert_channel": "webhook" if NOTIFY_WEBHOOK else "cron"}"""

# 手动解封要能标明是谁点的（网页 / 飞书 / cli）
UNBLOCK_DISPATCH_OLD = """    if args.mode == "unblock":
        if not args.ip:
            print("用法: frp_guard.py unblock --ip 1.2.3.4 [--apply]")
            return 2
        return cmd_unblock(conn, args.ip, args.apply)"""

UNBLOCK_DISPATCH_NEW = """    if args.mode == "unblock":
        if not args.ip:
            print("用法: frp_guard.py unblock --ip 1.2.3.4 [--apply] [--by 谁]")
            return 2
        return cmd_unblock(conn, args.ip, args.apply, args.by or "cli")"""

PAIRS = (
    (CONST_OLD, CONST_NEW, "const"),
    (SCHEMA_OLD, SCHEMA_NEW, "schema"),
    (BLOCK_QUOTA_OLD, BLOCK_QUOTA_NEW, "block-quota"),
    (REQUEST_OLD, REQUEST_NEW, "request"),
    (AUTO_GEO_OLD, AUTO_GEO_NEW, "auto-geo"),
    (INSERT_OLD, INSERT_NEW, "insert-geo"),
    (UNBLOCK_OLD, UNBLOCK_NEW, "unblock-maintain"),
    (COLLECT_OLD, COLLECT_NEW, "collect-haproxy"),
    (WATCHDOG_OLD, WATCHDOG_NEW, "watchdog-haproxy"),
    (HEALTH_OLD, HEALTH_NEW, "health-channel"),
    (UNBLOCK_DISPATCH_OLD, UNBLOCK_DISPATCH_NEW, "unblock-dispatch"),
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
