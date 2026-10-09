# cf-pan · 个人网盘

基于 **Cloudflare Workers + R2** 的轻量网盘：密码登录、文件夹、上传（大文件自动分片）、在线预览 / 断点下载、带有效期的分享链接。

- 免费额度：R2 每月 10GB 存储，下载流量免费；Workers 每天 10 万次请求
- 单文件大小基本不限（20MB 分片上传）
- 手机、电脑浏览器都能用

---

## 🔑 需要你授权 / 操作的事（共 4 步）

> 代码已经写好，下面这些只能由你本人在账号里操作。

### 1. Cloudflare：开通 R2 并建桶
1. 登录 Cloudflare 控制台 → 左侧 **R2 对象存储**
2. 首次使用需点 **开通 R2**（Cloudflare 可能要求绑定信用卡或 PayPal；10GB 以内不扣费）
3. 点 **创建存储桶**，名称填 `cf-pan`（必须和 `wrangler.toml` 里一致）

### 2. Cloudflare：创建 API 令牌 + 找到账户 ID
1. 右上角头像 → **我的个人资料** → **API 令牌** → **创建令牌**
2. 选模板 **编辑 Cloudflare Workers**，账户选你自己的，创建后**复制令牌**（只显示一次）
3. 账户 ID：Workers 和 Pages 页面右侧的 **账户 ID**，复制

### 3. GitHub：在本仓库添加 4 个 Secrets
仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，依次添加：

| 名称 | 填什么 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 第 2 步的 API 令牌 |
| `CLOUDFLARE_ACCOUNT_ID` | 第 2 步的账户 ID |
| `PAN_PASSWORD` | 你想用的网盘登录密码 |
| `PAN_SECRET` | 一串随机长字符（32 位以上，乱敲即可，用于签名） |

### 4. 部署
仓库 → **Actions** → **Deploy** → **Run workflow**。约 1 分钟后完成，访问：

```
https://cf-pan.<你的子域>.workers.dev
```

（子域在 Cloudflare 控制台 Workers 和 Pages 页面可以看到。）

---

## 可选：绑定自己的域名
`workers.dev` 在中国大陆经常打不开，建议绑一个托管在 Cloudflare 的域名：
Workers 和 Pages → `cf-pan` → **设置** → **域和路由** → **添加自定义域**，例如 `pan.你的域名`。

## 以后更新
改代码推送到 `main` 分支会自动重新部署。

## 本地调试
```bash
npm install
printf 'PASSWORD=test\nSECRET=dev-secret\n' > .dev.vars
npx wrangler dev
```

## 文件结构
```
src/index.js   后端接口（登录、列表、上传、下载、分享）
src/page.js    前端页面
wrangler.toml  Worker 配置与 R2 绑定
.github/workflows/deploy.yml  自动部署
```
