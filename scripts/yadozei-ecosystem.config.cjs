// PM2 常駐設定 — yadozei-listener
// 起動: pm2 start yadozei-ecosystem.config.cjs && pm2 save
// watch: yadozei-listener.mjs を変更すると自動再起動 (コード修正が即反映される)
module.exports = {
  apps: [
    {
      name: "yadozei-listener",
      script: "yadozei-listener.mjs",
      cwd: __dirname,
      interpreter: "node",
      // 特定ファイルのみ監視 (node_modules 等の巻き添え再起動を防ぐ)
      watch: ["yadozei-listener.mjs"],
      autorestart: true,
      max_restarts: 50,
      restart_delay: 1500,
      out_file: __dirname + "/yadozei-listener.out.log",
      error_file: __dirname + "/yadozei-listener.err.log",
      merge_logs: true,
    },
  ],
};
