import { lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AppProvider } from './lib/store';
import { MonitorProvider } from './lib/monitor';
import { AuthProvider, useAuth } from './lib/auth';
import { Spinner } from './components/ui';
import Login from './pages/Login';

/* 每个页面单独切一个 chunk。
   不这么切的话，打包出来是**一个 800KB 的 JS**：打开导航就要把监控页的
   图表库（recharts，占其中三分之一）也一起下下来、解析、执行。
   按路由切之后，首屏只需要外壳那一份，进哪个页才拿哪个页的代码。

   挂起时的兜底放在 AppShell 的 <main> 里（见 components/AppShell.tsx），
   这样左轨和顶栏不会跟着内容一起闪 —— 切换页面时只有内容区在换。 */
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Week = lazy(() => import('./pages/Week'));
const Monitoring = lazy(() => import('./pages/Monitoring'));
const News = lazy(() => import('./pages/News'));
const Toolbox = lazy(() => import('./pages/Toolbox'));
const Knowledge = lazy(() => import('./pages/Knowledge'));
/* 阅读页与编辑器是同一份模块里的另外两个导出，所以它们仍然落在
   Knowledge 这一个 chunk 里 —— 不必为它们各切一份出来。 */
const KnowledgeDoc = lazy(() => import('./pages/Knowledge').then((m) => ({ default: m.KnowledgeDoc })));
const KnowledgeEditor = lazy(() => import('./pages/Knowledge').then((m) => ({ default: m.KnowledgeEditor })));
/* 图谱依赖 d3-force，单独一块（见 vite.config.ts 的 manualChunks）：
   不进首屏，也不跟知识库那几页一起失效 */
const KnowledgeGraph = lazy(() => import('./pages/KnowledgeGraph'));
const Settings = lazy(() => import('./pages/Settings'));

/**
 * 登录关卡。
 *
 * 刻意放在 AppProvider（业务数据）**外面**：没登录时一个数据接口都不发，
 * 既少一轮必然 401 的往返，也不会在登录页上弹一排失败提示。
 * 服务端没开登录（.env 里没设 AUTH_PASSWORD）时 enabled=false，整段透明。
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { ready, enabled, user } = useAuth();

  // 问服务端"要不要登录"这一下的过场。不渲染登录页是因为还没问出来：
  // 先闪一下登录页、再跳进控制台，比多等 20ms 难受得多
  if (!ready) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner className="h-5 w-5 text-faint" />
      </div>
    );
  }
  if (enabled && !user) return <Login />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AuthGate>
          <AppProvider>
            <MonitorProvider>
              <Routes>
                <Route element={<AppShell />}>
                  <Route index element={<Dashboard />} />
                  <Route path="week" element={<Week />} />
                  <Route path="monitoring" element={<Monitoring />} />
                  <Route path="toolbox" element={<Toolbox />} />
                  <Route path="news" element={<News />} />
                  <Route path="knowledge" element={<Knowledge />} />
                  {/* 顺序无关紧要：react-router 会把静态段 /new 排在 :id 之前，
                      所以它不会被当成一个 id 叫 "new" 的条目 */}
                  <Route path="knowledge/new" element={<KnowledgeEditor />} />
                  <Route path="knowledge/graph" element={<KnowledgeGraph />} />
                  <Route path="knowledge/:id" element={<KnowledgeDoc />} />
                  <Route path="knowledge/:id/edit" element={<KnowledgeEditor />} />
                  <Route path="settings" element={<Settings />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </MonitorProvider>
          </AppProvider>
        </AuthGate>
      </AuthProvider>
    </BrowserRouter>
  );
}
