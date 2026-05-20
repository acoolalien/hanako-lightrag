# CONTEXT.md — hanako-lightrag 共享术语表

## 项目定位

基于 LightRAG 的 Hanako 通用知识库引擎。Agent 可索引文档、用知识图谱检索、管理多知识库、可视化浏览图谱。不绑定特定领域。

## 术语表

| 术语 | 定义 |
|------|------|
| **知识库 (Knowledge Base)** | 一组已索引文档的集合，拥有独立的知识图谱、向量库、文档状态。通过 workspace 名称区分。 |
| **workspace** | LightRAG 原生概念。同个 working_dir 下不同 workspace 的数据完全隔离。本插件中 workspace 名直接作为存储子目录名，支持中文。 |
| **default** | 系统保留的默认知识库名。用户不可以重命名 default，但可以新增其他命名知识库。 |
| **跨库查询** | 对多个 workspace 并发执行查询，Agent 层合并结果。LightRAG 原生不支持，通过并发调用变相实现。 |
| **Provider** | Hanako 中已配置的 LLM/Embedding 服务（如 deepseek、siliconflow）。插件通过 `bus.request("provider:credentials")` 获取凭据，不内置 API Key。 |

## 功能边界

**该做：** 索引文档+构建知识图谱、多知识库隔离、跨库并发查询、6 种检索模式、知识图谱可视化、复用 Hanako Provider

**不该做：** 管理文档源文件、知识库间数据同步/合并、替换 Agent LLM 推理、复杂文档编辑器、内置 API Key

## 成功标准

1. 新建知识库成功
2. 索引文件成功
3. 单库或跨库查询结果准确
4. 知识图谱可视化显示正确

## 设计约束

- 不动 LightRAG 源码，通过公开接口封装
- 全权插件 (full-access)，需要 provider:credentials bus
- Python 3.10+ 依赖，spawn 子进程模式
- MIT 协议，致谢 LightRAG (HKUDS)
