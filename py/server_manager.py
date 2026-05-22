#!/usr/bin/env python3
"""hanako-lightrag/py/server_manager.py — LightRAG FastAPI 包装器。

配置来源（无硬编码回退）：
  - resolved_config.json（JS 侧生成的运行时配置文件）
  - 环境变量 LLM_API_KEY / EMBED_API_KEY / RERANK_API_KEY（仅 API 密钥）

"""

import os, sys, json, asyncio, re, argparse
from typing import Optional
from lightrag import QueryParam


# ═══════════════════════════════════════
#  配置类（唯一配置来源）
# ═══════════════════════════════════════

class Config:
    """从 resolved_config.json + 3 个环境变量读取配置。无硬编码回退。"""

    def __init__(self, path: str):
        # ── 环境变量（仅 API 密钥） ──
        self.llm_api_key = os.environ.get("LLM_API_KEY", "")
        self.embed_api_key = os.environ.get("EMBED_API_KEY", "")
        self.rerank_api_key = os.environ.get("RERANK_API_KEY", "")

        if not self.llm_api_key:
            self._fatal("LLM_API_KEY not set")
        if not self.embed_api_key:
            self._fatal("EMBED_API_KEY not set")

        # ── 配置文件 ──
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
        except Exception as e:
            self._fatal(f"failed to load config: {e}")

        def _g(*keys):
            """递归取嵌套 key，找不到则 fatal。"""
            val = d
            for k in keys:
                if not isinstance(val, dict) or k not in val:
                    self._fatal(f"config missing: {' > '.join(keys)}")
                val = val[k]
            return val

        self.port             = _g("port")
        self.working_dir      = _g("working_dir")
        self.llm_base_url     = _g("llm", "base_url")
        self.llm_model        = _g("llm", "model")
        self.embed_base_url   = _g("embedding", "base_url")
        self.embed_model      = _g("embedding", "model")
        self.embed_dim        = _g("embedding", "dim")
        self.embed_max_tokens = _g("embedding", "max_tokens")
        self.chunk_size       = _g("chunk", "size")
        self.chunk_overlap    = _g("chunk", "overlap")
        self.summary_language = _g("summary_language")
        self.max_gleaning     = _g("max_gleaning")
        self.entity_types     = _g("entity_types")
        self.default_query_mode = _g("default_query_mode")
        self.storage_backend  = _g("storage_backend")

        # rerank（可选段）
        rerank = d.get("rerank", {})
        self.rerank_enabled  = rerank.get("enabled", False)
        self.rerank_base_url = rerank.get("base_url", "")
        self.rerank_model    = rerank.get("model", "")

        # postgres（可选段）
        self.postgres = d.get("postgres", {})

    @staticmethod
    def _fatal(msg):
        print(f"[FATAL] {msg}", file=sys.stderr)
        sys.exit(1)


# ── RAG 实例缓存 ──
_rags: dict[str, "LightRAG"] = {}


# ═══════════════════════════════════════
#  环境检查
# ═══════════════════════════════════════

def _check_env():
    """检查 Python 版本和 lightrag 库是否存在。"""
    if sys.version_info < (3, 10):
        print(f"[FATAL] Python 3.10+ required, got {sys.version}", file=sys.stderr); sys.exit(1)
    try:
        import lightrag as lr
    except ImportError:
        print("[FATAL] lightrag-hku not installed", file=sys.stderr); sys.exit(1)
    # 抑制 INFO 噪音
    import logging
    logging.getLogger("lightrag").setLevel(logging.WARNING)
    logging.getLogger("nano-vectordb").setLevel(logging.WARNING)
    print(f"[OK] Python {sys.version.split()[0]}, lightrag-hku {lr.__version__}")


# ═══════════════════════════════════════
#  LightRAG 适配器工厂
# ═══════════════════════════════════════

def _create_llm_func(cfg: Config):
    """构造 LLM 调用适配器。"""
    from lightrag.llm.openai import openai_complete_if_cache

    async def _llm(prompt, system_prompt=None, history_messages=None, **kw):
        if kw.pop("keyword_extraction", False):
            kw["response_format"] = {"type": "json_object"}
        return await openai_complete_if_cache(
            model=cfg.llm_model,
            prompt=prompt, system_prompt=system_prompt,
            history_messages=history_messages,
            base_url=cfg.llm_base_url, api_key=cfg.llm_api_key, **kw)
    return _llm


_embed_client = None

def _create_embed_func(cfg: Config):
    """构造 Embedding 适配器。客户端实例缓存复用。
    自动检测多模态 endpoints（model 名以 ep- 开头）并使用 /embeddings/multimodal 接口。
    """
    import numpy as np
    from openai import AsyncOpenAI
    from lightrag.utils import wrap_embedding_func_with_attrs
    global _embed_client

    def _get_ec():
        global _embed_client
        if _embed_client is None:
            _embed_client = AsyncOpenAI(api_key=cfg.embed_api_key, base_url=cfg.embed_base_url)
        return _embed_client

    _is_multimodal = cfg.embed_model.startswith("ep-")

    @wrap_embedding_func_with_attrs(
        embedding_dim=cfg.embed_dim,
        max_token_size=cfg.embed_max_tokens,
        model_name=cfg.embed_model)
    async def _embed(texts: list[str]):
        import base64 as b64
        import httpx
        if _is_multimodal:
            headers = {
                "Authorization": "Bearer " + cfg.embed_api_key,
                "Content-Type": "application/json",
            }
            body = {
                "model": cfg.embed_model,
                "input": [{"type": "text", "text": t} for t in texts],
                "encoding_format": "float",
            }
            url = cfg.embed_base_url.rstrip("/") + "/embeddings/multimodal"
            async with httpx.AsyncClient() as client:
                r = await client.post(url, json=body, headers=headers, timeout=60)
                r.raise_for_status()
                data = r.json()
            emb = data["data"]
            if isinstance(emb, dict):
                emb = emb["embedding"]
            if isinstance(emb[0], list):
                return np.array(emb, dtype=np.float32)
            return np.array(emb, dtype=np.float32).reshape(1, -1)
        else:
            resp = await _get_ec().embeddings.create(
                model=cfg.embed_model,
                input=texts, encoding_format="base64")
            return np.array([np.frombuffer(b64.b64decode(d.embedding), dtype=np.float32) for d in resp.data])
    return _embed


def _resolve_storage_kwargs(cfg: Config, workspace: str) -> dict:
    """根据 storage_backend 返回存储相关的 kw 字典。"""
    if cfg.storage_backend == "postgres":
        pg = cfg.postgres
        print(f"[INFO] Using PostgreSQL backend (workspace='{workspace}')")
        return dict(
            workspace=workspace,
            kv_storage="PGKVStorage",
            vector_storage="PGVectorStorage",
            graph_storage="NetworkXStorage",
            doc_status_storage="PGDocStatusStorage",
        )
    return {}


def _create_rerank_func(cfg: Config):
    """构造 Reranker 适配器。未启用或凭据缺失时返回 None。"""
    if not cfg.rerank_enabled or not cfg.rerank_api_key:
        return None
    from openai import AsyncOpenAI
    _rr_client = AsyncOpenAI(api_key=cfg.rerank_api_key, base_url=cfg.rerank_base_url)

    async def _rerank(query: str, documents: list[str], **kwargs):
        model = kwargs.get("model", cfg.rerank_model)
        try:
            resp = await _rr_client.post("/rerank", json={
                "model": model,
                "query": query,
                "documents": documents,
                "top_n": kwargs.get("top_n", len(documents)),
                "return_documents": False
            })
            data = resp.json()
            return data.get("results", [])
        except Exception as e:
            print(f"[WARN] Rerank failed: {e}", flush=True)
            return None
    print("[INFO] Reranker enabled")
    return _rerank


# ═══════════════════════════════════════
#  LightRAG 构造（编排器，不初始化存储）
# ═══════════════════════════════════════

def _make_rag(cfg: Config, work_dir: str, workspace: str = "default"):
    """构造 LightRAG 实例。适配器、存储后端、实体类型均由 Config 驱动。"""
    from lightrag import LightRAG

    addon = {"language": cfg.summary_language}
    if cfg.entity_types:
        addon["entity_types"] = cfg.entity_types

    kw = dict(
        working_dir=work_dir,
        llm_model_func=_create_llm_func(cfg),
        embedding_func=_create_embed_func(cfg),
        llm_model_name=cfg.llm_model,
        chunk_token_size=cfg.chunk_size,
        chunk_overlap_token_size=cfg.chunk_overlap,
        entity_extract_max_gleaning=cfg.max_gleaning,
        addon_params=addon,
    )

    # 存储后端
    kw.update(_resolve_storage_kwargs(cfg, workspace))

    # Reranker
    rerank = _create_rerank_func(cfg)
    if rerank:
        kw["rerank_model_func"] = rerank

    return LightRAG(**kw)


# ═══════════════════════════════════════
#  workspace 管理
# ═══════════════════════════════════════

def _ws_dir(cfg: Config, workspace: str) -> str:
    """workspace → 存储目录。PG 后端共享 working_dir 但用 workspace 参数隔离。"""
    if workspace == "default":
        return cfg.working_dir
    return os.path.join(cfg.working_dir, re.sub(r'[<>:"/\\|?*]', '_', workspace))


async def get_rag(cfg: Config, workspace: str = "default"):
    if workspace not in _rags:
        d = _ws_dir(cfg, workspace)
        rag = _make_rag(cfg, d, workspace=workspace)
        await rag.initialize_storages()
        _rags[workspace] = rag
        print(f"[OK] workspace '{workspace}' ({d})")
    return _rags[workspace]


def get_rag_sync(cfg: Config, workspace: str = "default"):
    """仅 main() 使用，不在事件循环内。"""
    if workspace not in _rags:
        d = _ws_dir(cfg, workspace)
        rag = _make_rag(cfg, d, workspace=workspace)
        asyncio.run(rag.initialize_storages())
        _rags[workspace] = rag
        print(f"[OK] workspace '{workspace}' ({d})")
    return _rags[workspace]


# ═══════════════════════════════════════
#  FastAPI 应用
# ═══════════════════════════════════════

def _create_app(cfg: Config):
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel, Field

    app = FastAPI(title="Hanako LightRAG", version="0.1.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    # ── Models ──
    class QR(BaseModel):
        query: str = Field(min_length=1)
        mode: Optional[str] = None
        top_k: int = Field(default=5, ge=1, le=50)
        only_need_context: bool = False
        response_type: str = "Multiple Paragraphs"

    class IR(BaseModel):
        text: str = Field(min_length=1)
        file_path: str = ""
        doc_id: Optional[str] = None

    # ── Route registrations ──
    _register_auth(app)
    _register_health(app, cfg)
    _register_query(app, QR, cfg)
    _register_docs(app, IR, cfg)
    _register_graph(app, cfg)
    _register_workspaces(app, cfg)
    _register_entities(app, cfg)
    _register_export(app, cfg)

    return app


async def _do_insert(rag, text, ids, fps, tid, ws):
    try:
        await rag.ainsert(input=text, ids=ids, file_paths=fps, track_id=tid)
    except Exception as e:
        print(f"[ERROR] Insert failed ws={ws}: {e}", flush=True)


# ═══════════════════════════════════════
#  Route registrations
# ═══════════════════════════════════════

def _register_auth(app):
    @app.get("/auth/status")
    async def auth_status():
        import secrets
        return {"auth_configured": False, "access_token": secrets.token_urlsafe(32),
                "token_type": "bearer", "auth_mode": "disabled",
                "core_version": "lightrag-hku", "api_version": "0.1.0"}

    @app.post("/auth/login")
    async def auth_login():
        import secrets
        return {"access_token": secrets.token_urlsafe(32), "token_type": "bearer", "auth_mode": "disabled"}


def _register_health(app, cfg: Config):
    @app.get("/health")
    async def health(workspace: str = "default"):
        rag = await get_rag(cfg, workspace)
        return {"status": "ok", "working_dir": rag.working_dir, "rag_ready": True, "workspace": workspace}


def _register_query(app, QR, cfg: Config):
    """cfg 闭包捕获，_register_query 闭包捕获 QR 模型类。"""

    @app.post("/query")
    async def query(req: QR, workspace: str = "default"):
        rag = await get_rag(cfg, workspace)
        mode = req.mode or cfg.default_query_mode
        p = QueryParam(mode=mode, top_k=req.top_k,
                       only_need_context=req.only_need_context,
                       response_type=req.response_type)
        try:
            return {"result": await rag.aquery(req.query, p), "mode": mode}
        except Exception as e:
            return {"error": str(e)}

    @app.post("/query/context")
    async def query_context(req: QR, workspace: str = "default"):
        rag = await get_rag(cfg, workspace)
        mode = req.mode or cfg.default_query_mode
        p = QueryParam(mode=mode, top_k=req.top_k, only_need_context=True)
        try:
            return {"result": await rag.aquery_data(req.query, p), "mode": mode}
        except Exception as e:
            return {"error": str(e)}

    @app.post("/query/cross")
    async def query_cross(req: QR, workspaces: str = "default"):
        ws_list = [w.strip() for w in workspaces.split(",") if w.strip()] or ["default"]
        mode = req.mode or cfg.default_query_mode

        async def _one(ws):
            try:
                rag = await get_rag(cfg, ws)
                p = QueryParam(mode=mode, top_k=req.top_k,
                               only_need_context=req.only_need_context,
                               response_type=req.response_type)
                r = await (rag.aquery_data if req.only_need_context else rag.aquery)(req.query, p)
                return {"workspace": ws, "result": r}
            except Exception as e:
                return {"workspace": ws, "error": str(e)}

        results = await asyncio.gather(*[_one(ws) for ws in ws_list])
        return {"mode": mode, "workspaces": ws_list, "results": results}


def _register_docs(app, IR, cfg: Config):
    from lightrag.utils import generate_track_id

    @app.post("/documents/text")
    async def insert_text(req: IR, workspace: str = "default"):
        rag = await get_rag(cfg, workspace)
        tid = generate_track_id("insert")
        asyncio.create_task(_do_insert(rag, req.text,
                                       [req.doc_id] if req.doc_id else None,
                                       [req.file_path] if req.file_path else None,
                                       tid, workspace))
        return {"track_id": tid, "status": "queued"}

    @app.get("/documents")
    async def list_documents(workspace: str = "default"):
        import json as _json
        work_dir = _ws_dir(cfg, workspace)
        doc_file = os.path.join(work_dir, "kv_store_doc_status.json")
        docs = []
        if os.path.isfile(doc_file):
            try:
                with open(doc_file, "r", encoding="utf-8") as f:
                    raw = _json.load(f)
                for did, s in raw.items():
                    docs.append({
                        "id": did,
                        "status": s.get("status", "unknown"),
                        "file_path": s.get("file_path", ""),
                        "content_summary": s.get("content_summary", ""),
                        "content_length": s.get("content_length", 0),
                        "created_at": s.get("created_at", "")
                    })
            except Exception:
                pass
        if not docs:
            rag = await get_rag(cfg, workspace)
            from lightrag.base import DocStatus
            all_docs = {}
            for s in [DocStatus.PENDING, DocStatus.PROCESSING, DocStatus.PROCESSED, DocStatus.FAILED]:
                try:
                    all_docs.update(await rag.doc_status.get_docs_by_status(s))
                except Exception:
                    pass
            docs = [{"id": did, "status": s.status,
                     "file_path": getattr(s, "file_path", ""),
                     "content_summary": getattr(s, "content_summary", ""),
                     "content_length": getattr(s, "content_length", 0),
                     "created_at": getattr(s, "created_at", "")}
                    for did, s in all_docs.items()]
        return {"documents": docs, "total": len(docs)}

    @app.delete("/documents/{doc_id}")
    async def delete_document(doc_id: str, workspace: str = "default"):
        rag = await get_rag(cfg, workspace)
        try:
            return {"result": str(await rag.adelete_by_doc_id(doc_id))}
        except Exception as e:
            return {"error": str(e)}


def _register_graph(app, cfg: Config):
    @app.get("/graph")
    async def get_graph(workspace: str = "default", limit: int = 200):
        rag = await get_rag(cfg, workspace)
        try:
            kg = await rag.chunk_entity_relation_graph.get_knowledge_graph(
                node_label="*", max_depth=1, max_nodes=limit)
            nodes = [{"id": n.id, "label": n.labels[0] if n.labels else n.id,
                      "entity_type": n.properties.get("entity_type", "")}
                     for n in (kg.nodes if kg else [])]
            edges = [{"id": e.id, "source": e.source, "target": e.target,
                      "label": (e.properties.get("description", "") or e.type or "")[:30]}
                     for e in (kg.edges if kg else [])]
            return {"nodes": nodes, "edges": edges,
                    "total_nodes": len(nodes), "total_edges": len(edges)}
        except Exception as e:
            return {"nodes": [], "edges": [], "total_nodes": 0, "total_edges": 0, "error": str(e)}


def _register_workspaces(app, cfg: Config):
    @app.get("/workspaces")
    async def list_workspaces():
        ws_list = []
        root_has = os.path.isfile(os.path.join(cfg.working_dir, "graph_chunk_entity_relation.graphml"))
        ws_list.append({"name": "default", "has_data": root_has})
        if os.path.isdir(cfg.working_dir):
            for entry in os.scandir(cfg.working_dir):
                if entry.is_dir() and entry.name != "default":
                    has = os.path.isfile(os.path.join(entry.path, "graph_chunk_entity_relation.graphml"))
                    ws_list.append({"name": entry.name, "has_data": has})
        return {"workspaces": ws_list, "working_dir": cfg.working_dir}

    @app.post("/workspaces/{name}")
    async def create_workspace(name: str):
        safe = re.sub(r'[<>:"/\\|?*]', '_', name)
        if safe == "default":
            return {"error": "不能创建名为 default 的 workspace（系统保留）"}
        os.makedirs(os.path.join(cfg.working_dir, safe), exist_ok=True)
        try:
            await get_rag(cfg, safe)
            return {"created": safe, "path": os.path.join(cfg.working_dir, safe), "status": "ok"}
        except Exception as e:
            return {"error": f"初始化失败: {e}"}

    @app.delete("/workspaces/{name}")
    async def delete_workspace(name: str):
        safe = re.sub(r'[<>:"/\\|?*]', '_', name)
        if safe == "default":
            return {"error": "不能删除 default workspace（系统保留）"}
        d = os.path.join(cfg.working_dir, safe)
        if not os.path.isdir(d):
            return {"error": f"workspace '{safe}' 不存在"}
        _rags.pop(safe, None)
        import shutil
        shutil.rmtree(d)
        return {"deleted": safe, "status": "ok"}


def _register_entities(app, cfg: Config):
    from pydantic import BaseModel

    class EntityEdit(BaseModel):
        entity_name: str
        new_data: dict = {}

    class RelationEdit(BaseModel):
        source: str
        target: str
        new_data: dict = {}

    class MergeRequest(BaseModel):
        source: str
        target: str

    @app.delete("/entities/{entity_name}")
    async def delete_entity(entity_name: str, workspace: str = "default"):
        rag = await get_rag(cfg, workspace)
        try:
            result = await rag.adelete_by_entity(entity_name)
            return {"deleted": entity_name, "result": str(result)}
        except Exception as e:
            return {"error": str(e)}

    @app.delete("/relations")
    async def delete_relation(source: str, target: str, workspace: str = "default"):
        rag = await get_rag(cfg, workspace)
        try:
            result = await rag.adelete_by_relation(source, target)
            return {"deleted": f"{source} -> {target}", "result": str(result)}
        except Exception as e:
            return {"error": str(e)}

    @app.put("/entities")
    async def edit_entity(req: EntityEdit, workspace: str = "default"):
        rag = await get_rag(cfg, workspace)
        try:
            await rag.aedit_entity(req.entity_name, **req.new_data)
            return {"edited": req.entity_name, "status": "ok"}
        except Exception as e:
            return {"error": str(e)}

    @app.put("/relations")
    async def edit_relation(req: RelationEdit, workspace: str = "default"):
        rag = await get_rag(cfg, workspace)
        try:
            await rag.aedit_relation(req.source, req.target, **req.new_data)
            return {"edited": f"{req.source} -> {req.target}", "status": "ok"}
        except Exception as e:
            return {"error": str(e)}

    @app.post("/entities/merge")
    async def merge_entities(req: MergeRequest, workspace: str = "default"):
        rag = await get_rag(cfg, workspace)
        try:
            await rag.amerge_entities(req.source, req.target)
            return {"merged": f"{req.source} -> {req.target}", "status": "ok"}
        except Exception as e:
            return {"error": str(e)}


def _register_export(app, cfg: Config):
    @app.get("/export")
    async def export_data(workspace: str = "default"):
        rag = await get_rag(cfg, workspace)
        try:
            data = await rag.aexport_data()
            return {"workspace": workspace, "data": data}
        except Exception as e:
            return {"error": str(e)}


# ═══════════════════════════════════════
#  入口
# ═══════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="Hanako LightRAG server")
    parser.add_argument("--config", required=True, help="Path to resolved_config.json")
    args = parser.parse_args()

    cfg = Config(args.config)
    _check_env()
    get_rag_sync(cfg, "default")
    app = _create_app(cfg)
    print(f"[INFO] LightRAG server starting on port {cfg.port}...")
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=cfg.port, log_level="warning")


if __name__ == "__main__":
    main()
