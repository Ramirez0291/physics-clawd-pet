import { configDefaults, defineConfig } from 'vitest/config';

// Tauri 开发时固定端口，见 src-tauri/tauri.conf.json 的 devUrl
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/artifacts/**'] },
  },
  test: {
    // 重建版和 graph-workflow 的副本不算本项目的测试，见 .gitignore
    exclude: [...configDefaults.exclude, '_gw-*/**', 'rebuild/**'],
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { main: 'index.html', debug: 'debug.html', assistant: 'assistant.html' },
    },
  },
});
