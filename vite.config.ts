import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        /* 把几乎不变的依赖单独切一块：nginx 给 /assets/ 配的是 30 天 immutable，
           全混在一个 chunk 里的话，改一行业务代码就让整包失效、用户重下 800KB。
           拆开之后日常发版只有业务 chunk 换名字，react 那块继续命中缓存。
           recharts 只在监控页用，切出来就永远不进首屏。 */
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          /* markdown 那一套只在知识库正文与助手气泡里用，单独切出来：
             它跟着 react-markdown 的版本走，日常发版不该让它一起失效。
             组件侧另有 React.lazy（见 components/Markdown.tsx），
             于是它连"解析执行"都排在首屏之后。 */
          markdown: ['react-markdown', 'remark-gfm', 'remark-breaks'],
          /* 知识图谱的力导向布局。只有图谱那一页用得到，而且它本来就是
             路由级懒加载 —— 单独成块是为了改业务代码时它不跟着失效 */
          graph: ['d3-force'],
        },
      },
    },
  },
});
