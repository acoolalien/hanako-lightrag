/**
 * hanako-lightrag/index.js
 *
 * 生命周期管理：onload spawn Python sidecar，onunload kill。
 *
 * 配置流（唯一来源）：
 *   config.json (ctx.config) → 用户配置 + manifest 默认值
 *   bus.request(provider:credentials) → API 凭据
 *   ↓                        合并
 *   resolved_config.json      → Python 端读取（不含 API Key）
 *   env: LLM/EMBED/RERANK_API_KEY → Python 端仅从环境变量拿密钥
 */

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
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
//  Plugin
// ═══════════════════════════════════════

export default class Plugin {
  _proc = null;
  _port = 9621;
  _restarts = 0;
  _maxRestarts = 3;

  // ── 配置读取（来源：ctx.config 已有 manifest 默认值合并，无需 || 回退） ──
  async _readConfig() {
    const ctx = this.ctx;
    const [workingDir, summaryLanguage, chunkSize, chunkOverlapSize,
           entityTypes, defaultQueryMode, storageBackend] = await Promise.all([
      ctx.config.get("workingDir"),
      ctx.config.get("summaryLanguage"),
      ctx.config.get("chunkSize"),
      ctx.config.get("chunkOverlapSize"),
      ctx.config.get("entityTypes"),
      ctx.config.get("defaultQueryMode"),
      ctx.config.get("storageBackend"),
    ]);

    return {
      port: await ctx.config.get("lightragPort"),
      llmBaseUrl: await ctx.config.get("llmBaseUrl"),
      llmModel: await ctx.config.get("llmModel"),
      embedBaseUrl: await ctx.config.get("embedBaseUrl"),
      embedModel: await ctx.config.get("embedModel"),
      embedDim: await ctx.config.get("embedDim"),
      rerankEnabled: await ctx.config.get("rerankEnabled"),
      rerankBaseUrl: await ctx.config.get("rerankBaseUrl"),
      rerankModel: await ctx.config.get("rerankModel"),
      // workingDir manifest 默认值为 ""，此处解析为插件数据目录
      workingDir: workingDir || ctx.dataDir,
      summaryLanguage,
      maxGleaning: await ctx.config.get("maxGleaning"),
      chunkSize,
      chunkOverlapSize,
      entityTypes: entityTypes || [],
      defaultQueryMode,
      storageBackend,
    };
  }

  // ── 校验 API Key 环境变量（仅警告，不阻止启动，Python 侧会自行报错） ──
  _checkEnvKeys() {
    const ctx = this.ctx;
    if (!process.env.LLM_API_KEY) ctx.log.error("LLM_API_KEY 环境变量未设置。请在系统环境变量中配置后重启 Hanako。");
    if (!process.env.EMBED_API_KEY) ctx.log.error("EMBED_API_KEY 环境变量未设置。请在系统环境变量中配置后重启 Hanako。");
  }

  // ── 生成 resolved_config.json（全部从 cfg 取值，不依赖 Provider 凭据） ──
  async _writeResolvedConfig(cfg) {
    const dataDir = this.ctx.dataDir;
    const configPath = path.join(dataDir, "config.resolved.json");

    const resolved = {
      port: cfg.port,
      working_dir: cfg.workingDir,
      llm: {
        base_url: cfg.llmBaseUrl,
        model: cfg.llmModel,
      },
      embedding: {
        base_url: cfg.embedBaseUrl,
        model: cfg.embedModel,
        dim: cfg.embedDim,
        max_tokens: 8192,
      },
      rerank: {
        enabled: cfg.rerankEnabled,
        base_url: cfg.rerankBaseUrl,
        model: cfg.rerankModel,
      },
      chunk: {
        size: cfg.chunkSize,
        overlap: cfg.chunkOverlapSize,
      },
      summary_language: cfg.summaryLanguage,
      max_gleaning: cfg.maxGleaning,
      entity_types: cfg.entityTypes,
      default_query_mode: cfg.defaultQueryMode,
      storage_backend: cfg.storageBackend,
    };

    if (cfg.storageBackend === "postgres") {
      const [pgHost, pgPort, pgDb, pgUser, pgPassword] = await Promise.all([
        this.ctx.config.get("pgHost"),
        this.ctx.config.get("pgPort"),
        this.ctx.config.get("pgDatabase"),
        this.ctx.config.get("pgUser"),
        this.ctx.config.get("pgPassword"),
      ]);
      resolved.postgres = {
        host: pgHost,
        port: pgPort,
        database: pgDb,
        user: pgUser,
        password: pgPassword || "",
      };
    }

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(resolved, null, 2), "utf-8");
    this.ctx.log.info(`Resolved config written to ${configPath}`);
    return configPath;
  }

  // ── 构建环境变量（直接透传 process.env，Python 端读 LLM/EMBED/RERANK_API_KEY） ──
  _buildEnv() {
    return { ...process.env };
  }

  // ── 启动 Python sidecar ──
  _spawnServer(env, configPath) {
    const ctx = this.ctx;
    this._proc?.kill();
    this._proc = null;

    const pyScript = path.join(__dirname, "py", "server_manager.py");
    ctx.log.info(`Starting LightRAG server (config: ${configPath})...`);

    const proc = spawn("python", ["-u", pyScript, "--config", configPath], {
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
        ctx.log.error(`Port ${env.LIGHTRAG_PORT || "?"} is already in use. Change lightragPort in plugin settings.`);
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
          if (this._proc === proc) this._spawnServer(env, configPath);
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

    this._checkEnvKeys();

    const configPath = await this._writeResolvedConfig(cfg);
    const env = this._buildEnv();

    this._spawnServer(env, configPath);

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
