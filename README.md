# Hanako LightRAG Plugin

基于 [LightRAG](https://github.com/HKUDS/LightRAG) 的 Hanako 知识图谱 RAG 引擎。
支持文档索引、语义检索、知识图谱可视化和多模式查询（local/global/hybrid/mix/naive）。

## 前置条件

- Python 3.10+
- 已安装 Python 依赖：`pip install -r py/requirements.txt`

## 快速开始（最小配置）

### 1. 安装插件

将插件文件夹拖入 Hanako 设置 → 插件。

### 2. 设置环境变量

配置两个系统环境变量（API Key），插件通过环境变量获取密钥，**不依赖 Hanako Provider 系统**：

```powershell
setx LLM_API_KEY "sk-你的LLM_API密钥"
setx EMBED_API_KEY "sk-你的Embedding_API密钥"
```

> 如果启用重排，还需要 `setx RERANK_API_KEY "..."`。

### 3. 配置插件

打开 Hanako 设置 → 插件 → LightRAG 知识库，填入以下配置：

| 配置项 | 你的值 | 说明 |
|--------|--------|------|
| `llmBaseUrl` | LLM API 地址 | 如 `https://api.deepseek.com/v1` |
| `llmModel` | LLM 模型名 | 如 `deepseek-v4-flash` |
| `embedBaseUrl` | Embedding API 地址 | 如 `https://api.siliconflow.cn/v1` |
| `embedModel` | 嵌入模型名 | 如 `Qwen/Qwen3-Embedding-8B` |
| `embedDim` | 嵌入向量维度 | 需匹配模型，如 `4096` |

> 也可直接编辑 `~/.hanako/plugin-data/hanako-lightrag/config.json` 写入上述字段。

### 4. 开始使用

安装配置完成后重启 Hanako，Agent 自动获得以下工具：

| 工具 | 说明 |
|------|------|
| `lightrag_query` | 查询知识库（6 种模式，支持跨库） |
| `lightrag_insert` | 索引文档（自动去重）。支持 `text`（直接传内容）和 `sourceFile`（文件路径，工具层自动读取）二选一 |
| `lightrag_status` | 查看已索引文档和服务健康 |
| `lightrag_ws_list` | 列出所有知识库 |
| `lightrag_ws_create` | 创建新知识库 |
| `lightrag_ws_delete` | 删除知识库（需确认） |
| `lightrag_doc_delete` | 删除单篇文档（需确认） |
| `lightrag_entity_delete` | 删除错误实体 |
| `lightrag_entity_merge` | 合并重复实体 |

## 完整配置项

所有配置项均在插件设置面板中可编辑，也可直接写入 `config.json`。

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `llmBaseUrl` | `https://api.deepseek.com/v1` | LLM API 地址（含路径前缀） |
| `llmModel` | `deepseek-v4-flash` | LLM 模型名 |
| `embedBaseUrl` | `https://api.siliconflow.cn/v1` | Embedding API 地址 |
| `embedModel` | `Qwen/Qwen3-Embedding-8B` | 嵌入模型名 |
| `embedDim` | `4096` | 嵌入向量维度 |
| `rerankEnabled` | `false` | 是否启用 Reranker |
| `rerankBaseUrl` | `""` | Reranker API 地址（启用时必填） |
| `rerankModel` | `""` | Reranker 模型名（启用时必填） |
| `lightragPort` | `9621` | LightRAG 服务端口 |
| `workingDir` | 插件数据目录 | 索引和缓存的存储路径 |
| `defaultQueryMode` | `mix` | 默认查询模式 |
| `entityTypes` | 10 类 | 实体提取类型列表 |
| `summaryLanguage` | `Chinese` | 摘要语言 |
| `maxGleaning` | `0` | 实体提取额外循环次数 |
| `chunkSize` | `1200` | 分块大小（tokens） |
| `chunkOverlapSize` | `100` | 分块重叠（tokens） |
| `storageBackend` | `json` | 存储后端（json/postgres） |
| `workspaces` | `{"default":"默认知识库"}` | 知识库列表 |

## 配置原理

插件配置分两层：

```
系统环境变量            →   API Key（LLM_API_KEY, EMBED_API_KEY, RERANK_API_KEY）
manifest.json +         →   地址、模型名、参数（llmBaseUrl, embedModel, chunkSize ...）
  config.json
```

- **环境变量**：仅传递 API 密钥，不包含地址和模型名
- **manifest.json**：定义配置 schema 和默认值
- **config.json**：存储用户修改过的配置值，覆盖 manifest 默认值

运行时流程：

```
config.json  →  ctx.config.get()  →  合并 manifest 默认值
                                            ↓
                                   _writeResolvedConfig()
                                            ↓
                                   resolved_config.json  →  Python sidecar
                                            
环境变量  →  _buildEnv()  →  透传 process.env  →  Python sidecar
```

Python 端从 `resolved_config.json` 读取地址和模型名，从环境变量读取 API Key，无需额外配置。

## 多模态 Embedding 支持

部分平台（如火山引擎方舟）的 Embedding 模型使用 `/embeddings/multimodal` 接口。
当 `embedModel` 以 `ep-` 开头（火山引擎端点 ID 格式）时，插件自动切换为多模态接口，
无需手动配置。

## 存储后端

当前默认使用 JSON 文件（零依赖，零配置）。PostgreSQL 后端可通过 `storageBackend: postgres`
启用，需自行安装配置 PostgreSQL + pgvector。

## 架构

```
Hanako Plugin (JS)
  ├── index.js            → 生命周期：onload spawn Python sidecar
  ├── tools/_client.js    → HTTP 公共客户端（端口缓存、错误处理）
  ├── tools/lightrag_*.js → Agent 工具（9 个）
  └── routes/ui.js        → 知识图谱 Cytoscape.js 页面

Python Engine
  └── py/server_manager.py → FastAPI + LightRAG 实例（LLM/Embed/Rerank 适配器）
```

## 变更记录

### v0.5.1

- **新增 `sourceFile` 参数**：`lightrag_insert` 工具新增 `sourceFile` 可选参数，传入本地文件绝对路径后由工具层自动读取内容索引，无需 Agent 先读后传。与原有 `text` 参数二选一使用
- **兼容性**：`text` 传参方式完全不变，零 break

### v0.5.0

- **配置重构**：移除对 Hanako Provider 系统的依赖，API Key 改为环境变量传入
- **新增配置项**：`llmBaseUrl`、`embedBaseUrl`、`rerankBaseUrl`、`rerankModel`
- **删除配置项**：`llmProviderId`、`embeddingProviderId`、`rerankProviderId`
- **新增多模态 Embedding 支持**：自动检测 `ep-` 开头的火山引擎端点，切换 `/embeddings/multimodal` 接口
- **配置流简化**：config.json 为唯一配置来源，manifest 仅提供 schema 和默认值
- **删除 ENV_MAP**：移除 JS→Python 的环境变量配置传输层，改为 `resolved_config.json` 直读

## 致谢

本插件基于 [LightRAG](https://github.com/HKUDS/LightRAG) 构建。

LightRAG: Simple and Fast Retrieval-Augmented Generation  
Copyright (c) 2025 LightRAG Team, MIT License

## License

MIT
