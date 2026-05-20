# ADR-001: workspace 配置散落等待统一

**日期**: 2026-05-19  
**状态**: superseded（2026-05-19）

## 原始背景

workspace 概念散落在 4 处：
- `manifest.json` — schema 声明
- `config.json` — 运行时值
- `server_manager.py` — workspace→存储目录映射
- `routes/ui.js` — 读取 workspace 列表渲染下拉框

## 原始决策

暂不重构，等待 workspace CRUD 管理工具加入后统一。

## 收敛结果（2026-05-19）

CRUD 工具 `lightrag_ws_list/create/delete` 已实现，收敛为：

| 位置 | 职责 | 变更方式 |
|------|------|---------|
| `tools/lightrag_ws_*.js` | **唯一写入入口** — 创建/删除时同步更新 config.json | CRUD 操作 |
| `server_manager.py` | 文件系统操作 — 扫描/创建/删除目录 | 被工具调用 |
| `routes/ui.js` | 只读渲染 — 从 config.json 读取显示名 | 页面加载时 |
| `manifest.json` | schema 声明 — workspace 对象结构 | 不变 |
| `config.json` | 运行时值 — 由工具自动维护 | 工具写入 |

收敛前 4 处各自读写 workspace → 收敛后只有工具层写入，其他层只读。
