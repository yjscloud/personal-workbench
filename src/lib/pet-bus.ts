/* ── 桌宠的事件总线 ──────────────────────────────────────────────────
   任何模块都可以让桌宠"说一句 / 播一段 / 做个反应"，不必知道她在哪、
   也不必把自己包进某个 provider：

     import { petCue } from '@/lib/pet-bus';
     petCue({ say: '该起来走两步了' });

     注意分寸：她不是助手，别拿她念待办、报余额、转告警。
     这个口子留给"人"的事 —— 提醒喝水、久坐、下班。

   为什么用 window 自定义事件而不是 Context：桌宠挂在 AppShell 的角落，
   而发事件的地方可能是任意页面、任意 hook（甚至一个非 React 的工具函数）。
   一个全局事件就够，代价是理论上可以被任何脚本触发 —— 自用工作台可以接受。
*/

export type PetCue = {
  /** 说一句话（受"台词气泡"开关与睡眠状态约束） */
  say?: string;
  /** 小动作 id，见 `src/assets/pet/extra/<key>.webm` */
  play?: string;
  /** 短时姿势，合法值见 Pet.tsx 的 POSE_NAMES */
  pose?: string;
  /** 这句话在气泡里停多久（毫秒） */
  ms?: number;
};

const CUE = 'pet:cue';

/** 广播一个事件。没有桌宠在页面上时什么也不会发生 */
export function petCue(cue: PetCue): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<PetCue>(CUE, { detail: cue }));
}

/** 订阅。返回取消订阅的函数，直接放进 useEffect 的清理 */
export function onPetCue(handler: (cue: PetCue) => void): () => void {
  const listener = (event: Event) => {
    const cue = (event as CustomEvent<PetCue>).detail;
    if (cue && typeof cue === 'object') handler(cue);
  };
  window.addEventListener(CUE, listener);
  return () => window.removeEventListener(CUE, listener);
}
