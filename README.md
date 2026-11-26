# Cloudflare AI 网关

独立的 Cloudflare Worker 仓库，供多个应用共用。网关负责鉴权、模型转发和用量统计。应用在调用时提供自己的业务数据、提示词和生成参数。登录后可创建和吊销 API Key，并按密钥查看推理请求数、成功次数和模型返回的输入、输出 Token。新密钥仅在创建时显示，D1 保存 SHA-256 摘要和用量。

## 从 GitHub 在 Cloudflare 控制台部署

1. 在 Cloudflare 的 **Workers & Pages** 里连接 GitHub 上的独立网关仓库。新建 Worker 选择 **Create application → GitHub**。已有 Worker 从 **Settings → Builds → Connect** 接入。
2. 在 **Build configuration** 填写下表中的项目参数。Worker 名称须与仓库的 `wrangler.json` 中的 `name` 一致。
3. 通过 **My Profile → API Tokens** 为此构建选用的用户令牌添加目标账户的 **D1 → Edit** 权限，同时保留 Worker 发布权限。也可以在 Build 中选择一个已具备这些权限的令牌。
4. 在 Worker 的 **Settings → Variables and Secrets** 添加类型为 **Secret** 的 `ADMIN_PASSWORD`，填管理员原密码并保存部署。运行时 Secret 由控制台保存。仓库的 `.dev.vars*` 和 `.env*` 已加入忽略规则。
5. 等待 **Builds** 显示成功，然后打开该 Worker 域名的根路径 `/`。输入 `ADMIN_PASSWORD` 对应的密码即可登录。

| 设置项 | 值 |
|---|---|
| Worker name | `generic-ai-gateway` |
| Production branch | `master`。如改用其他分支，将 Build 变量 `D1_MIGRATION_BRANCH` 设为同一分支名。 |
| Root directory | 留空或 `/`（独立网关仓库根目录） |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |

生产构建依次运行测试、查找或首次创建 D1、通过 `DB` 应用尚未执行的远端迁移。只有构建成功才发布 Worker，发布时绑定本次迁移的数据库。预览分支和本地构建只跑测试。`wrangler.json` 已声明 Workers AI 的 `AI` 绑定。使用 Workers Free 账号可以让 Cloudflare 在免费额度耗尽后停止推理。 [Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) · [D1 迁移命令](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply)

升级既有网关时，使用原来的 Worker 名称和 D1 绑定。构建会复用名为 `generic-ai-gateway` 的 D1。如果当前网关绑定了其他名称的 D1，在 `wrangler.json` 的 `DB` 条目填写原有的 `database_id` 和 `database_name`，以便继续使用已有的 API Key 和统计数据。

如果构建日志提示 Wrangler 缺少凭据，在 **Settings → Builds → Build variables and secrets** 添加 `CLOUDFLARE_API_TOKEN`（Secret，须有目标账户的 D1 Edit 权限）和 `CLOUDFLARE_ACCOUNT_ID`（账户 ID）。

## 页面显示 Hello World

在目标 Worker 的 **Builds** 查看最新生产构建。确认它来自网关仓库、状态为成功，再打开该 Worker 在 **Overview** 中显示的域名。Worker 名称不一致时，Cloudflare 会在构建日志里显示错误。成功发布后，缺少 `ADMIN_PASSWORD` 时首页会提示设置 Secret。 [Workers Builds 排查](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/) · [控制台设置 Secret](https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard)

## D1 已绑定但无法登录

在 **Settings → Builds → Build configuration** 将 **Build command** 改为 `npm run build`。`npx wrangle build` 或 `npx wrangler build` 都会跳过本仓库的迁移脚本。保存后重试生产构建，并在 **Builds** 的日志中确认出现 `D1 migrations complete for DB.`。改动前已经发布的版本需要重新构建，才能生成登录所需的数据表。 [Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

如果迁移已成功但仍无法登录，核对构建日志中的 D1 ID 是否等于线上 Worker 的 `DB` 绑定 ID。其他运行错误可在 **Logs → Live logs** 中查看，打开日志后再提交一次登录。 [Worker 实时日志](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)

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
