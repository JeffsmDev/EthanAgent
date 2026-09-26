// Ethan — PM2 (alternativa sin Docker)
// Requisitos: pnpm install && pnpm build en la raíz del repo.
// Uso: pm2 startOrReload deploy/pm2/ecosystem.config.cjs && pm2 save
const path = require('node:path');

const backendDir = path.resolve(__dirname, '../../packages/backend');

module.exports = {
  apps: [
    {
      name: 'ethan-english-coach',
      cwd: backendDir,
      script: 'dist/server.js',
      // UNA sola instancia: el progreso se guarda en un JSON local; varios procesos escribiendo lo corromperían
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '300M',
      time: true,
      env: {
        NODE_ENV: 'production',
        // Nginx hace proxy a este puerto (el resto de variables viene de packages/backend/.env)
        PORT: process.env.PORT || 3000,
        ENABLE_ENGINE_SWITCH: 'false'
      }
    }
  ]
};
