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
      // ログに時刻を入れる。無いとエラーの集中時刻とルーチン不発・再起動の時刻を
      // 突き合わせられず、原因調査が推測に頼ることになる (夜間監査の指摘 2026-08-04)
      time: true,
      // 連続再起動の抑制。即時終了を繰り返して max_restarts に達し恒久停止するのを防ぐ
      exp_backoff_restart_delay: 5000,
      out_file: __dirname + "/yadozei-listener.out.log",
      error_file: __dirname + "/yadozei-listener.err.log",
      merge_logs: true,
    },
  ],
};
