# Cloudflare AI 网关

独立的 Cloudflare Worker 仓库，供多个应用共用。网关负责鉴权、模型转发和用量统计。应用在调用时提供自己的业务数据、提示词和生成参数。登录后可创建和吊销 API Key，并按密钥查看推理请求数、成功次数和模型返回的输入、输出 Token。新密钥仅在创建时显示，D1 保存 SHA-256 摘要和用量。

## 部署到 Cloudflare Workers Free

1. 使用 Node.js 22.13 或以上，在本目录运行 `npm install`。
2. 运行 `npx wrangler login` 登录 Cloudflare，选择使用 Workers Free 的账号。
3. 运行 `npm run deploy`。Wrangler 将发布 Worker，并创建 `generic-ai-gateway` D1 数据库和 `DB` 绑定。`wrangler.toml` 已配置 Workers AI 的 `AI` 绑定。
4. 运行 `npx wrangler d1 migrations apply DB --remote` 初始化数据库。
5. 运行 `npx wrangler secret put ADMIN_PASSWORD`，按提示输入管理员原密码。也可以在 Cloudflare 控制台的 Worker 设置中添加类型为 Secret 的 `ADMIN_PASSWORD`。

打开部署域名，手动输入用户名 `admin` 和刚设置的密码。登录使用 MD5 和一次性校验流程。仓库的 `.dev.vars*` 和 `.env*` 均被忽略，Cloudflare 只通过 Secret 注入生产密码。

升级已发布的旧版网关时，部署配置应使用原有 Worker 名称和 D1 数据库绑定，以沿用原有域名、密钥和用量记录。新项目的默认名称为 `generic-ai-gateway`。

## 接口

请求头使用 `Authorization: Bearer <创建的 API Key>`。任意兼容客户端均可使用 `https://你的-Worker-域名/v1` 作为 Base URL。

| 方法 | 路径 | 功能 |
|---|---|---|
| `GET` | `/v1/models` | 返回此网关开放的 Workers Free 文本模型 |
| `POST` | `/v1/chat/completions` | 兼容 OpenAI 格式的非流式文本推理 |

文本请求使用 `model`、`messages`，可选 `temperature` 和 `max_tokens`（或 `max_completion_tokens`），输出限制为最多 800 Token。

查询可用模型的例子，`AI_BASE_URL` 为以 `/v1` 结尾的地址。

```sh
curl -fsS "$AI_BASE_URL/models" -H "Authorization: Bearer $AI_GATEWAY_KEY"
```

可用模型为 `@cf/google/gemma-4-26b-a4b-it` 和 `@cf/zai-org/glm-4.7-flash`。Worker 只接受上述模型，并直接使用 `env.AI`。Workers Free 的每日免费额度为 10,000 Neurons，按账号共享，UTC 00:00 重置。收费规则取决于 Cloudflare 账号的计划，启用 Workers Paid 时超出免费额度的部分可能计费。网关计数器统计请求和模型返回的 Token，Neuron 用量可在 Cloudflare 控制台查看。 [Cloudflare 免费额度与价格](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [Workers Free 模型公告](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/)

## 本地测试

`npm test` 使用内存 SQLite 跑数据库迁移，模拟 Workers AI 响应，验证登录、API Key、用量累加和吊销。本地需要浏览管理页时，先运行 `npx wrangler d1 migrations apply DB --local`，再创建 `gitignore` 已排除的 `.dev.vars` 并填写 `ADMIN_PASSWORD`，最后运行 `npm run dev`。
