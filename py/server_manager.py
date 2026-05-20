#!/usr/bin/env python3
"""hanako-lightrag/py/server_manager.py — LightRAG FastAPI 包装器。"""

import os, sys, asyncio, re
from lightrag import QueryParam

PORT = int(os.getenv("LIGHTRAG_PORT", "9621"))
WORKING_DIR = os.getenv("LIGHTRAG_WORKING_DIR", "./lightrag_data")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.deepseek.com/v1")
EMBED_API_KEY = os.getenv("EMBED_API_KEY", "")
EMBED_BASE_URL = os.getenv("EMBED_BASE_URL", "https://api.siliconflow.cn/v1")
SUMMARY_LANGUAGE = os.getenv("SUMMARY_LANGUAGE", "Chinese")
MAX_GLEANING = int(os.getenv("MAX_GLEANING", "0"))
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "1200"))
CHUNK_OVERLAP_SIZE = int(os.getenv("CHUNK_OVERLAP_SIZE", "100"))

# ── RAG 实例缓存 ──
_rags: dict[str, "LightRAG"] = {}

# ═══════════════════════════════════════
#  环境检查
# ═══════════════════════════════════════

def _check_env():
    if sys.version_info < (3, 10):
        print(f"[FATAL] Python 3.10+ required, got {sys.version}", file=sys.stderr); sys.exit(1)
    if not LLM_API_KEY: print("[FATAL] LLM_API_KEY not set", file=sys.stderr); sys.exit(1)
    if not EMBED_API_KEY: print("[FATAL] EMBED_API_KEY not set", file=sys.stderr); sys.exit(1)
    try:
        import lightrag
    except ImportError:
        print("[FATAL] lightrag-hku not installed", file=sys.stderr); sys.exit(1)
    # 抑制 INFO 噪音
    import logging
    logging.getLogger("lightrag").setLevel(logging.WARNING)
    logging.getLogger("nano-vectordb").setLevel(logging.WARNING)
    print(f"[OK] Python {sys.version.split()[0]}, lightrag-hku {lightrag.__version__}")

# ═══════════════════════════════════════
#  LightRAG 适配器工厂
# ═══════════════════════════════════════

def _create_llm_func():
    """构造 LLM 调用适配器。"""
    from lightrag.llm.openai import openai_complete_if_cache

    async def _llm(prompt, system_prompt=None, history_messages=None, **kw):
        if kw.pop("keyword_extraction", False):
            kw["response_format"] = {"type": "json_object"}
        return await openai_complete_if_cache(
            model=os.getenv("LLM_MODEL", "deepseek-v4-flash"),
            prompt=prompt, system_prompt=system_prompt,
            history_messages=history_messages,
            base_url=LLM_BASE_URL, api_key=LLM_API_KEY, **kw)
    return _llm


_embed_client = None

def _create_embed_func():
    """构造 Embedding 适配器。客户端实例缓存复用。"""
    import numpy as np
    from openai import AsyncOpenAI
    from lightrag.utils import wrap_embedding_func_with_attrs
    global _embed_client

    def _get_ec():
        global _embed_client
        if _embed_client is None:
            _embed_client = AsyncOpenAI(api_key=EMBED_API_KEY, base_url=EMBED_BASE_URL)
        return _embed_client

    @wrap_embedding_func_with_attrs(
        embedding_dim=int(os.getenv("EMBED_DIM", "4096")),
        max_token_size=int(os.getenv("EMBED_MAX_TOKENS", "8192")),
        model_name=os.getenv("EMBED_MODEL", "Qwen/Qwen3-Embedding-8B"))
    async def _embed(texts: list[str]):
        import base64 as b64
        resp = await _get_ec().embeddings.create(
            model=os.getenv("EMBED_MODEL", "Qwen/Qwen3-Embedding-8B"),
            input=texts, encoding_format="base64")
        return np.array([np.frombuffer(b64.b64decode(d.embedding), dtype=np.float32) for d in resp.data])
    return _embed


def _resolve_storage_kwargs(workspace: str) -> dict:
    """根据 STORAGE_BACKEND 返回存储相关的 kw 字典。"""
    backend = os.getenv("STORAGE_BACKEND", "json")
    if backend == "postgres":
        print(f"[INFO] Using PostgreSQL backend (workspace='{workspace}')")
        return dict(
            workspace=workspace,
            kv_storage="PGKVStorage",
            vector_storage="PGVectorStorage",
            graph_storage="NetworkXStorage",
            doc_status_storage="PGDocStatusStorage",
        )
    return {}


def _create_rerank_func():
    """构造 Reranker 适配器。未启用或凭据缺失时返回 None。"""
    if os.getenv("RERANK_ENABLED", "false") != "true" or not os.getenv("RERANK_API_KEY"):
        return None
    from openai import AsyncOpenAI
    _rr_client = AsyncOpenAI(
        api_key=os.getenv("RERANK_API_KEY"),
        base_url=os.getenv("RERANK_BASE_URL", "https://api.siliconflow.cn/v1"))

    async def _rerank(query: str, documents: list[str], **kwargs):
        """OpenAI-compatible rerank wrapper (SiliconFlow / Jina / Cohere via compatible API)"""
        model = kwargs.get("model", os.getenv("RERANK_MODEL", "BAAI/bge-reranker-v2-m3"))
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

def _make_rag(work_dir: str, workspace: str = "default"):
    """构造 LightRAG 实例。适配器、存储后端、实体类型均由工厂函数组装。"""
    from lightrag import LightRAG
    import json

    # 实体类型解析
    et_raw = os.getenv("ENTITY_TYPES", "")
    entity_types = None
    if et_raw:
        try:
            entity_types = json.loads(et_raw)
        except json.JSONDecodeError:
            entity_types = [t.strip() for t in et_raw.split(",") if t.strip()]

    addon = {"language": SUMMARY_LANGUAGE}
    if entity_types:
        addon["entity_types"] = entity_types

    kw = dict(
        working_dir=work_dir,
        llm_model_func=_create_llm_func(),
        embedding_func=_create_embed_func(),
        llm_model_name=os.getenv("LLM_MODEL", "deepseek-v4-flash"),
        chunk_token_size=CHUNK_SIZE,
        chunk_overlap_token_size=CHUNK_OVERLAP_SIZE,
        entity_extract_max_gleaning=MAX_GLEANING,
        addon_params=addon,
    )

    # 存储后端
    kw.update(_resolve_storage_kwargs(workspace))

    # Reranker
    rerank = _create_rerank_func()
    if rerank:
        kw["rerank_model_func"] = rerank

    return LightRAG(**kw)

# ═══════════════════════════════════════
#  workspace 管理
# ═══════════════════════════════════════

def _ws_dir(workspace: str) -> str:
    """workspace → 存储目录。PG 后端共享 WORKING_DIR 但用 workspace 参数隔离。"""
    if workspace == "default": return WORKING_DIR
    return os.path.join(WORKING_DIR, re.sub(r'[<>:"/\\|?*]', '_', workspace))

async def get_rag(workspace: str = "default"):
    if workspace not in _rags:
        d = _ws_dir(workspace)
        rag = _make_rag(d, workspace=workspace)
        await rag.initialize_storages()
        _rags[workspace] = rag
        print(f"[OK] workspace '{workspace}' ({d})")
    return _rags[workspace]

def get_rag_sync(workspace: str = "default"):
    """仅 main() 使用，不在事件循环内。"""
    if workspace not in _rags:
        d = _ws_dir(workspace)
        rag = _make_rag(d, workspace=workspace)
        asyncio.run(rag.initialize_storages())
        _rags[workspace] = rag
        print(f"[OK] workspace '{workspace}' ({d})")
    return _rags[workspace]

# ═══════════════════════════════════════
#  FastAPI 应用
# ═══════════════════════════════════════

def _create_app():
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel, Field
    from typing import Optional

    app = FastAPI(title="Hanako LightRAG", version="0.1.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    # ── Models ──
    class QR(BaseModel):
        query: str = Field(min_length=1)
        mode: str = os.getenv("DEFAULT_QUERY_MODE", "mix")
        top_k: int = Field(default=5, ge=1, le=50)
        only_need_context: bool = False
        response_type: str = "Multiple Paragraphs"

    class IR(BaseModel):
        text: str = Field(min_length=1)
        file_path: str = ""
        doc_id: Optional[str] = None

    # ── Route registrations ──
    _register_auth(app)
    _register_health(app)
    _register_query(app, QR)
    _register_docs(app, IR)
    _register_graph(app)
    _register_workspaces(app)

    return app

async def _do_insert(rag, text, ids, fps, tid, ws):
    try: await rag.ainsert(input=text, ids=ids, file_paths=fps, track_id=tid)
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

def _register_health(app):
    @app.get("/health")
    async def health(workspace: str = "default"):
        rag = await get_rag(workspace)
        return {"status": "ok", "working_dir": rag.working_dir, "rag_ready": True, "workspace": workspace}

def _register_query(app, QR):
    @app.post("/query")
    async def query(req: QR, workspace: str = "default"):
        rag = await get_rag(workspace)
        p = QueryParam(mode=req.mode, top_k=req.top_k, only_need_context=req.only_need_context,
                       response_type=req.response_type)
        try: return {"result": await rag.aquery(req.query, p), "mode": req.mode}
        except Exception as e: return {"error": str(e)}

    @app.post("/query/context")
    async def query_context(req: QR, workspace: str = "default"):
        rag = await get_rag(workspace)
        p = QueryParam(mode=req.mode, top_k=req.top_k, only_need_context=True)
        try: return {"result": await rag.aquery_data(req.query, p), "mode": req.mode}
        except Exception as e: return {"error": str(e)}

    @app.post("/query/cross")
    async def query_cross(req: QR, workspaces: str = "default"):
        ws_list = [w.strip() for w in workspaces.split(",") if w.strip()] or ["default"]
        async def _one(ws):
            try:
                rag = await get_rag(ws)
                p = QueryParam(mode=req.mode, top_k=req.top_k, only_need_context=req.only_need_context,
                               response_type=req.response_type)
                r = await (rag.aquery_data if req.only_need_context else rag.aquery)(req.query, p)
                return {"workspace": ws, "result": r}
            except Exception as e:
                return {"workspace": ws, "error": str(e)}
        results = await asyncio.gather(*[_one(ws) for ws in ws_list])
        return {"mode": req.mode, "workspaces": ws_list, "results": results}

def _register_docs(app, IR):
    from lightrag.utils import generate_track_id
    @app.post("/documents/text")
    async def insert_text(req: IR, workspace: str = "default"):
        rag = await get_rag(workspace)
        tid = generate_track_id("insert")
        asyncio.create_task(_do_insert(rag, req.text, [req.doc_id] if req.doc_id else None,
                                        [req.file_path] if req.file_path else None, tid, workspace))
        return {"track_id": tid, "status": "queued"}

    @app.get("/documents")
    async def list_documents(workspace: str = "default"):
        rag = await get_rag(workspace)
        from lightrag.base import DocStatus
        all_docs = {}
        for s in [DocStatus.PENDING, DocStatus.PROCESSING, DocStatus.PROCESSED, DocStatus.FAILED]:
            try: all_docs.update(await rag.doc_status.get_docs_by_status(s))
            except Exception: pass
        docs = [{"id": did, "status": s.status, "file_path": getattr(s, "file_path", ""),
                 "content_summary": getattr(s, "content_summary", ""),
                 "content_length": getattr(s, "content_length", 0),
                 "created_at": getattr(s, "created_at", "")} for did, s in all_docs.items()]
        return {"documents": docs, "total": len(docs)}

    @app.delete("/documents/{doc_id}")
    async def delete_document(doc_id: str, workspace: str = "default"):
        rag = await get_rag(workspace)
        try: return {"result": str(await rag.adelete_by_doc_id(doc_id))}
        except Exception as e: return {"error": str(e)}

def _register_graph(app):
    @app.get("/graph")
    async def get_graph(workspace: str = "default", limit: int = 200):
        rag = await get_rag(workspace)
        try:
            kg = await rag.chunk_entity_relation_graph.get_knowledge_graph(node_label="*", max_depth=1, max_nodes=limit)
            nodes = [{"id": n.id, "label": n.labels[0] if n.labels else n.id,
                      "entity_type": n.properties.get("entity_type", "")} for n in (kg.nodes if kg else [])]
            edges = [{"id": e.id, "source": e.source, "target": e.target,
                      "label": (e.properties.get("description", "") or e.type or "")[:30]}
                     for e in (kg.edges if kg else [])]
            return {"nodes": nodes, "edges": edges, "total_nodes": len(nodes), "total_edges": len(edges)}
        except Exception as e:
            return {"nodes": [], "edges": [], "total_nodes": 0, "total_edges": 0, "error": str(e)}

def _register_workspaces(app):
    @app.get("/workspaces")
    async def list_workspaces():
        ws_list = []
        root_has = os.path.isfile(os.path.join(WORKING_DIR, "graph_chunk_entity_relation.graphml"))
        ws_list.append({"name": "default", "has_data": root_has})
        if os.path.isdir(WORKING_DIR):
            for entry in os.scandir(WORKING_DIR):
                if entry.is_dir() and entry.name != "default":
                    ws_list.append({"name": entry.name, "has_data":
                        os.path.isfile(os.path.join(entry.path, "graph_chunk_entity_relation.graphml"))})
        return {"workspaces": ws_list, "working_dir": WORKING_DIR}

    @app.post("/workspaces/{name}")
    async def create_workspace(name: str):
        safe = re.sub(r'[<>:"/\\|?*]', '_', name)
        if safe == "default": return {"error": "不能创建名为 default 的 workspace（系统保留）"}
        os.makedirs(os.path.join(WORKING_DIR, safe), exist_ok=True)
        try:
            await get_rag(safe)
            return {"created": safe, "path": os.path.join(WORKING_DIR, safe), "status": "ok"}
        except Exception as e:
            return {"error": f"初始化失败: {e}"}

    @app.delete("/workspaces/{name}")
    async def delete_workspace(name: str):
        safe = re.sub(r'[<>:"/\\|?*]', '_', name)
        if safe == "default": return {"error": "不能删除 default workspace（系统保留）"}
        d = os.path.join(WORKING_DIR, safe)
        if not os.path.isdir(d): return {"error": f"workspace '{safe}' 不存在"}
        if safe in _rags: del _rags[safe]
        import shutil; shutil.rmtree(d)
        return {"deleted": safe, "status": "ok"}

# ═══════════════════════════════════════
#  入口
# ═══════════════════════════════════════

def main():
    _check_env()
    get_rag_sync("default")
    app = _create_app()
    print(f"[INFO] LightRAG server starting on port {PORT}...")
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")

if __name__ == "__main__":
    main()
