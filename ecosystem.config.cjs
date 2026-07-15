module.exports = {
  apps: [
    {
      name: "codex-usage",
      script: "build-server/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      interpreter: "node",
      // Keep explicit deep JSONL verification below the 256 MB PM2 restart threshold.
      node_args: "--max-old-space-size=64 --max-semi-space-size=4",
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
