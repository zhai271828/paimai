# 拍卖师法则 Online

一个给朋友局使用的多人联机网页游戏版本。项目目标是单台服务器部署、浏览器打开即玩，后端用 Node.js + Socket.IO，房间数据默认存到 SQLite。

## 目录

- `code/`: 联机游戏工程代码
- `code/apps/web/`: React/Vite 前端
- `code/apps/server/`: Fastify + Socket.IO 服务端
- `code/packages/engine/`: 游戏规则引擎
- `code/packages/shared/`: 前后端共享类型和内容
- `image/`: 流程图和开发图示
- `*.docx`: 策划案和卡牌资料

## 本地运行

```bash
cd code
npm ci
npm run dev
```

默认会同时启动网页和服务端。生产构建：

```bash
cd code
npm run build:prod
npm run test:prod-smoke
```

## 朋友联机部署

详细部署说明见 [code/DEPLOY_FRIENDS.md](code/DEPLOY_FRIENDS.md)。

推荐流程：

1. 准备一台云服务器，安装 Node.js 24.x。
2. 把仓库拉到服务器，运行 `npm ci` 和 `npm run build:prod`。
3. 用 `npm run start:prod` 启动服务，先用服务器公网 IP 测通。
4. 将域名 `belveth.xyz` 的 DNS 解析到服务器公网 IP。
5. 用 Nginx/Caddy 做 HTTPS 反向代理，并确保 WebSocket 转发可用。
6. 把 `AUCTIONEER_ALLOWED_ORIGINS` 设置成朋友实际访问的网址，例如 `https://belveth.xyz`。

