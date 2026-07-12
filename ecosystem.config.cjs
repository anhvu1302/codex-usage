module.exports = {
  apps: [
    {
      name: "codex-usage",
      script: "build-server/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      interpreter: "node",
      autorestart: true,
      watch: false,
      restart_delay: 1000,
      max_memory_restart: "256M",
      kill_timeout: 10000,
      shutdown_with_message: globalThis.process.platform === "win32",
      merge_logs: true,
      time: true,
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
