# LLM Behavior Fingerprint

一个本地优先的大模型行为指纹工具。它会通过 OpenAI Chat Completions 或 Anthropic Messages 协议，向模型端点重复发送一组普通的随机选择问题，统计回答的概率分布，并使用 Jensen–Shannon 距离比较两个模型端点是否表现出相似的行为偏好。

它可以用于：

- 为一个模型 API 生成行为指纹；
- 同时采样两个端点并对比；
- 把新结果与浏览器中的历史基线对比；
- 创建一个带候选答案的自定义随机 Prompt；
- 导出不含 API Key 的 JSON 结果。

> 行为指纹是统计证据，不是模型身份的绝对证明。模型更新、供应商路由、采样参数和系统提示都可能改变结果。

## 本地启动

需要 Node.js 18 或更高版本。项目没有第三方运行时依赖，不需要执行 `npm install`。

```bash
git clone https://github.com/cians/llm-behavior-fingerprint.git
cd llm-behavior-fingerprint
npm start
```

浏览器打开：

```text
http://127.0.0.1:4173
```

页面、样式和脚本都是本地静态资源；Node.js 只提供静态文件服务和一个本机 API 转发层，用于避开浏览器 CORS 限制。

## 如何使用

### 1. 填写模型端点

- **接口协议**：每个端点独立选择 OpenAI Chat Completions 或 Anthropic Messages；双端实验可以跨协议比较。
- **模型 URL**：支持 API Base URL、以 `/v1` 结尾的 URL，或对应协议的完整接口 URL。
- **API Key**：该端点使用的凭据。
- **模型 ID**：例如 `moonshotai/kimi-k3`。如果端点支持 `/models`，可以点击“读取”。
- **端点标签**：只用于标记本地结果。

| 协议 | 自动识别的输入 | 实际请求 | Key 认证 |
|---|---|---|---|
| OpenAI | Base URL、`/v1`、`/chat/completions` | `POST /v1/chat/completions` | `Authorization: Bearer …` |
| Anthropic | Base URL、`/v1`、`/v1/messages` | `POST /v1/messages` | `x-api-key: …` + `anthropic-version` |

例如 OpenRouter：

```text
URL: https://openrouter.ai/api/v1
Model: moonshotai/kimi-k3
```

例如 Anthropic：

```text
Protocol: Anthropic Messages
URL: https://api.anthropic.com
Model: claude-sonnet-4-5
```

Anthropic Messages 协议要求填写模型 ID。两种协议都尝试通过 `GET /v1/models` 读取模型列表；若供应商未实现模型列表接口，可以直接手动输入。

### 2. 选择实验模式

- **生成指纹**：只采样一个端点。
- **双端对比**：使用相同题面和采样次数依次测试两个端点。
- **历史对比**：选择一条本地历史结果，页面会恢复相同的探针、采样次数和自定义题面。

### 3. 选择采样规格

| 规格 | 采样量 | 用途 |
|---|---:|---|
| 快速扫描 | 4 维 × 10 次 | 初步观察概率分布 |
| 标准指纹 | 8 维 × 20 次 | 日常对比，推荐 |
| 深度采样 | 9 个固定维度 × 30 次 | 更稳定的统计结果 |
| 自定义 | 每维 10–100 次 | 自行控制成本和稳定性 |

样本越多，分布越稳定，但 API 调用费用也越高。

### 4. 创建自定义随机 Prompt

打开“自定义随机 Prompt”，填写：

1. 探针名称；
2. 一条普通用户 Prompt；
3. 至少三个候选答案，每行一个。

示例：

```text
名称：随机饮品

Prompt：
Choose one drink from this list: tea, coffee, water.
Return only one listed word.

候选答案：
tea
coffee
water
```

候选答案很重要：工具需要把模型自由文本归一为有限类别，才能得到可比较的概率分布。自定义探针的 ID 由 Prompt 和候选答案共同生成，只有定义完全相同的自定义测试才会作为同一维度比较。

## API Key 安全说明

本项目被设计为在你的电脑上运行：

- Web 服务默认只监听 `127.0.0.1`，不会暴露到局域网；
- 没有分析 SDK、遥测服务或第三方前端资源；
- API Key 不写入 LocalStorage、历史记录、导出结果、文件或服务日志；
- 浏览器只把 Key 发送给本机 `127.0.0.1` 服务；
- 本机服务只把 Key 发送到你在页面中填写的模型 URL：OpenAI 协议使用 `Authorization: Bearer`，Anthropic 协议使用 `x-api-key`；
- 历史记录仅保存去掉查询参数的端点 URL、模型 ID、探针定义和统计结果。

因此，Key **不会上传给本项目作者、GitHub 或任何分析服务**。为了真正调用模型，它仍然必须被发送到你所填写的 API 供应商——例如填写 OpenRouter URL 时，Key 会发送给 OpenRouter。

安全建议：

- 请从你审阅过的源码在本地运行，不要在陌生人部署的在线版本中填写 Key；
- 不要把 `.env`、Key、终端历史或带凭据的截图提交到 GitHub；
- 对高价值账号使用限额 Key 或专门用于测试的 Key。

## 采样协议

- 请求只包含一条普通 `user` 消息，不附加会透露测试性质的 system prompt；
- **每一个样本都是一次全新的、独立的 HTTP POST**：OpenAI 使用 `/chat/completions`，Anthropic 使用 `/v1/messages`；
- 不携带之前的 user/assistant 消息，不发送 conversation ID、previous response ID、固定 seed 或 cookie；
- HTTP 客户端可能复用底层 TCP keep-alive 连接，但不会复用任何逻辑对话上下文；
- 默认使用 `temperature: 1`；
- 调用顺序会随机打乱，但同一批次的题面保持不变；
- 输出预算为 256 tokens；Anthropic 的 `max_tokens` 是必填字段，协议降级时也会保留；
- 统计只读取最终可见回答，不使用模型的 reasoning 内容；
- 指纹 Hash 编码各维度的完整概率分布；
- 对比使用 Jensen–Shannon 距离，并结合共同维度、样本量和有效率显示采样置信度。

## 数据存储

历史结果保存在当前浏览器的 LocalStorage。你可以：

- 在“历史指纹库”查看或删除结果；
- 直接把历史结果作为下一次实验的基线；
- 导出 JSON；
- 使用“清空历史”删除全部本地记录。

API Key 不属于历史数据。

## 开发与测试

```bash
npm test
```

项目结构：

```text
public/          静态页面、样式、交互和指纹计算
server.mjs      本地静态服务器与 API 转发层
test/           Node.js 单元测试
```

## 方法局限

- 低样本量只能形成粗略分布；正式基线建议至少每维 20–30 次。
- 同一模型在不同时间、区域、量化方式或服务商下可能出现差异。
- 相似分布可能表示同一模型、同一家族、共享训练来源或路由策略，不能单独证明供应商存在欺诈。
- 自定义 Prompt 的候选答案若重叠或模型不遵循格式，会降低有效解析率。

## References

1. Tomas Bruckner. [One Token Is Enough: Fingerprinting and Verifying Large Language Models from Single-Token Output Distributions](https://arxiv.org/abs/2607.10252). arXiv:2607.10252, 2026.
2. 数字生命卡兹克. [AI说不出的随机数，成了鉴别套壳大模型最好的照妖镜。](https://mp.weixin.qq.com/s/pqFZreEZj8kB4KDirl4MSQ) 微信公众号，2026-07-21.

## License

[MIT](LICENSE)
