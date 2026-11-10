import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    watch: {
      // 编辑器用「临时文件 + 改名」的方式存盘时，会在 src 下留下 .xxx.tmpdir 目录。
      // chokidar 发现它的时候目录已经删了，fs.watch 直接 EBUSY，整个 vite 进程退出。
      // 这些临时目录永远不用看。
      ignored: ['**/.git/**', '**/node_modules/**', '**/.*.tmpdir/**'],
    },
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
