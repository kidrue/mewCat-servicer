# mewCat 翻译服务

为 `chorme-translate` 提供免费 AI 翻译服务的后端。Node.js + TypeScript + Fastify + Prisma 7，接入硅基流动。包括 Chrome 扩展可用的加密客户端、持久化防重放、自动设备注册、限额和管理 CLI。

阿里云轻量服务器请直接参照 [Ubuntu 部署命令](docs/deploy-aliyun.md)，包含私有仓库拉取、容器部署、Nginx、HTTPS、更新和备份。

推送到 `main` 自动构建镜像并部署，请参照 [GitHub Actions 自动部署](docs/github-actions-deploy.md) 配置服务器和 GitHub Secrets。

## 快速启动

需要 Node.js **22.12+**（推荐 Node 22 最新补丁版）和 npm 11。仓库内不包含硅基流动 API Key；模型须在控制台选择。未提供真实凭证的验证使用本地模拟供应商，不会产生 API 费用。

```powershell
# 使用 npm 11，避免旧版 npm 的可选同伴依赖解析问题；不会升级全局 npm。
npx --yes npm@11 ci
Copy-Item .env.example .env
# 编辑 .env，填写 SILICONFLOW_API_KEY、SILICONFLOW_MODEL。
npm run admin -- keys
npm run db:migrate
npm run dev
```

Linux/macOS 将 `Copy-Item` 换成 `cp`。如果 SQLite 本机预编译包不可用，需要安装编译工具；Dockerfile 已准备编译环境。

`keys` 生成服务器私钥和 IP 哈希盐，不覆盖现有文件；打印的**签名公钥指纹**可固定到扩展配置中。开发地址为 `http://127.0.0.1:3000`，检查 `GET /health`。

生产启动：

```sh
npm run build
npm start
```

服务启动时检查数据库迁移；每小时清理过期 nonce、额度计数和超过 30 天的请求统计。数据库及密钥目录必须持久化。**当前部署模型为单进程 SQLite，不使用 PM2 cluster 或多副本共享 SQLite。**

## Chrome 扩展接入

`npm run build` 同时生成 `dist/client/mewcat.js`，把这个文件复制到扩展项目，通过本地 ESM 引入。它已包含依赖，不需要远程脚本，适合 Manifest V3。源码位于 `client/`；Web Crypto 生成的客户端私钥默认不可导出，使用 IndexedDB 保存，不能 JSON 序列化或写入 `chrome.storage`。

```json
{
  "manifest_version": 3,
  "name": "chorme-translate",
  "version": "1.0.0",
  "background": { "service_worker": "background.js", "type": "module" },
  "host_permissions": ["https://translate.example.com/*"]
}
```

```js
// 在 background.js 中使用；域名替换成你的 HTTPS 服务。
import { TranslationClient, loadClientState, saveClientState } from './mewcat.js';

const origin = 'https://translate.example.com';
const saved = await loadClientState(origin);
const client = await TranslationClient.connect({
  baseUrl: origin,
  ...(saved ? { state: saved } : {}),
  // 推荐填写 `npm run admin -- keys` 打印的公钥指纹：
  // pinnedSigningThumbprint: '部署时获得的公钥指纹',
});

// 注册之前也保存密钥，避免 service worker 重启后生成新的身份。
await saveClientState(origin, client.getState());

export async function activate() {
  await client.register('chorme-translate');
  await saveClientState(origin, client.getState());
}

export async function translate(texts, targetLanguage) {
  return client.translate({ texts, sourceLanguage: 'auto', targetLanguage });
}

// 首次激活时调用 activate()，服务端按设备密钥自动注册。
// 已激活后：await translate(['Hello world'], 'zh-CN');
// 返回：{ translations: ['你好，世界'] }
// await client.usage(); // 本设备当天已用字符、上限、下次 UTC 重置时间
```

调用翻译前必须注册。扩展可以通过自己的消息协议调用上述函数，但必须限制发送者、消息类型和文本大小；不要把翻译权限暴露为任意网页都能调用的通道，不配置宽泛 `externally_connectable`。译文作为普通文本渲染，不能直接赋给 `innerHTML`。私钥不可导出能减少意外泄露，无法阻止已控制扩展上下文的代码代签。

注册成功响应若因断网丢失，使用已持久化的同一组密钥再次调用 `register()`，服务端会返回原 clientId，不重复创建身份。已撤销设备无法恢复。SDK 不自动重试翻译，以免重复计费。密钥清除或浏览器数据丢失后会注册为新设备，部署者可撤销旧设备。

## 接口

完整的请求字段、响应结构、状态码及客户端示例见 [API 接口文档](docs/api.md)；加密信封的算法与构造过程见 [协议文档](docs/protocol.md)。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 数据库健康状态 |
| `GET /v1/keys` | 协议版本、keyId、服务器签名/加密公钥 |
| `POST /v1/clients/register` | 设备公钥与私钥持有证明 |
| `POST /v1/translate` | 批量翻译 |
| `POST /v1/usage` | 当前设备当天字符用量 |

所有 POST 的 HTTP 请求体均为 `{ "envelope": "<compact JWE>" }`。不能直接把原文 JSON POST 到接口。客户端 SDK 封装了完整协议，详见 [协议文档](docs/protocol.md)。

翻译的加密前业务数据：

```json
{
  "texts": ["Hello", "Good morning"],
  "sourceLanguage": "auto",
  "targetLanguage": "zh-CN"
}
```

每次 1–20 段，合计不超过 5000 个 JavaScript 字符单元（UTF-16），拒绝纯空白。语言参数使用 `en`、`ja`、`zh-CN` 等语言标签；sourceLanguage 默认 auto。返回数组与输入顺序一致。长页面建议按 500–1000 字符拆批；模型输出截断或数量不符会明确失败。

服务器固定模型、系统提示词、上游地址和输出上限，禁止客户端传入 `model`、`messages` 或 API Key。使用 OpenAI 兼容的 `/chat/completions`，非流式 JSON 输出，关闭思考模式。默认配置为硅基流动；也支持 DeepSeek 官方接口，将 `SILICONFLOW_BASE_URL` 设为 `https://api.deepseek.com` 并使用当前有效的 DeepSeek 模型 ID。

## 防滥用与默认限额

非对称加密保护内容，签名证明设备持有私钥；两者都不能证明某个公开扩展没有被逆向。服务依靠独立可撤销设备身份、注册限流和服务端额度共同控制费用。

| 限制 | 默认值 |
| --- | --- |
| 入口每 IP / 分钟 | 120 次，含失败请求和公共接口 |
| 翻译每设备 / 分钟 | 20 次 |
| 翻译每 IP / 分钟 | 60 次 |
| 每设备 / UTC 日 | 20,000 字符 |
| 每 IP / UTC 日 | 100,000 字符 |
| 全站 / UTC 日 | 1,000,000 字符、10,000 次翻译 |
| 每 IP / UTC 日注册尝试 | 10 次，已通过签名验证的注册 |
| 上游并发 | 8 次 |
| 上游超时 | 30 秒 |
| 单次输出 | 4096 tokens |

额度在调用供应商前事务预占，某一维超额则整笔回滚；上游失败也计入额度，因为请求可能已产生费用。分钟采用固定窗口，窗口切换附近可能出现短时双倍突发。日额度、防重放记录跨服务重启保留；入口限流和并发限制在内存中，重启会重置，公网还需反向代理限流。

这些是字符/请求预算，不是精确的人民币账单上限。“免费”指服务面向用户免费，硅基流动的模型费用以控制台为准。可调低全站额度，并设置供应商账户预算。

HTTP 400 为参数错误，401 为签名/密文/时间错误，403 为禁用设备，409 为重放或重复身份，429 为限额，502/503/504 为供应商或服务暂不可用。已完成身份校验的业务错误也加密；入口错误返回普通 JSON。SDK 的 `TranslationError` 提供 `code`、`status`。

## 管理与部署

```sh
npm run admin -- help
npm run admin -- clients
npm run admin -- revoke <clientId>
npm run admin -- cleanup
```

管理操作仅在服务器 CLI 进行，没有公开管理 API。数据库只保存公钥、加盐 IP 的额度索引、输入长度和 token 统计，不保存翻译原文/译文；业务日志不输出请求正文、密钥、原文或 IP。原文会发给硅基流动完成翻译，应在扩展隐私说明中告知。

公网部署必须放在 HTTPS 反向代理之后；外层 TLS 负责初次获取服务器公钥的可信性，加密信封不能替代 HTTPS。配置 `ALLOWED_ORIGINS` 为实际 Chrome 扩展来源。Origin 可被非浏览器客户端伪造，只是附加限制。默认不信任代理头；仅当部署了可信代理时设置 `TRUST_PROXY` 为明确的 IP/CIDR，并确保外网不能绕过代理。不要用 `*` 或 `true`。

Docker Compose（需要先创建 `.env` 并生成 `secrets/server-keys.json`）：

```sh
# Linux 上容器使用 uid 1000，私钥文件必须可被该用户读取：
sudo chown -R 1000:1000 secrets
sudo chmod 700 secrets
sudo chmod 600 secrets/server-keys.json
docker compose up --build -d
docker compose run --rm migrate node dist/scripts/admin.js clients
```

Compose 先迁移命名卷数据库，再启动应用，只发布 `127.0.0.1:3000`。密钥只读挂载，镜像不包含 `.env`、密钥或本地数据库。当前开发环境没有 Docker，Docker 配置需在部署主机实际构建验证。

备份时保留数据库与服务器密钥；丢失服务器密钥会改变服务身份。当前只加载一组服务器密钥，轮换需协调扩展固定指纹更新和正在执行的请求。扩展不持有硅基流动 API Key，也不共享客户端私钥。

## 验证

```sh
npm test
npm run typecheck
npm run build
npm run smoke
npx --yes npm@11 audit
```

测试使用临时真实 SQLite、真实 RSA/ECDSA 加解密和本地供应商响应，覆盖注册、重放/并发重放、撤销、额度竞争、响应错配和供应商错误。浏览器 SDK 使用纯 Web Crypto/JOSE，并构建为 Chrome 120+ ESM 模块。Prisma CLI 的间接依赖通过 package.json overrides 使用修复版，锁文件保留可重现依赖。
