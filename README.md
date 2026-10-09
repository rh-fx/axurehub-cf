# AxureHub on Cloudflare

> 免费、高效、可私有化部署的 Axure 原型托管方案 —— 替代停服的 Axure Cloud（Axure RP 8 及更早版本无法直接发布原型）。

基于 **Cloudflare Pages + Functions + KV + R2 + D1(SQLite)** 构建：**零服务器、零运维，全部跑在 Cloudflare 免费额度内**，也可以整套搬到你自己的账号里私有部署。

---

## 一、为什么需要它

| 问题 | 本方案 |
| --- | --- |
| Axure RP 8 / 更早版本无法发布到 Axure Cloud | 本地导出 HTML 文件夹，直接上传到自己的站点 |
| 官方托管不私有、不可控、有费用 | 部署在你自己的 Cloudflare 账号下，数据全部在你自己的 R2 / KV / D1 里 |
| 自建静态托管无法管理版本、无法搜索 | 内置版本管理 + 毫秒级全站实时搜索 + 外部链接导航 |
| Worker / Pages Functions 有请求体大小限制，大原型传不上去 | 浏览器端**路径剥离 + 分包并发上传**，单片默认 4 MB，理论上无总大小上限 |

---

## 二、架构

```
浏览器（无构建步骤，原生 ES Module）
   │  ① 选择 Axure 导出文件夹 → 剥离外层路径 → 打包成分片 → 4 路并发上传
   ▼
Cloudflare Pages Functions
   ├─ _middleware.js     全站访问密码（HMAC 签名 Cookie 会话）
   ├─ api/[[path]].js    REST API（原型 / 版本 / 链接 / 上传 / 设置 / 搜索索引）
   ├─ p/[[path]].js      /p/<slug>/…   原型静态文件托管（R2 流式回源）
   └─ s/[[path]].js      /s/<slug>     单文件 HTML 原型托管
   │
   ├─ KV       元数据存储（未绑定 D1 时的默认后端）
   ├─ D1       SQLite 结构化存储（可选，绑定后自动建表并优先使用）
   └─ R2       原型全部静态文件（分片写入，按需按 parts 顺序流式读取）
```

* **后端双存储**：绑定 D1 时使用 SQLite（`prototypes` / `versions` / `links` / `settings` 四张表）；不绑定则自动回退到 KV（单键 JSON 文档）。两套后端接口完全一致，零配置也能跑。
* **前端无构建**：原生 HTML + ES Module，Pages 直接托管，不需要 npm build。

---

## 三、功能清单

### 1. 完整文件夹上传（Axure 导出目录）
* 选择（或拖拽）整个导出文件夹，浏览器端自动**剥离最外层目录**，使 `index.html` 落在根目录；
  若 `index.html` 位于更深层，会自动识别并给出「剥离到…」候选，可手动切换。
* **自动识别根目录入口**：按 `index.html → index.htm → start.html → start_c_1.html` 顺序探测，找不到时回退到任意根级 HTML。
* 自动过滤 `.DS_Store` 等无用文件；非法路径（`..` 越界、重复路径、保留路径 `.parts`）在服务端二次校验。

### 2. 绕过 Worker 上传大小限制（分片 + 分包 + 并发）
* **分包（packing）**：多个小文件会被打包进同一个 HTTP 请求；超过单片上限的文件会被切成多个片段。
  因此「几百个零散小文件」不会被拆成几百个请求，而「单个几十 MB 的大文件」也能顺利上传。
* **分片协议**：`[uint32 manifest长度][manifest JSON][文件字节…]`，服务端零解压、零拷贝直接切片写 R2。
* **并发 + 重试**：默认 4 路并发，单片失败自动重试 3 次（指数退避）。
* 单片上限默认 **4 MB**（可用 `SHARD_SIZE` 调整），远低于 Cloudflare Worker 请求体上限，稳定不踩坑。
* 跨片文件在 R2 中以 `.parts/<fileIndex>/<seq>` 存放，读取时**按序流式拼接**，不占用 Worker 内存。

### 3. 单文件 HTML 上传
* 只上传一个 HTML 也能托管（适用于导出为单页、或自包含的原型）。
* 访问地址：`/s/<slug>`，与文件夹原型一样支持多版本。

### 4. 版本管理
* 每次上传生成一个新版本（也可覆盖指定版本），带版本说明、时间、文件数、总体积。
* 可一键切换当前生效版本、删除历史版本（自动清理 R2 中该版本的全部对象）。
* 访问时可用 `?v=<版本号>` 临时预览历史版本。

### 5. 外部链接导航
* 独立的「外部链接」列表：名称、地址、描述/标签、**自定义 Emoji 图标**。
* 支持按自定义顺序 / 名称 / 添加时间排序，支持上移下移拖拽式调序（按钮调序）。
* 自动补全 `https://` 前缀。

### 6. 毫秒级实时搜索
* 首页搜索框（`Ctrl/⌘ + K` 聚焦，`Esc` 清空，`Enter` 打开第一条）。
* 一次性拉取精简索引（`/api/index`），在内存中对**原型名 / 原型标识 / 描述标签 / 页面名 / 链接名 / 链接地址**做前缀无关的子串匹配，支持空格分隔的多关键词 AND。
* 结果按「原型 / 页面 / 链接」分组，关键词高亮，并显示真实耗时（通常 < 2 ms）。

### 7. 页面级导航
* 上传时自动解析 Axure 的 `data/document.js`（sitemap 的 `pageName` / `name`，兼容 `pageNames` 映射表），
  并在文件列表中交叉校验，确保页面链接真实存在；解析不到时回退为读取各 HTML 的 `<title>`。
* 原型卡片内可直接展开页面清单并跳转到具体页面。

### 8. 双重安全控制
| 层级 | 机制 |
| --- | --- |
| 全站访问密码 `SITE_PASSWORD` | `functions/_middleware.js` 拦截**所有**请求（页面、API、原型静态文件），未登录 HTML 请求 302 到 `/login.html`，API 请求返回 401 |
| 管理员密码 `ADMIN_PASSWORD` | 与访问密码完全独立；上传 / 删除 / 修改 / 版本管理 / 链接管理 / 设置 等写操作均需管理员身份，否则 403 |

* 会话为 **HMAC-SHA256 签名的 HttpOnly Cookie**（`ahub_session`），无服务端状态、防篡改、可过期（`SESSION_TTL`，默认 7 天）。
* 管理员密码可直接登录并同时获得浏览权限；访问密码登录只能浏览。
* 密码比较使用常量时间比较，避免时序侧信道。
* 密码可来自环境变量（推荐，优先）或在「管理 → 设置」中保存到 D1/KV。

---

## 四、部署

### 0. 准备
```bash
npm i            # 只需 wrangler
npx wrangler login
```

### 1. 创建资源
```bash
npm run r2:create     # wrangler r2 bucket create axurehub-protos
npm run kv:create     # wrangler kv:namespace create AXUREHUB_KV
npm run d1:create     # wrangler d1 create axurehub-db   （可选）
```

### 2. 绑定
**方式 A（推荐）**：在 Cloudflare Dashboard → Workers & Pages → 你的 Pages 项目 →
Settings → Functions 中添加 KV / R2 / D1 绑定，绑定名分别为 **`KV`**、**`BUCKET`**、**`DB`**；
在 Settings → Environment variables 中设置 `SITE_PASSWORD`、`ADMIN_PASSWORD`（建议用 *Encrypt* 类型）。

**方式 B**：把 `wrangler.toml` 中对应段落的注释打开并填入 id，然后用 `npm run deploy` 部署（绑定随配置生效）。

### 3. 设置密钥
```bash
npm run secret:site    # wrangler pages secret put SITE_PASSWORD
npm run secret:admin   # wrangler pages secret put ADMIN_PASSWORD
```
两个都不设置 = 完全开放（适合内网/自用）；强烈建议至少设置 `ADMIN_PASSWORD`。

### 4. 部署
```bash
npm run deploy         # wrangler pages deploy public --project-name=axurehub
```
也可直接连接 Git 仓库，让 Pages 自动构建（无需构建命令，输出目录填 `public`）。

### 5. 本地开发
```bash
npm i
cp .dev.vars.example .dev.vars     # 填写本地密码
npm run dev                        # KV + R2 + D1 全绑定
npm run dev:kv                     # 只用 KV + R2（不启用 D1）
npm run d1:schema:local            # 本地 D1 建表（可选，程序也会自动建）
```
> 本地 `wrangler pages dev` 会把 R2 / KV / D1 模拟在 `.wrangler/state` 下，全部资源均为「[simulated locally]」，不需要联网、不会产生费用。

**WSL / Windows 混合环境注意**
如果你在 WSL 里开发，但 `npm` 实际指向 Windows 的 Node（例如 `which npm` 显示 `/mnt/d/.../npm`），
会因为 UNC 路径导致 `CMD.EXE ... 不支持` 与 `Cannot find module ...\wrangler\bin\wrangler.js`。
解决办法：让 shell 优先使用一个**运行在 WSL 内的 Linux 版 Node**，例如

```bash
export PATH="/root/.workbuddy/binaries/node/versions/22.12.0/bin:$PATH"   # 或你自己的 nvm / apt 安装的 node
node -v && npm run dev
```
（`wrangler pages dev` 必须在 Linux Node 下运行）；或者在 Windows PowerShell 中、以 `C:\...` 之类的本地路径打开项目再执行 `npm run dev`。

---

## 五、使用

1. 打开站点，用**全站访问密码**登录（或管理员密码登录直接获得管理权）。
2. 右上角「⚙️ 管理」进入管理端（需要管理员身份）。
3. **上传 → 完整文件夹**：选择/拖入 Axure 导出的整个文件夹 → 确认「路径剥离」和入口 `index.html` →
   填写名称、Emoji、描述、版本说明 → 开始上传（实时进度：分片数 / 字节数）。
4. **上传 → 单个 HTML 文件**：选择单个 HTML，作为独立原型托管。
5. **原型与版本**：切换生效版本、删除版本、删除原型、编辑名称/图标/描述。
6. **链接管理**：增删改外部链接、调整顺序、设置 Emoji。
7. **设置**：查看/修改两个密码、查看当前存储后端与分片大小。
8. 首页搜索框实时搜索所有原型、页面与链接。

---

## 六、目录结构

```
.
├── functions/
│   ├── _middleware.js              全站访问密码中间件
│   ├── _lib/
│   │   ├── auth.js                 会话签名、双密码校验、管理员判定
│   │   ├── store.js                D1(SQLite) / KV 双存储后端
│   │   ├── r2.js                   R2 写入、前缀删除、parts 流式拼接
│   │   ├── shard.js                分片二进制协议解析
│   │   └── util.js                 JSON 响应、slug、MIME、路径规范化
│   ├── api/[[path]].js             REST API 总路由
│   ├── p/[[path]].js               /p/<slug>/… 原型静态托管
│   └── s/[[path]].js               /s/<slug> 单文件原型托管
├── public/
│   ├── index.html                  首页 + 管理端（hash 路由）
│   ├── login.html                  登录页（中间件放行）
│   └── assets/
│       ├── style.css
│       ├── common.js               API 封装 / 会话 / 格式化
│       ├── home.js                 卡片墙 + 实时搜索 + 链接导航
│       ├── admin.js                上传 / 版本 / 链接 / 设置
│       ├── uploader.js             路径剥离、分包打包、并发上传、页面解析
│       └── app.js                  入口与路由
├── schema.sql                      D1 表结构
├── wrangler.toml
└── package.json
```

---

## 七、API

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | 公开 | 密码登录，返回角色并下发 Cookie |
| POST | `/api/auth/logout` | 公开 | 清除会话 |
| GET | `/api/auth/me` | 公开 | 当前身份 / 是否管理员 |
| GET | `/api/bootstrap` | 公开 | 后端类型、是否需要密码 |
| GET | `/api/index` | 登录 | 搜索索引（原型 + 页面 + 链接） |
| GET | `/api/prototypes` | 登录 | 原型列表（含版本摘要） |
| GET | `/api/prototypes/:id` | 登录 | 原型详情（含文件索引） |
| PATCH | `/api/prototypes/:id` | 管理员 | 改名/图标/描述/标识/切换版本 |
| DELETE | `/api/prototypes/:id` | 管理员 | 删除原型及其全部 R2 对象 |
| DELETE | `/api/prototypes/:id/versions/:v` | 管理员 | 删除指定版本 |
| POST | `/api/prototypes/:id/versions/:v/activate` | 管理员 | 切换生效版本 |
| GET | `/api/prototypes/:id/files?version=` | 登录 | 版本文件清单 |
| POST | `/api/upload/init` | 管理员 | 创建上传任务（返回 uploadId / 版本 / 单片大小） |
| POST·PUT | `/api/upload/shard?uploadId=&index=` | 管理员 | 上传单个分片（二进制） |
| POST | `/api/upload/complete` | 管理员 | 合并索引、激活版本、清理临时对象 |
| POST | `/api/upload/abort` | 管理员 | 取消上传并清理 |
| GET/POST | `/api/links`、PATCH/DELETE `/api/links/:id`、POST `/api/links/reorder` | 管理员（读：登录） | 链接 CRUD 与排序 |
| GET/POST | `/api/settings` | 管理员 | 读取运行状态 / 保存密码 |

---

## 八、设计与性能说明

* **上传为什么能突破大小限制**：Cloudflare Worker/Pages Functions 对**单个请求体**有上限。
  方案把请求体控制在单片 ≤ 4 MB，并在服务端把片内字节直接切片写入 R2，
  既绕开了请求体上限，又不产生内存峰值（无 base64、无整体解压）。
* **为什么分包而不是「一文件一片」**：Axure 导出常含数百个几 KB 的小文件，
  逐文件请求会产生上百次往返；分包后同一次请求可携带许多小文件，上传耗时显著下降。
* **读取为什么快**：绝大多数文件只有 1 个 part，直接把 R2 的 `body` 透传给客户端（零拷贝）；
  跨片文件按序流式拼接，不落内存。HTML 用 `no-cache`，静态资源 `max-age=300`。
* **存储后端选择**：小规模（几十个原型）用 KV 即可；原型/版本较多或需要结构化查询时绑定 D1。
* **SQLite 表结构**见 `schema.sql`；绑定 D1 后程序首次请求会自动 `CREATE TABLE IF NOT EXISTS`。

---

## 九、已知限制

* Axure 页面名解析是启发式的（不同 RP 版本生成的 `data/document.js` 结构有差异）；
  解析失败时会回退为「根目录 HTML 的 `<title>`」，页面导航可能不完整，但不影响原型浏览。
* 单个分片大小受 `SHARD_SIZE` 与平台请求体上限约束；如需上传超大单文件（>100 MB），
  建议先在 Axure 中拆分或使用更小的 `SHARD_SIZE`。
* 会话 Cookie 不支持并发多端独立失效（改密码后旧 Cookie 在 `SESSION_TTL` 内仍有效，除非同时修改 `SESSION_SECRET`）。
* 登录接口未内置频率限制（个人/团队自用场景）；若需公网暴露，建议在 Cloudflare WAF 中配置速率限制规则。

---

## 十、许可

MIT
