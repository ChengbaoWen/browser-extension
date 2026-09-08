import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  manifest: {
    name: 'AI Chatbox Hook & Stream Inspector',
    description: 'Hook AI Chatbox network requests (ChatGPT, Claude, DeepSeek, Kimi, etc.) to capture Prompt & Response plaintext in real time.',
    version: '1.0.0',
    permissions: ['sidePanel', 'storage'],
    host_permissions: [
      '<all_urls>'
    ],
    action: {
      default_title: 'AI Hook Inspector'
    },
    side_panel: {
      default_path: 'sidepanel.html'
    }
  },
  vite: () => ({
    plugins: [
      tailwindcss()
    ]
  })
});
