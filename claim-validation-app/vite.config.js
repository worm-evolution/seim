const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');

module.exports = defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4310',
      '/seim': 'http://localhost:4310'
    }
  }
});
