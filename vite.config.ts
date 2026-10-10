import { defineConfig } from 'vite';

// Tauri 开发时固定端口，见 src-tauri/tauri.conf.json 的 devUrl
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { main: 'index.html', debug: 'debug.html', assistant: 'assistant.html' },
    },
  },
});
