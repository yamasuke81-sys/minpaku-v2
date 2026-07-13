@echo off
chcp 65001 >nul
cd /d C:\Users\yamas\AI_Workspace\minpaku-v2-yadozei\scripts

echo ================================================
echo  OTA/宿泊税 再ログイン (yadozei-listener)
echo ================================================
echo.
echo [1/3] 常駐を一時停止します...
call pm2 stop yadozei-listener

echo.
echo [2/3] ログイン用ブラウザを起動します。
echo    開いたタブで必要なサイト (Airbnb / Booking.com / やどぜい) にログインし、
echo    終わったらブラウザを閉じてください。自動で次に進みます。
echo    ※ Ctrl+C は押さないでください (押すと常駐の再開がスキップされます)
echo.
node yadozei-listener.mjs --login

echo.
echo [3/3] 常駐を再開します...
call pm2 start yadozei-listener

echo.
echo 完了。数分以内に Discord (#民泊管理) に「✅ 再ログイン確認」が届けば成功です。
pause
