# Sakura 🌸

一个**轻量、启动快**的角色扮演聊天前端。读写 SillyTavern 的角色卡 / 聊天记录 / 世界书 / 预设格式，可以直接拿已有的数据来用；只保留玩角色扮演真正用得到的功能。

> 非官方项目，与 SillyTavern、酒馆助手（JS-Slash-Runner）等项目没有关联。Sakura 的代码全部独立编写，只是兼容它们的数据格式和常用接口名。

## 为什么做它

- **快**：服务端零框架，前端零构建。本机实测（Windows，Node 24）：
  - 冷启动到能响应约 0.6 秒；
  - 打开一个 617 楼、22MB 的聊天文件 0.1 秒（只加载最近 24 楼，往上滑再加载）；
  - 一次完整的提示词拼装（含 500+ 条世界书、EJS 模板）约 80 毫秒。
- **少**：没有扩展管理、没有背景、没有十几页设置。聊天界面满屏都是正文，底下只有「魔法棒 / 输入框 / 发送」三样。
- **全**：预设（条目开关、注入深度、顺序）、正则、世界书、宏、EJS 模板、MVU 变量、角色卡前端、记忆总结都是原生实现，不靠插件。

## 功能

- **主页**：角色卡墙，带简介和标签；支持导入 PNG / JSON 角色卡，角色卡自带的世界书自动转成世界书文件。
- **聊天**：流式输出、重新生成（左右翻）、继续写、编辑、删除（支持多选）、隐藏楼层、从任意楼层分支、思考过程折叠显示。
- **生成统计**：首字时间（TTFT）、tokens/s、输入 / 输出 token（优先用接口返回的真实值）、总用时。
- **魔法棒**（输入框左边）：插头快切（点开还能直接换模型）、预设快捷开关（自己挑哪些放进来）、重新生成、继续、删除楼层、到底部、跳到上一楼顶部、提示词查看器、作者注释、快速回复、脚本按钮。
- **插头（连接）**：只保留三种来源——Vertex AI（服务账号 JSON 或 API Key）、OpenAI 兼容、Google AI Studio。一个名字对应一个地址和模型，**和预设、角色卡互不绑定**，切角色卡不会把你的插头和预设换掉。
- **提示词后处理**：不处理 / 合并 / 半严格 / 严格 / 单条 user，每种都分「含工具」和「不含工具」。
- **预设**：直接用 SillyTavern 的 Chat Completion 预设 JSON，注入顺序、深度、角色和 SillyTavern 一致。
- **世界书**：关键词 / 正则 / 次要关键词逻辑 / 常驻 / 递归 / 分组 / 概率 / 按深度插入 / outlet，全局世界书一键开关。
- **EJS 模板**：`getvar` / `setvar` / `getMessageVar` / `getwi` / `matchChatMessages` 等常用写法。
- **MVU 变量**：解析 `<UpdateVariable>` 里的 JSON Patch 和 `_.set()` 写法，变量按楼层、按回复保存；状态栏之类的角色卡前端可以读到变量。
- **角色卡前端**：消息里的 HTML 页面用 iframe 渲染，提供常用的酒馆助手接口（变量、楼层、世界书、事件、`triggerSlash` 等），较新的卡（Vue + zod）也能跑。
- **脚本与快速回复**：可以导入酒馆助手脚本 JSON（在后台隐藏框架里运行，按钮放进魔法棒）和快速回复集。
- **记忆总结**：最近 N 楼原样发送；更早的楼层攒够一批就用你指定的便宜模型写成摘要，原文隐藏不发送，摘要作为「前情提要」放在最前面；摘要多了还会再压缩一层。
- **自动备份**：默认每 3 楼备份一次聊天，长按（电脑上右键）聊天记录就能看到备份，可以恢复成新聊天或覆盖。
- **小说尾部样张**：预设里放一个占位标记，生成时会换成你指定 txt 小说的下一段，用来校准文风。
- **手机**：同一个服务同时开 8290（电脑）和 8291（手机）两个端口，局域网直接访问；`android/` 里有一个不用 Gradle 就能打包的 WebView 外壳，装上就是全屏、没有地址栏的 App。
- **外观**：字体可以选黑体、楷体等，也可以导入自己的字体文件；字号、聊天宽度用滑块调。

## 快速开始

需要 [Node.js](https://nodejs.org/) 20 或更新。

```bash
git clone https://github.com/pzwtxdy831-commits/sakura-tavern.git
cd sakura-tavern
npm install
node server.js
```

打开 <http://127.0.0.1:8290/>。手机连同一个 Wi-Fi，打开 `http://电脑的局域网IP:8291/`。Windows 上也可以直接双击 `start.bat`。

### 从 SillyTavern 搬家

第一次启动时，Sakura 会自动从 SillyTavern 的 `data/default-user` 导入角色卡、聊天、世界书、预设、正则、人设和密钥（**只复制，不改动原文件**）。默认找 `../SillyTavern/data/default-user`；位置不一样的话，复制一份 `sakura.config.example.json` 改名为 `sakura.config.json`，把 `stData` 改成你的路径，或者设置环境变量 `SAKURA_ST_DATA`。之后也可以在「设置 → 数据」里再补导入。

### 端口

默认 8290 / 8291，可以用环境变量 `SAKURA_PORT`、`SAKURA_MOBILE_PORT` 修改。服务监听 `0.0.0.0`，请只在你信任的局域网里使用，不要直接暴露到公网（没有登录验证）。

### 安卓 App

```bash
# 需要 ANDROID_HOME（build-tools 36 + platforms/android-36）和 JDK 17+
bash android/build-apk.sh
```

想把默认地址打包进 App，就在 `sakura.config.json` 里填 `apkDefaultUrl`（可选再填一个备用地址 `apkAltUrl`）；不填的话第一次打开会让你输入地址。

## 数据都在哪

所有数据都在 `data/` 文件夹里，格式和 SillyTavern 一样（角色卡是 PNG，聊天是 JSONL，世界书 / 预设是 JSON），随时可以拿回 SillyTavern 用。密钥存在 `data/secrets.json`，不会上传到任何地方。

## 已知限制

- 只支持 Chat Completion（对话补全）类接口，不支持 Text Completion、Claude 原生接口、群聊。
- 酒馆助手兼容层覆盖的是常用接口；依赖 SillyTavern 内部实现的脚本（比如改写发往 SillyTavern 后端请求的脚本）不会生效。
- 角色卡里内嵌的酒馆助手脚本默认不运行（MVU 由 Sakura 原生处理）。

## 协议

[AGPL-3.0](LICENSE)。可以自由使用、修改、再分发；修改后公开提供服务或分发时需要同样开源。第三方库的协议见 [NOTICE.md](NOTICE.md)。
