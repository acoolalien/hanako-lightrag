/**
 * hanako-lightrag/index.js
 *
 * 生命周期管理：onload spawn Python sidecar，onunload kill。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function healthCheck(port, timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeout, () => { req.destroy(); resolve(false); });
  });
}

// ═══════════════════════════════════════
//  配置 → 环境变量映射（新增配置项只需在此登记）
// ═══════════════════════════════════════

const ENV_MAP = [
  ["lightragPort",       "LIGHTRAG_PORT",       v => String(v || 9621)],
  ["workingDir",         "LIGHTRAG_WORKING_DIR", v => v],
  ["summaryLanguage",    "SUMMARY_LANGUAGE",     v => v || "Chinese"],
  ["maxGleaning",        "MAX_GLEANING",         v => String(v ?? 0)],
  ["chunkSize",          "CHUNK_SIZE",           v => String(v || 1200)],
  ["chunkOverlapSize",   "CHUNK_OVERLAP_SIZE",   v => String(v || 100)],
  ["entityTypes",        "ENTITY_TYPES",         v => JSON.stringify(v || [])],
  ["defaultQueryMode",   "DEFAULT_QUERY_MODE",   v => v || "mix"],
  ["embedModel",         "EMBED_MODEL",          v => v || "Qwen/Qwen3-Embedding-8B"],
  ["embedDim",           "EMBED_DIM",            v => String(v || 4096)],
  ["rerankEnabled",      "RERANK_ENABLED",       v => v ? "true" : "false"],
];

// ═══════════════════════════════════════
//  Plugin
// ═══════════════════════════════════════

export default class Plugin {
  _proc = null;
  _port = 9621;
  _restarts = 0;
  _maxRestarts = 3;

  // ── 配置读取 ──
  async _readConfig() {
    const ctx = this.ctx;
    const [llmProviderId, embeddingProviderId, workingDir, summaryLanguage,
           chunkSize, chunkOverlapSize, entityTypes, defaultQueryMode,
           storageBackend] = await Promise.all([
      ctx.config.get("llmProviderId"),
      ctx.config.get("embeddingProviderId"),
      ctx.config.get("workingDir"),
      ctx.config.get("summaryLanguage"),
      ctx.config.get("chunkSize"),
      ctx.config.get("chunkOverlapSize"),
      ctx.config.get("entityTypes"),
      ctx.config.get("defaultQueryMode"),
      ctx.config.get("storageBackend"),
    ]);

    return {
      port: (await ctx.config.get("lightragPort")) || 9621,
      llmProviderId: llmProviderId || "deepseek",
      embeddingProviderId: embeddingProviderId || "siliconflow",
      workingDir: workingDir || ctx.dataDir,
      summaryLanguage: summaryLanguage || "Chinese",
      maxGleaning: (await ctx.config.get("maxGleaning")) ?? 0,
      chunkSize: chunkSize || 1200,
      chunkOverlapSize: chunkOverlapSize || 100,
      entityTypes: entityTypes || [],
      defaultQueryMode: defaultQueryMode || "mix",
      embedModel: (await ctx.config.get("embedModel")) || "Qwen/Qwen3-Embedding-8B",
      embedDim: (await ctx.config.get("embedDim")) || 4096,
      rerankEnabled: (await ctx.config.get("rerankEnabled")) || false,
      rerankProviderId: (await ctx.config.get("rerankProviderId")) || "",
      storageBackend: storageBackend || "json",
    };
  }

  // ── Provider 凭据 ──
  async _fetchCredentials(cfg) {
    const ctx = this.ctx;
    let llmCreds = {}, embedCreds = {}, rerankCreds = {};

    try { llmCreds = (await ctx.bus.request("provider:credentials", { providerId: cfg.llmProviderId })) || {}; }
    catch (e) { ctx.log.warn(`LLM provider "${cfg.llmProviderId}" not found: ${e.message}`); }

    try { embedCreds = (await ctx.bus.request("provider:credentials", { providerId: cfg.embeddingProviderId })) || {}; }
    catch (e) { ctx.log.warn(`Embedding provider "${cfg.embeddingProviderId}" not found: ${e.message}`); }

    if (cfg.rerankEnabled) {
      if (!cfg.rerankProviderId) {
        ctx.log.warn("Rerank 已启用但 rerankProviderId 未配置，重排功能不生效。请在插件设置中配置 Rerank Provider ID。");
      } else {
        try { rerankCreds = (await ctx.bus.request("provider:credentials", { providerId: cfg.rerankProviderId })) || {}; }
        catch (e) { ctx.log.warn(`Rerank provider "${cfg.rerankProviderId}" not found: ${e.message}`); }
        if (!rerankCreds.apiKey) {
          ctx.log.warn(`Rerank provider "${cfg.rerankProviderId}" 凭据缺失，重排功能不生效。请检查 Provider 配置。`);
        }
      }
    }

    if (!llmCreds.apiKey) { ctx.log.error(`LLM provider "${cfg.llmProviderId}" is not configured.`); return null; }
    if (!embedCreds.apiKey) { ctx.log.error(`Embedding provider "${cfg.embeddingProviderId}" is not configured.`); return null; }
    return { llmCreds, embedCreds, rerankCreds };
  }

  // ── 构建环境变量 ──
  async _buildEnv(cfg, creds) {
    const ctx = this.ctx;
    const env = { ...process.env };

    // cfg → env 声明式映射
    for (const [cfgKey, envKey, xform] of ENV_MAP) {
      env[envKey] = xform(cfg[cfgKey]);
    }

    // 凭据注入
    env.LLM_API_KEY = creds.llmCreds.apiKey;
    env.LLM_BASE_URL = creds.llmCreds.baseUrl || "";
    env.LLM_API_SPEC = creds.llmCreds.api || "openai-completions";
    env.EMBED_API_KEY = creds.embedCreds.apiKey;
    env.EMBED_BASE_URL = creds.embedCreds.baseUrl || "";
    env.EMBED_API_SPEC = creds.embedCreds.api || "openai-completions";

    if (cfg.rerankEnabled && creds.rerankCreds?.apiKey) {
      env.RERANK_API_KEY = creds.rerankCreds.apiKey;
      env.RERANK_BASE_URL = creds.rerankCreds.baseUrl || "";
      env.RERANK_MODEL = creds.rerankCreds.model || "";
    }

    if (cfg.storageBackend === "postgres") {
      const pgPassword = (await ctx.config.get("pgPassword")) || "";
      if (!pgPassword) { ctx.log.error("PostgreSQL backend selected but pgPassword is not configured."); return null; }
      env.STORAGE_BACKEND = "postgres";
      env.POSTGRES_HOST = (await ctx.config.get("pgHost")) || "localhost";
      env.POSTGRES_PORT = String((await ctx.config.get("pgPort")) || 5432);
      env.POSTGRES_DATABASE = (await ctx.config.get("pgDatabase")) || "lightrag";
      env.POSTGRES_USER = (await ctx.config.get("pgUser")) || "postgres";
      env.POSTGRES_PASSWORD = pgPassword;
    }
    return env;
  }

  // ── 启动 Python sidecar ──
  _spawnServer(env) {
    const ctx = this.ctx;
    this._proc?.kill();
    this._proc = null;

    const pyScript = path.join(__dirname, "py", "server_manager.py");
    const port = env.LIGHTRAG_PORT;
    ctx.log.info(`Starting LightRAG server on port ${port}...`);

    const proc = spawn("python", ["-u", pyScript], {
      env, cwd: __dirname, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });

    proc.stdout.on("data", (d) => {
      const line = d.toString().trim();
      if (line) ctx.log.info(`[lightrag] ${line}`);
    });
    proc.stderr.on("data", (d) => {
      const line = d.toString().trim();
      if (!line) return;
      if (/address already in use|10048|10013/.test(line)) {
        ctx.log.error(`Port ${env.LIGHTRAG_PORT} is already in use. Change lightragPort in plugin settings.`);
      } else if (/ERROR|FATAL|Traceback|WARNING/.test(line)) {
        ctx.log.warn(`[lightrag:err] ${line}`);
      }
    });

    // ── watchdog: 崩溃自动重启 ──
    proc.on("exit", (code) => {
      ctx.log.warn(`LightRAG server exited (code ${code})`);
      if (this._proc === proc && this._restarts < this._maxRestarts) {
        this._restarts++;
        ctx.log.info(`Restarting LightRAG (attempt ${this._restarts}/${this._maxRestarts})...`);
        setTimeout(() => {
          if (this._proc === proc) this._spawnServer(env);
        }, 2000);
      } else {
        this._proc = null;
      }
    });

    this._proc = proc;
    return proc;
  }

  // ── 生命周期 ──
  async onload() {
    const cfg = await this._readConfig();
    this._port = cfg.port;

    const creds = await this._fetchCredentials(cfg);
    if (!creds) return;

    const env = await this._buildEnv(cfg, creds);
    if (!env) return;

    this._spawnServer(env);

    // 非阻塞健康检查
    this._restarts = 0;
    healthCheck(this._port).then(ok => {
      if (ok) this.ctx.log.info(`LightRAG server ready on port ${this._port}`);
    });
  }

  async onunload() {
    this._maxRestarts = 0; // 禁止自动重启
    if (this._proc) {
      this.ctx.log.info("Stopping LightRAG server...");
      this._proc.kill("SIGTERM");
      await sleep(3000);
      if (!this._proc.killed) this._proc.kill("SIGKILL");
      this._proc = null;
      this.ctx.log.info("LightRAG server stopped");
    }
  }
}
