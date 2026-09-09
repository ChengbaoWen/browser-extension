import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  manifest: () => ({
    name: 'Network Capture Inspector',
    description: 'Capture configured HTTP, SSE, and WebSocket application data for local inspection.',
    version: '1.0.0',
    permissions: ['sidePanel', 'storage', 'alarms'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Network Capture Inspector'
    },
  }),
  vite: () => ({
    plugins: [
      tailwindcss()
    ]
  })
});
