# 模型行为指纹检测 · Model Trace

> 在线体验：[https://cians.github.io/llm-behavior-fingerprint/](https://cians.github.io/llm-behavior-fingerprint/)

**不需要后端，也不需要把 Key 交给本站。** 在同一道看似随机的选择题上进行多次、无上下文的独立采样，模型对答案的微弱偏好会沉淀成可比较的概率分布——这就是它的行为指纹。

这是 `static-direct` 分支：一个可直接部署到 GitHub Pages 的纯静态大模型行为指纹实验室。它支持 OpenAI Chat Completions 和 Anthropic Messages 协议，可生成单个模型指纹、比较两个端点，或与本地历史指纹进行比较。

## 为什么可以放心多人同时使用

**计算、并发和模型请求都由每位访问者自己的浏览器完成；GitHub Pages 只分发静态文件。** 因此多人同时实验不会消耗本项目的后台机器，也不会让 Key、模型输出或历史结果流经本站。

```text
GitHub Pages
  └─ 仅提供 HTML / CSS / JavaScript

每位用户的浏览器
  ├─ 独立发起非流式模型请求
  ├─ 本地控制并发、超时与重试
  ├─ 本地计算概率分布与指纹距离
  └─ 本地保存历史记录
       └─ 直接 POST → 用户填写的模型 API
```

- **Key 不经过本站**：仅由当前浏览器直接发送到你填写的模型 API，不写入 LocalStorage、历史或导出文件；
- **无共享实验队列**：每个用户使用自己的网络和设备性能；真正可能承压的是所调用的模型 API / 网关；
- **历史不共享**：结果默认只存于当前浏览器，可按需导出 JSON 并手动导入到另一台设备；
- **每次样本相互独立**：每一次都是新的非流式 HTTP 请求，不带历史消息、会话 ID 或 cookie。

## 它能做什么

- 用多个内置随机选择探针，或自定义一个可归一化答案的随机 Prompt；
- 对同一模型重复独立采样，形成数字、颜色、字母、动物等多维经验分布；
- 用 Jensen–Shannon Distance 比较两个端点或两条历史指纹；
- 支持 429 容错、可调并发、120 秒单请求超时、历史导入 / 导出；
- 在不暴露测试目的的统一 System Prompt 下，禁止模型调用工具、函数、代码执行、浏览器或外部资源。

> 行为指纹是统计线索，而不是模型身份的绝对证明。模型更新、供应商路由、系统提示、采样参数和时间窗口都会影响结果。

## 纯静态直连模式

本分支不运行 API 代理，且不需要 Node 后端：

```text
浏览器（GitHub Pages / 本地静态服务）
  └─ 直接 POST → 你填写的模型 API
```

- 不存在 `/api/run` 或 `/api/models`；
- API Key 不上传至本站、GitHub 或项目作者的服务器；它仅由当前浏览器发送给你填写的模型 API；
- 每个样本都是独立的 `fetch`，`stream: false`，浏览器内受控并发；
- 单次模型请求超时为 120 秒，模型列表读取为 20 秒；
- 历史、导入、导出和指纹对比均保存在当前浏览器中，不会与其他用户共享。

## 必要条件：模型 API 必须支持 CORS

“非流式”不会自动绕过浏览器 CORS。模型端点需要允许部署页面的来源，并允许认证请求头和预检请求。

例如 GitHub Pages 为 `https://cians.github.io` 时，API 网关至少应允许：

```http
Access-Control-Allow-Origin: https://cians.github.io
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: authorization, content-type, anthropic-version, x-api-key
```

若页面提示“浏览器无法直连模型端点”，优先检查：

1. 端点是否从浏览器网络面板返回了 CORS / `OPTIONS` 错误；
2. 是否允许了 GitHub Pages 实际来源（包含协议和域名）；
3. 是否允许 `Authorization` 或 `x-api-key`、`anthropic-version` 请求头；
4. 是否使用了支持 CORS 的自建或供应商网关。

OpenAI、Anthropic、OpenRouter 等公共端点是否允许浏览器直连，取决于其当前 CORS 策略和你的网关配置；不支持时请使用主分支的本地代理版，而不是在页面中尝试运行 `curl`。

## 本地静态启动

不需要安装 npm 依赖。推荐通过静态 Web 服务打开，避免 `file://` 方案的浏览器模块限制。若有 Python 3，无需 Node：

```bash
git clone --branch static-direct https://github.com/cians/llm-behavior-fingerprint.git
cd llm-behavior-fingerprint
python3 -m http.server 4173 --directory public
```

打开 <http://127.0.0.1:4173>。

若已有 npm，也可使用 `npm run serve:static`。任何静态托管服务均可直接发布 `public/` 目录；GitHub Pages 为 HTTPS 页面，因此模型 URL 也必须是 HTTPS，避免浏览器拦截混合内容。

## GitHub Pages

本分支附带 [pages.yml](.github/workflows/pages.yml)，推送到 `static-direct` 后会发布 `public/` 目录。

首次启用时，在 GitHub 仓库的 **Settings → Pages → Build and deployment** 中选择 **GitHub Actions**。工作流完成后，页面位于：[https://cians.github.io/llm-behavior-fingerprint/](https://cians.github.io/llm-behavior-fingerprint/)。

页面使用相对资源路径，因此也可部署到项目页子路径。

## 使用方式

1. 选择 OpenAI Chat Completions 或 Anthropic Messages 协议。
2. 填写模型 URL、API Key（可为空，若端点不要求）和模型 ID。
3. 可点击“读取”请求 `/models`；它也要求 CORS。
4. 选择采样规格、并发数与内置 / 自定义探针。
5. 选择生成指纹、双端对比或与本地历史结果对比。

协议请求形式：

| 协议 | URL 识别 | 实际请求 | 认证 |
|---|---|---|---|
| OpenAI | Base URL、`/v1`、`/chat/completions` | `POST /v1/chat/completions` | `Authorization: Bearer …` |
| Anthropic | Base URL、`/v1`、`/v1/messages` | `POST /v1/messages` | `x-api-key: …` + `anthropic-version` |

每个探针样本都会附带统一 System Prompt：直接回答当前问题，禁止调用或尝试调用工具、函数、代码执行、网页浏览或外部资源。该指令不会透露测试或指纹目的。

## Key 与数据安全

- Key 不写入 LocalStorage、历史记录、导出 JSON 或项目文件；
- 历史仅保留去除 URL 查询参数后的端点地址、模型 ID、探针定义和统计结果；
- GitHub Pages 是公开静态托管，使用前应审阅代码并只使用可撤销、有限额的测试 Key；
- 不要把 `.env`、Key、终端历史或带凭据的截图提交到 GitHub。

## 采样与对比

- 每个样本是一个全新的独立 HTTP `POST`；没有历史消息、会话 ID、固定 seed 或 cookie；
- 不发送 `temperature`，使用供应商或模型默认采样设置；
- 输出预算为 `max_tokens: 256`；
- 每端点默认 4 路并发，可调 1–10；高并发更快，也更容易触发限流；
- 单次 429 会记录为无效样本后继续；连续限流或连续错误达到阈值才停止；
- 只使用最终可见文本，不统计 reasoning 内容；
- 每个共同探针维度比较完整经验分布，使用 Jensen–Shannon Distance：

\[
D_{JS}(P,Q)=\sqrt{\tfrac12 KL(P\Vert M)+\tfrac12 KL(Q\Vert M)},\quad M=\tfrac12(P+Q)
\]

总体距离是共同可比维度距离的平均；页面相似度为 `1 − distance`。采样置信度是由共同维度覆盖率、有效样本数和有效解析率构成的启发式质量指标，并非 p-value 或“同一模型的概率”。

## 测试

```bash
npm test
```

## References

1. Tomas Bruckner. [One Token Is Enough: Fingerprinting and Verifying Large Language Models from Single-Token Output Distributions](https://arxiv.org/abs/2607.10252). arXiv:2607.10252, 2026.
2. 数字生命卡兹克. [AI说不出的随机数，成了鉴别套壳大模型最好的照妖镜。](https://mp.weixin.qq.com/s/pqFZreEZj8kB4KDirl4MSQ) 微信公众号，2026-07-21.

## License

[MIT](LICENSE)
