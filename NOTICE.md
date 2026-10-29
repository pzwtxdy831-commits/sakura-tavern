# 第三方组件与声明

Sakura 自身的代码以 AGPL-3.0 发布。下面这些第三方组件按各自的协议使用：

| 组件 | 用途 | 协议 | 位置 |
|---|---|---|---|
| [lodash](https://lodash.com/) | 服务端工具函数、角色卡前端里的全局 `_` | MIT | npm 依赖；`public/vendor/lodash.min.js`（附 `lodash.LICENSE.txt`） |
| [yaml](https://eemeli.org/yaml/) | 解析 / 输出 YAML（变量、世界书模板） | ISC | npm 依赖 |
| [jQuery](https://jquery.com/) 3.5.1 | 角色卡前端里的全局 `$` | MIT | `public/vendor/jquery-3.5.1.min.js`（文件头含协议） |
| [Zod](https://zod.dev/) 3.x | 角色卡前端里的全局 `z`（备用） | MIT | `public/vendor/zod.umd.js`（附 `zod.LICENSE.txt`） |
| Vue 3、Zod 4 | 角色卡前端需要时从 jsDelivr CDN 加载，不随仓库分发 | MIT | 运行时加载 |
| Noto Serif SC、Cormorant Garamond | 界面字体，从 Google Fonts 镜像加载，不随仓库分发 | OFL | 运行时加载 |

## 兼容性声明

- Sakura 读写 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 的数据格式（角色卡、聊天 JSONL、世界书、Chat Completion 预设、正则脚本），并按相同的规则拼装提示词，方便用户迁移。Sakura 没有复制 SillyTavern 的源代码，也与 SillyTavern 项目无关。
- `public/js/th-shim.js` 按照酒馆助手（JS-Slash-Runner）公开的接口名，独立实现了一部分接口，让现有的角色卡前端可以运行。Sakura 与酒馆助手项目无关。
- MVU 变量的更新格式（`<UpdateVariable>`、JSON Patch、`_.set`）参照社区通用写法独立实现。
- 仓库里不包含任何角色卡、预设、世界书或第三方美化。
