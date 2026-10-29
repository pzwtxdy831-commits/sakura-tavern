#!/usr/bin/env sh
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --omit=dev
echo "电脑: http://127.0.0.1:8290/    手机: http://<本机局域网IP>:8291/"
exec node server.js
