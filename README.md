# cf-pan

基于 **Cloudflare Workers + Backblaze B2** 的轻量网盘：密码登录、文件夹、上传（大文件自动分片）、在线预览 / 断点下载、带有效期的分享链接。

- 存储：Backblaze B2 永久免费 10GB，注册无需绑卡
- 计算：Cloudflare Workers 免费版，每天 10 万次请求
- Worker 通过 S3 兼容接口（SigV4 签名）读写 B2，代码见 `src/s3.js`

## 部署

### 1. Backblaze B2
1. 注册并登录 secure.backblaze.com，启用 B2 Cloud Storage
2. 新建 **Private** 桶（如 `cf-pan-mj`），记下 Endpoint（如 `s3.us-west-004.backblazeb2.com`）
3. 新建只能访问该桶的 Application Key（Read and Write），记下 keyID 和 applicationKey

### 2. 配置
- `wrangler.toml` 的 `[vars]`：`B2_ENDPOINT`、`B2_BUCKET`
- Worker Secrets（`wrangler secret put` 或控制台「变量和机密」）：
  - `PASSWORD` 网盘登录密码
  - `SECRET` 随机长字符串（签名用）
  - `B2_KEY_ID`、`B2_APP_KEY`

### 3. 部署
```bash
npm install
npx wrangler deploy
```
或在 GitHub 仓库添加 Actions Secrets `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`PAN_PASSWORD`、`PAN_SECRET` 后，手动运行 Actions → Deploy。

`workers.dev` 域名在中国大陆可能无法访问，建议在 Worker 设置里绑定自有域名。

## 文件
```
src/index.js   Worker 后端（登录、列目录、上传、下载、分享）
src/s3.js      S3/B2 签名客户端
src/page.js    中文前端页面
wrangler.toml  Worker 配置
```
