import { useEffect, useState } from 'react';
import { Copy, Link2, Plus, RefreshCcw, Trash2 } from 'lucide-react';
import { api, type ProjectSection, type PublicLink } from '@/lib/api';
import { useStore } from '@/lib/store';
import { copyText } from '@/lib/clipboard';
import { fmtRelative } from '@/lib/format';
import { Badge, Button, Field, Input, Select, Spinner } from '@/components/ui';

/**
 * 外部提交链接的管理面板（任务计划页用）。
 *
 * 放在 Modal 里，所以自己不套 Card：标题由 Modal 出。逻辑和接口全是管理端的，
 * 公开侧只有 /s/<token> 那一页，两者不共用任何组件。
 *
 * 「换链接」比「删了重建」更常用：token 就是凭据，换一条等于让旧地址立刻失效，
 * 而项目、分类、备注名这些配置原样保留。
 */
export function PublicLinksPanel() {
  const { projects, notify } = useStore();
  const [links, setLinks] = useState<PublicLink[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const [projectId, setProjectId] = useState('');
  const [section, setSection] = useState('');
  const [sections, setSections] = useState<ProjectSection[]>([]);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('30');
  const [maxUses, setMaxUses] = useState('');

  async function reload() {
    const { links: list } = await api.publicLinks.list();
    setLinks(list);
  }

  useEffect(() => {
    let alive = true;
    api.publicLinks
      .list()
      .then(({ links: list }) => {
        if (alive) setLinks(list);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setLinks([]);
        notify(err instanceof Error ? err.message : '外链列表读取失败', 'crit');
      });
    return () => {
      alive = false;
    };
  }, [notify]);

  /* 项目一换，分类选项跟着换：分类名只在所属项目内唯一 */
  useEffect(() => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      setSections([]);
      return;
    }
    let alive = true;
    api.projects
      .sections(project.id)
      .then(({ sections: list }) => {
        if (alive) setSections(list);
      })
      .catch(() => {
        if (alive) setSections([]);
      });
    return () => {
      alive = false;
    };
  }, [projectId, projects]);

  function startCreate() {
    setOpen(true);
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }

  async function create() {
    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      notify('先选一个项目', 'warn');
      return;
    }
    setBusy(true);
    try {
      await api.publicLinks.create({
        project: project.name,
        section,
        label: label.trim(),
        /* 链接默认不限次数：投递口是长期开的，收多少条由人来判断，
           只有明确需要限额时才填 */
        maxUses: maxUses.trim() ? Number(maxUses) : null,
        expiresAt: days === '0' ? null : new Date(Date.now() + Number(days) * 86400000).toISOString(),
      });
      await reload();
      setOpen(false);
      setLabel('');
      setSection('');
      setMaxUses('');
      notify('链接已创建，复制后发给对方');
    } catch (err) {
      notify(err instanceof Error ? err.message : '创建失败', 'crit');
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: { enabled?: boolean }, done?: string) {
    setRowBusy(id);
    try {
      await api.publicLinks.update(id, body);
      await reload();
      if (done) notify(done);
    } catch (err) {
      notify(err instanceof Error ? err.message : '修改失败', 'crit');
    } finally {
      setRowBusy(null);
    }
  }

  async function rotate(link: PublicLink) {
    if (!window.confirm('换一条新链接？换完之后，旧链接立刻失效，已经发出去的都用不了。')) return;
    setRowBusy(link.id);
    try {
      await api.publicLinks.rotate(link.id);
      await reload();
      notify('已换新链接，旧链接已失效');
    } catch (err) {
      notify(err instanceof Error ? err.message : '换链接失败', 'crit');
    } finally {
      setRowBusy(null);
    }
  }

  async function remove(link: PublicLink) {
    if (!window.confirm(`删除「${link.project}」这条外链？已经收进来的任务不受影响。`)) return;
    setRowBusy(link.id);
    try {
      await api.publicLinks.remove(link.id);
      await reload();
      notify('链接已删除');
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败', 'crit');
    } finally {
      setRowBusy(null);
    }
  }

  async function copy(link: PublicLink) {
    const ok = await copyText(`${window.location.origin}/s/${link.token}`);
    notify(ok ? '链接已复制' : '复制失败，请手动选中地址', ok ? 'ok' : 'warn');
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-md text-2xs leading-relaxed text-faint">
          发给外部用户的入口：不用登录就能往指定项目投任务，可以反复提交；提交后直接进看板，并推一条飞书消息（用设置页里配的 webhook）。
        </p>
        <Button size="sm" variant="primary" onClick={startCreate} disabled={!projects.length}>
          <Plus size={13} aria-hidden />
          新建链接
        </Button>
      </div>

      {!projects.length ? (
        <p className="mt-3 text-2xs leading-relaxed text-faint">先在左侧建一个项目，外链要挂在项目上。</p>
      ) : null}

      {open ? (
        <div className="mt-3 rounded-field border border-line bg-panel-2 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="投递到哪个项目">
              <Select
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setSection('');
                }}
              >
                <option value="">选择项目</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="分类（可选）" hint={sections.length ? '提交的任务会落在这个分类下' : '这个项目还没建分类'}>
              <Select value={section} onChange={(e) => setSection(e.target.value)} disabled={!sections.length}>
                <option value="">不归类</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="备注名（可选）" hint="显示在公开页上，例如「行政报修」">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="例如：行政报修" />
            </Field>
            <Field label="有效期">
              <Select value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="7">7 天</option>
                <option value="30">30 天</option>
                <option value="90">90 天</option>
                <option value="0">长期有效</option>
              </Select>
            </Field>
            <Field label="最多收多少条（可选）" hint="留空 = 不限次数；每条链接每天另有 200 条的硬上限">
              <Input
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value.replace(/[^\d]/g, ''))}
                inputMode="numeric"
                placeholder="留空不限"
              />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" onClick={() => void create()} disabled={busy}>
              {busy ? <Spinner /> : <Plus size={13} aria-hidden />}
              创建
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              取消
            </Button>
            <span className="text-2xs text-faint">建好之后复制链接发出去，页面上看不到任何已有任务</span>
          </div>
        </div>
      ) : null}

      {links === null ? (
        <div className="grid place-items-center py-8">
          <Spinner className="h-4 w-4 text-faint" />
        </div>
      ) : links.length === 0 ? (
        <p className="mt-3 rounded-field border border-dashed border-line px-3 py-6 text-center text-2xs leading-relaxed text-faint">
          还没有外链。建一条挂在项目上，把地址发给需要提任务的人。
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {links.map((link) => (
            <div key={link.id} className="rounded-field border border-line bg-panel-2 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium">{link.project}</span>
                {link.section ? <span className="text-2xs text-muted">/ {link.section}</span> : null}
                {link.label ? <span className="text-2xs text-faint">· {link.label}</span> : null}
                <Badge tone={link.enabled ? 'ok' : 'neutral'} dot>
                  {link.enabled ? '收件中' : '已停用'}
                </Badge>
                {link.notify ? <Badge tone="neutral">飞书</Badge> : null}
                <span className="num ml-auto text-2xs text-faint">
                  已收 {link.uses} 条
                  {link.maxUses != null ? ` / 上限 ${link.maxUses}` : ' · 不限次数'}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="num min-w-0 flex-1 truncate rounded-xs bg-bg-3 px-2 py-1 text-2xs text-muted">
                  {window.location.origin}/s/{link.token}
                </code>
                <Button size="sm" variant="soft" onClick={() => void copy(link)}>
                  <Copy size={12} aria-hidden />
                  复制
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={rowBusy === link.id}
                  onClick={() => void patch(link.id, { enabled: !link.enabled }, link.enabled ? '已停用，链接立刻失效' : '已重新启用')}
                >
                  {link.enabled ? '停用' : '启用'}
                </Button>
                <Button size="sm" variant="ghost" disabled={rowBusy === link.id} onClick={() => void rotate(link)}>
                  <RefreshCcw size={12} aria-hidden />
                  换链接
                </Button>
                <Button size="sm" variant="danger" disabled={rowBusy === link.id} onClick={() => void remove(link)}>
                  <Trash2 size={12} aria-hidden />
                  删除
                </Button>
              </div>

              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-2xs text-faint">
                <span className="inline-flex items-center gap-1">
                  <Link2 size={11} aria-hidden />
                  今日 {link.dayCount} 条
                </span>
                {link.expiresAt ? <span>{new Date(link.expiresAt).toLocaleDateString('zh-CN')} 失效</span> : <span>长期有效</span>}
                {link.lastUsedAt ? <span>最近 {fmtRelative(link.lastUsedAt)}</span> : <span>还没有人提交</span>}
              </p>
            </div>
          ))}
        </div>
      )}

      <p className="mt-4 border-t border-line pt-3.5 text-2xs leading-relaxed text-faint">
        链接本身就是凭据：只发给需要提任务的人，别贴到公开群里。怀疑外泄就点「换链接」——旧地址立刻失效，已收的任务不受影响。
        同一个人可以多次提交；服务端按「单 IP 10 分钟 10 条、每条链接每天 200 条」兜底。
      </p>
    </div>
  );
}
