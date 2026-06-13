# 朋友局部署说明

这个版本目标是“单台服务器 + SQLite + 3-5 个朋友稳定玩”，不是公开商业发行。

## 当前结论

- 游戏主流程、断线恢复、暂停/恢复、房间关闭、随机拍卖、事件/锦囊隐私、交易确认、终局结算等已有自动化覆盖。
- 生产部署已支持一个 Node 服务同时托管网页和 Socket.IO，只需要开放一个端口。
- 数据默认写入 SQLite：`data/rooms/auctioneer.sqlite`。

## 服务器要求

- Node.js 24.x。当前项目使用 `node:sqlite`，低版本 Node 可能不能运行。
- 一台普通 1 核 1G 以上服务器即可支持朋友局。
- 安装依赖和构建时需要 devDependencies；运行时可以保留完整 `node_modules`，朋友局不必强行裁剪。

## 一键构建

```powershell
npm ci
npm run build:prod
npm run test:prod-smoke
```

`test:prod-smoke` 会启动生产产物并跑完整浏览器流程。通过后再部署。

## 本机或服务器启动

Windows PowerShell 示例：

```powershell
$env:NODE_ENV="production"
$env:HOST="0.0.0.0"
$env:PORT="3001"
$env:AUCTIONEER_ALLOWED_ORIGINS="http://你的服务器IP:3001"
$env:AUCTIONEER_REPOSITORY="sqlite"
$env:AUCTIONEER_DATA_DIR="data/rooms"
$env:AUCTIONEER_SQLITE_PATH="data/rooms/auctioneer.sqlite"
$env:AUCTIONEER_STATIC_DIR="apps/web/dist"
npm run start:prod
```

Linux 示例：

```bash
NODE_ENV=production \
HOST=0.0.0.0 \
PORT=3001 \
AUCTIONEER_ALLOWED_ORIGINS=http://你的服务器IP:3001 \
AUCTIONEER_REPOSITORY=sqlite \
AUCTIONEER_DATA_DIR=data/rooms \
AUCTIONEER_SQLITE_PATH=data/rooms/auctioneer.sqlite \
AUCTIONEER_STATIC_DIR=apps/web/dist \
npm run start:prod
```

访问：`http://你的服务器IP:3001`

## 域名和 HTTPS

如果你用域名或反向代理，把 `AUCTIONEER_ALLOWED_ORIGINS` 改成朋友实际打开的网址：

```bash
AUCTIONEER_ALLOWED_ORIGINS=https://auction.example.com
```

反向代理需要支持 WebSocket。Nginx 关键配置：

```nginx
location / {
  proxy_pass http://127.0.0.1:3001;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 数据备份和清理

备份：

```powershell
Copy-Item data/rooms/auctioneer.sqlite data/rooms/auctioneer.sqlite.bak
Copy-Item data/rooms/auctioneer.sqlite-wal data/rooms/auctioneer.sqlite-wal.bak -ErrorAction SilentlyContinue
Copy-Item data/rooms/auctioneer.sqlite-shm data/rooms/auctioneer.sqlite-shm.bak -ErrorAction SilentlyContinue
```

清空测试数据：

```powershell
Remove-Item data/rooms/auctioneer.sqlite* -Force
```

## 开局前检查

- `npm run test:prod-smoke` 通过。
- 浏览器打开 `/health` 返回 `{"ok":true}`。
- 朋友访问的网址已经写入 `AUCTIONEER_ALLOWED_ORIGINS`。
- 服务器防火墙放行 `PORT`。
- 至少让 4 个浏览器标签页创建、加入、准备、开局、刷新恢复一次。

## 已知边界

- 这是单机部署；不要同时跑多个 Node 实例共用一个 SQLite 文件。
- SQLite 的 Node 内置模块会显示 ExperimentalWarning，这是当前 Node 的提示，朋友局可接受。
- 商业公开运营仍需要日志告警、备份策略、合规、长时间 soak、真实弱网测试和更多人工 QA。
