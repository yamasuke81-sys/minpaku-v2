@echo off
chcp 65001 >nul
cd /d C:UsersyamasAI_Workspaceminpaku-v2scripts

echo ================================================
echo  タイミー再ログイン (dispatch-listener)
echo ================================================
echo.
echo [1/3] 常駐を一時停止します...
call pm2 stop dispatch-listener

echo.
echo [2/3] ログイン用ブラウザを起動します。
echo    開いたタブでタイミーにログインし、
echo    終わったらブラウザを閉じてください。自動で次に進みます。
echo    ※ Ctrl+C は押さないでください (押すと常駐の再開がスキップされます)
echo.
node dispatch-listener.js --login

echo.
echo [3/3] 常駐を再開します...
call pm2 start dispatch-listener

echo.
echo 完了。数分以内に Discord に「✅ タイミー再ログイン確認」が届けば成功です。
pause
