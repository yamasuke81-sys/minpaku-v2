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
      // pm2 常駐(非対話セッション)では headful Chrome が起動直後に閉じることがあるため headless で動かす。
      // ログイン Cookie は保存済みなので自動化は headless で問題ない。
      env: { PLAYWRIGHT_HEADLESS: "1" },
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
