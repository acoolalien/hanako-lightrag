# Hanako LightRAG Plugin

基于 [LightRAG](https://github.com/HKUDS/LightRAG) 的 Hanako 知识图谱 RAG 插件。

支持文档索引、语义检索、知识图谱可视化和多模式查询。

## 前置条件

- Python 3.10+
- Hanako 中已配置 LLM Provider 和 Embedding Provider

## 配置流程

1. **安装 Python 依赖**：`pip install -r py/requirements.txt`
2. **安装插件**：将插件文件夹拖入 Hanako 设置 → 插件
3. **配置 Provider**：确保 Hanako 中已配好 LLM 和 Embedding Provider
4. **填入 Provider ID**：在插件设置中填入 `llmProviderId` 和 `embeddingProviderId`
5. **（可选）启用 Reranker**：配置 `rerankProviderId` 并开启 `rerankEnabled`
6. **开始使用**：Agent 自动获得 `lightrag_insert` 等 6 个工具

> 首次索引前建议先创建独立知识库（通过 `lightrag_ws_create` 或图谱页下拉菜单），避免与默认知识库混用。

## Provider 配置

插件**不内置任何 API Key**，全部复用 Hanako 的 Provider 系统。

1. 打开 Hanako 设置 → Providers
2. 确保已配置以下两类 Provider：
   - **LLM Provider**：用于实体提取和查询生成（推荐 32B+ 参数模型）
   - **Embedding Provider**：用于向量嵌入

## 使用

安装并配置后，Agent 自动获得以下工具：

| 工具 | 说明 |
|------|------|
| `lightrag_query` | 查询知识库（6 种模式，支持跨库） |
| `lightrag_insert` | 索引文档（支持批量） |
| `lightrag_status` | 查看已索引文档和服务健康状态 |
| `lightrag_ws_list` | 列出所有知识库 |
| `lightrag_ws_create` | 创建新知识库 |
| `lightrag_ws_delete` | 删除知识库（需确认） |

图谱可视化在顶部 Tab 栏的「图谱」中。

## 配置项

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `llmProviderId` | `deepseek` | LLM Provider ID |
| `embeddingProviderId` | `siliconflow` | Embedding Provider ID |
| `embedModel` | `Qwen/Qwen3-Embedding-8B` | 嵌入模型名称 |
| `embedDim` | `4096` | 嵌入向量维度 |
| `rerankEnabled` | `false` | 是否启用 Reranker 重排 |
| `rerankProviderId` | （空） | Reranker Provider ID，留空不启用 |
| `lightragPort` | `9621` | LightRAG 服务端口 |
| `workingDir` | 插件数据目录 | 索引存储路径 |
| `defaultQueryMode` | `mix` | 默认查询模式：local/global/hybrid/mix/naive/bypass |
| `entityTypes` | 10 类 | 实体提取类型列表 |
| `summaryLanguage` | `Chinese` | 摘要语言 |
| `maxGleaning` | `0` | 实体提取额外循环次数，0=跳过 |
| `chunkSize` | `1200` | 分块大小（tokens） |
| `chunkOverlapSize` | `100` | 分块重叠（tokens） |
| `storageBackend` | `json` | 存储后端：`json` 或 `postgres` |
| `pgHost` | `localhost` | PostgreSQL 主机（PG 后端时生效） |
| `pgPort` | `5432` | PostgreSQL 端口 |
| `pgDatabase` | `lightrag` | PostgreSQL 数据库名 |
| `pgUser` | `postgres` | PostgreSQL 用户名 |
| `pgPassword` | （空） | PostgreSQL 密码 |
| `workspaces` | `{"default":"默认知识库"}` | 知识库列表 `{key: 显示名}` |

> PostgreSQL 相关配置项（`pgHost`/`pgPort`/`pgDatabase`/`pgUser`/`pgPassword`）仅在 `storageBackend=postgres` 时生效。

## 存储后端

LightRAG 支持多种存储后端，当前默认使用 JSON 文件（零依赖，零配置）。

### 存储效率对比（百万字项目预估）

| 后端 | KV | 向量 | 图 | 存储大小 | 运行时 RAM | 安装负担 |
|------|:--:|:--:|:--:|---------|-----------|---------|
| **JSON（默认）** | ✅ | nano-vectordb | NetworkX | ~500 MB | 零额外 | 零 |
| **PostgreSQL + pgvector** | ✅ | pgvector | NetworkX | ~50 MB | ~50 MB | PG 安装包 ~200MB |
| Neo4j + Milvus | — | ✅ | ✅ | ~30 MB | ~1.5 GB | 两个服务 + Java |
| OpenSearch | ✅ | ✅ | ✅ | ~80 MB | ~1.5-2 GB | Java 运行时 + 配置 |

### 升级到 PostgreSQL + pgvector

**安装**（Windows）：
1. [下载 PostgreSQL](https://www.postgresql.org/download/windows/) 安装包
2. 安装 pgvector 扩展：下载预编译 DLL 放到 `share/extension/` 和 `lib/`，执行 `CREATE EXTENSION vector;`
3. 创建数据库：`CREATE DATABASE lightrag;`

**配置**（在插件配置中将 `storageBackend` 改为 `postgres`，并填入 PG 连接信息）。切换后端需重新索引文档。

## 架构

```
Hanako Plugin (JS)
  ├── index.js            → 生命周期：onload spawn Python sidecar
  ├── tools/_client.js    → HTTP 公共客户端（端口缓存、错误处理）
  ├── tools/lightrag_*.js → Agent 工具（6 个）
  └── routes/ui.js        → 知识图谱 Cytoscape.js 页面

Python Engine
  └── py/server_manager.py → FastAPI + LightRAG 实例（LLM/Embed/Rerank 适配器）
```

## 致谢

本插件基于 [LightRAG](https://github.com/HKUDS/LightRAG) 构建。

LightRAG: Simple and Fast Retrieval-Augmented Generation  
Copyright (c) 2025 LightRAG Team, MIT License

## License

MIT
