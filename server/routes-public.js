import express from 'express';
import { flush } from './store.js';
import { PublicError, publicMeta, resolvePublicLink, submitToLink } from './services/public-links.js';

/* ────────────────────────────────────────────────────────────────────────
 * 公开接口：外部用户通过一条带 token 的链接投递任务
 * ────────────────────────────────────────────────────────────────────────
 * 只挂两个端点，且**只读元信息 + 只写新任务**：
 *   GET  /api/public/links/:token          → 项目名 / 分类 / 备注名
 *   POST /api/public/links/:token/submit   → 建一条 todo 任务
 * 没有列表、没有详情、没有修改、没有评论 —— 外链不该有能力做第二件事。
 *
 * 这个 router 在 index.js 里挂在 express.json 与登录守卫**之前**：
 * 请求体上限单独设小（32KB），也不吃全局 cors()，跨站页面拿不到响应头。
 * ──────────────────────────────────────────────────────────────────────── */

export const publicRouter = express.Router();

const ok = (res, data) => res.json({ ok: true, data });
const fail = (res, status, message) => res.status(status).json({ ok: false, error: message });

/** 链接无效的回应刻意只有一句：停用 / 过期 / 满额 / 根本不存在，对外没有区别 */
const GONE = '链接无效或已关闭，请联系发起人';

publicRouter.get('/links/:token', async (req, res) => {
  try {
    const link = await resolvePublicLink(req.params.token);
    if (!link) return fail(res, 404, GONE);
    ok(res, publicMeta(link));
  } catch (err) {
    console.error('[public] 读取外链失败：', err.message);
    fail(res, 500, '服务暂时不可用，请稍后再试');
  }
});

publicRouter.post('/links/:token/submit', async (req, res) => {
  try {
    const link = await resolvePublicLink(req.params.token);
    if (!link) return fail(res, 404, GONE);

    const result = await submitToLink(link, req.body || {}, { ip: req.ip || '' });
    /* 任务在内存镜像里，不 flush 的话"提交成功"和"真的进库"之间还有一段窗口 */
    await flush();
    ok(res, { received: true, duplicate: result.duplicate });
  } catch (err) {
    if (err instanceof PublicError) return fail(res, err.status, err.message);
    console.error('[public] 提交失败：', err.message);
    /* 不把内部错误原文抛给公网 */
    fail(res, 500, '提交失败，请稍后再试');
  }
});

/* 请求体解析的错误由 index.js 里挂载处那个错误处理器接住：
   它必须和 express.json 在同一个 app.use 栈里才会生效，
   挂在 router 内部是接不到的。 */
