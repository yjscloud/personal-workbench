/* 开发用的预览页：把 24 档立绘一次全渲染出来核对。
   `vite dev` 下打开 /pet-preview.html 即可，加 ?theme=dark 看深色那一套。

   它不进构建产物 —— vite 只以 index.html 为入口，这个 html 是开发时才走得到的。
   换立绘、改裁切、动 .pet-pose-* 之后用它一眼看全 24 档，
   比一档一档等状态自然触发快得多。 */
import { createRoot } from 'react-dom/client';
import { Whale, type Pose } from './components/PetWhale';
import './index.css';

const POSES: Pose[] = [
  'idle',
  'plush',
  'wave',
  'morning',
  'night',
  'winter',
  'work',
  'watch',
  'alert',
  'error',
  'sleep',
  'pat',
  'shy',
  'star',
  'love',
  'drag',
  'feed',
  'checkin',
  'streak',
  'levelup',
  'gift',
  'surprise',
  'swim',
  'celebrate',
];

const dark = new URLSearchParams(location.search).get('theme') === 'dark';
if (dark) document.documentElement.classList.add('dark');

createRoot(document.getElementById('root')!).render(
  <div className="min-h-screen bg-bg p-5">
    <div className="grid grid-cols-6 gap-3">
      {POSES.map((p) => (
        <div key={p} className="flex flex-col items-center rounded-xl border border-line bg-panel p-2">
          {/* 高一点、允许溢出：打盹是躺着的，会把画框撑宽 */}
          <div className="flex h-[178px] items-end justify-center">
            <Whale pose={p} size={112} />
          </div>
          <span className="num text-[11px] text-dim">{p}</span>
        </div>
      ))}
    </div>
  </div>,
);
