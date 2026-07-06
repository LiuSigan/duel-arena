# 双人对战射击 · 联机版

发一个链接给朋友就能打:双方打开同一个网址,点"快速匹配"自动配对,或用房间号私人对战。本地双人、人机模式也都保留。

## 本地运行(部署前先测一下)

```bash
npm install
npm start
# 浏览器打开 http://localhost:3000
# 开两个浏览器窗口就能模拟两个玩家
```

## 部署到 Render(免费,推荐)

1. 把这个文件夹上传到你的 GitHub 仓库(新建仓库 → Add file → Upload files,把 `server.js`、`package.json`、`public/` 拖进去;**不要**上传 `node_modules` 和 `test.js`)
2. 注册/登录 https://render.com (可直接用 GitHub 账号登录)
3. 点 **New → Web Service**,选择你刚才的仓库
4. 配置:
   - **Region**: Singapore(离你们近,延迟低)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. 点 Create,等 1-2 分钟部署完成,会得到一个 `https://xxx.onrender.com` 的网址
6. 把网址发给朋友,双方都点"🌐 联机对战 → 开始匹配",搞定

## 注意事项

- Render 免费套餐 15 分钟无人访问会休眠,下次打开要等 30 秒左右冷启动,属正常现象
- 快速匹配是全局的:如果同时有陌生人也在匹配,可能会被配到一起。想只跟指定朋友打,用"创建房间 + 房间号"方式
- 架构:创建方/先匹配到的一方作为"权威端"运行游戏逻辑,另一方发送按键、接收画面同步(60Hz + 插值平滑)

## 文件结构

```
server.js        # WebSocket 中继服务器(房间管理、快速匹配、消息转发)
public/index.html # 游戏本体(单文件,含全部游戏逻辑和联机客户端)
package.json
test.js          # 联机流程自动化测试(可选,npm start 后 node test.js)
```
