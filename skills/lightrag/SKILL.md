---
name: lightrag
description: >
  LightRAG 知识图谱 RAG 引擎使用指南。当用户需要索引文档、查询知识库、或进行跨文档关系推理时使用。
  MANDATORY TRIGGERS: 索引文档, 建立索引, 查知识库, 知识图谱, 检索, LightRAG, lightrag, 知识库查询
---

# LightRAG 知识库

本 Skill 编排插件工具：

| 工具 | 用途 |
|------|------|
| `lightrag_query` | 查询知识库，6 种模式 + 跨库（workspace 逗号分隔） |
| `lightrag_insert` | 索引文档（批量，自动去重） |
| `lightrag_status` | 查看已索引文档和服务健康状态 |
| `lightrag_ws_list` | 列出所有知识库 |
| `lightrag_ws_create` | 创建新知识库 |
| `lightrag_ws_delete` | 删除知识库（需 `confirm: true`） |

## 多知识库

每个知识库有独立的索引和知识图谱。默认有一个 `default` 知识库。

- `workspace` 参数：所有工具都支持 `workspace` 参数指定目标知识库
- 查看所有知识库：使用 `lightrag_ws_list`
- 创建新知识库：使用 `lightrag_ws_create`，会自动更新配置
- 删除知识库：使用 `lightrag_ws_delete`（不可恢复，需确认）
- 切换知识库：图谱页顶栏下拉框切换，或工具调用时指定

## 查询模式选择指南

| 用户意图 | 推荐 mode | 说明 |
|----------|----------|------|
| 查具体事实/设定/定义 | `local` | 实体聚焦 |
| 跨文档推理/关系追踪 | `global` | 关系聚焦，知识图谱社区摘要 |
| 综合查询 | `mix` | 图谱 + 向量 + Rerank |
| 简单关键词搜索 | `naive` | 纯向量检索 |
| 只要事实不要总结 | `only_need_context: true` | 返回原文片段，Agent 自己推理 |

## 索引指南

1. **首次使用**：先 `lightrag_insert` 批量索引相关文档
2. **增量更新**：文件修改后再次 insert，LightRAG 自动去重
3. **批量索引**：`text` 参数支持长文本，多个文件多次调用
4. **追踪进度**：每次 insert 返回 `track_id`，用 `lightrag_status` 查看

## 上下文预算规则

1. 查询默认 `topK: 5`，最大 50
2. 返回结果超过 8000 字符会被截断
3. 查询噪声大时先用 `only_need_context: true` 看原文再决定
