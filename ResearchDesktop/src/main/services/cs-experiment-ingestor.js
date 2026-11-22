/**
 * src/main/services/cs-experiment-ingestor.js — 计算机（CS/ML/Robotics）真实实验工程接入引擎（零额外依赖）
 * 覆盖计算机科研日常高频痛点：
 *   1. CLI 命令解析（python / torchrun / accelerate / deepspeed + --flag + Hydra a.b=c + CUDA_VISIBLE_DEVICES）
 *   2. 真实训练目录自动扫描接入（Hydra .hydra/config.yaml、W&B wandb-summary/metadata、
 *      HuggingFace trainer_state.json / eval_results.json、PyTorch Lightning metrics.csv、
 *      TensorBoard 纯 JS 二进制 .tfevents、PyTorch/tqdm .log 与 Checkpoint 清单）
 *   3. 代码仓 Git 快照与未提交代码 Diff 存档（只读 execFileSync，防命令注入）
 *   4. 超参 Sweep 笛卡尔网格与 Bash / 多卡并行队列 / tmux / Slurm Array / Hydra multirun 脚本生成
 */
'use strict';

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { execFileSync } = require('child_process');

const MAX_TFEVENTS_BYTES = 24 * 1024 * 1024;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_BYTES = 48 * 1024;

function runGitReadOnly(args, cwd) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      timeout: 3000,
      maxBuffer: 512 * 1024,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, output: String(out || '').trim() };
  } catch (e) {
    return { ok: false, output: '', error: (e && e.message) || 'git_failed' };
  }
}

/** 借助 gray-matter 内置 YAML 解析器安全解析 YAML（无额外依赖）。 */
function parseYamlSafe(rawText) {
  const txt = String(rawText || '').trim();
  if (!txt) return {};
  try {
    const wrapped = `---\n${txt.replace(/^---\s*\r?\n/, '').replace(/\r?\n---\s*$/, '')}\n---\n`;
    const parsed = matter(wrapped);
    return parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
  } catch (_) {
    // 极简逐行 key: value 兜底
    const out = {};
    txt.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.+)$/);
      if (m && !line.trim().startsWith('#')) {
        out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    });
    return out;
  }
}

/** 将嵌套的 Hydra / W&B YAML 配置扁平化为点分键值（自动解包 W&B { value: ... } 格式）。 */
function flattenConfig(obj, prefix = '', out = {}, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return out;
  for (const [rawKey, rawVal] of Object.entries(obj)) {
    if (rawKey.startsWith('_') && rawKey !== '_target_') continue;
    const key = prefix ? `${prefix}.${rawKey}` : rawKey;
    if (rawVal === null || rawVal === undefined) continue;
    // W&B config.yaml 常见格式：{ desc: null, value: 0.0001 }
    if (typeof rawVal === 'object' && !Array.isArray(rawVal) && Object.prototype.hasOwnProperty.call(rawVal, 'value') && Object.keys(rawVal).length <= 2) {
      const unwrapped = rawVal.value;
      if (unwrapped !== null && unwrapped !== undefined) {
        if (typeof unwrapped === 'object' && !Array.isArray(unwrapped)) {
          flattenConfig(unwrapped, key, out, depth + 1);
        } else {
          out[key] = Array.isArray(unwrapped) ? unwrapped.join(',') : String(unwrapped);
        }
      }
      continue;
    }
    if (Array.isArray(rawVal)) {
      if (rawVal.length <= 12 && rawVal.every((x) => typeof x !== 'object')) {
        out[key] = rawVal.join(',');
      }
      continue;
    }
    if (typeof rawVal === 'object') {
      flattenConfig(rawVal, key, out, depth + 1);
    } else {
      out[key] = String(rawVal);
    }
  }
  return out;
}

/** Shell 参数分词器（支持单双引号与反斜杠续行）。 */
function tokenizeShellCommand(cmdText) {
  const cleaned = String(cmdText || '')
    .replace(/\\\r?\n/g, ' ')
    .replace(/\r?\n/g, ' ')
    .trim();
  const tokens = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return { tokens, normalizedCommand: cleaned };
}

/**
 * 解析真实 CS 训练命令（支持 env vars / torchrun / accelerate / deepspeed / argparse / Hydra overrides）。
 */
function parseCliCommand(cmdText) {
  const { tokens, normalizedCommand } = tokenizeShellCommand(cmdText);
  const envVars = {};
  const config = {};
  let launcher = '';
  let script = '';
  let idx = 0;

  // 1) 前置环境变量，如 CUDA_VISIBLE_DEVICES=0,1 OMP_NUM_THREADS=4
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
    const eq = tokens[idx].indexOf('=');
    envVars[tokens[idx].slice(0, eq)] = tokens[idx].slice(eq + 1);
    idx++;
  }

  // 2) 启动器与脚本识别
  const launcherHead = [];
  const launcherFlags = new Set(['--nproc_per_node', '--master_port', '--nnodes', '--num_processes', '--main_process_port', '-m']);
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (/\.(?:py|sh)$/i.test(tok)) {
      script = tok;
      idx++;
      break;
    }
    if (!launcher && /^(?:python3?|torchrun|accelerate|deepspeed|uv|conda|srun|bash|sh)$/i.test(tok)) {
      launcherHead.push(tok);
      idx++;
      continue;
    }
    if (launcherHead.length && (tok === 'launch' || tok === 'run')) {
      launcherHead.push(tok);
      idx++;
      continue;
    }
    if (launcherHead.length && tok.startsWith('-')) {
      const flagName = tok.split('=')[0];
      if (launcherFlags.has(flagName)) {
        launcherHead.push(tok);
        if (!tok.includes('=') && idx + 1 < tokens.length && !tokens[idx + 1].startsWith('-')) {
          launcherHead.push(tokens[++idx]);
        }
        idx++;
        continue;
      }
    }
    if (launcherHead.length && launcherHead[launcherHead.length - 1] === '-m') {
      script = tok;
      idx++;
      break;
    }
    break;
  }
  launcher = launcherHead.join(' ');

  // 3) 解析 --key val / --key=val / -k val / Hydra key=val / +exp=foo
  let syntaxStyle = 'argparse';
  const isHydraOverride = (t) => /^[+~]{0,2}[A-Za-z_][A-Za-z0-9_.-]*=/.test(String(t || ''));
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok === '--' || tok === '>' || tok === '2>&1' || tok === '|' || tok === '&&') break;
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq > 2) {
        const k = tok.slice(2, eq).trim();
        const v = tok.slice(eq + 1).trim();
        if (k) config[k] = v;
      } else {
        const k = tok.slice(2).trim();
        const next = tokens[idx + 1];
        if (next !== undefined && !next.startsWith('-') && !isHydraOverride(next) && !['>', '|', '&&', '2>&1'].includes(next)) {
          config[k] = next;
          idx++;
        } else if (k) {
          config[k] = 'true';
        }
      }
    } else if (/^-[A-Za-z]$/.test(tok)) {
      const k = tok.slice(1);
      const next = tokens[idx + 1];
      if (next !== undefined && !next.startsWith('-') && !isHydraOverride(next) && !['>', '|', '&&', '2>&1'].includes(next)) {
        config[k] = next;
        idx++;
      } else {
        config[k] = 'true';
      }
    } else if (isHydraOverride(tok)) {
      syntaxStyle = 'hydra';
      const eq = tok.indexOf('=');
      const k = tok.slice(0, eq).replace(/^[+~]+/, '');
      const v = tok.slice(eq + 1);
      if (k) config[k] = v;
    }
    idx++;
  }

  const gpuEnv = envVars.CUDA_VISIBLE_DEVICES || '';
  const gpuCount = gpuEnv ? gpuEnv.split(',').filter((x) => x.trim() !== '').length : 0;
  const seed = config.seed || config.random_seed || config['trainer.seed'] || '';

  return {
    ok: true,
    normalizedCommand,
    envVars,
    launcher,
    script,
    syntaxStyle,
    gpuCount,
    seed,
    config
  };
}

// ---------- 纯 JS 零依赖 TensorBoard .tfevents 二进制解析器 ----------
class ProtoReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  eof() { return this.pos >= this.buf.length; }
  readVarint() {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.buf.length) {
      const b = BigInt(this.buf[this.pos++]);
      result |= (b & 0x7Fn) << shift;
      if ((b & 0x80n) === 0n) return result;
      shift += 7n;
      if (shift > 64n) throw new Error('varint overflow');
    }
    throw new Error('truncated varint');
  }
  readTag() {
    const v = this.readVarint();
    return { fieldNumber: Number(v >> 3n), wireType: Number(v & 0x7n) };
  }
  readBytes() {
    const len = Number(this.readVarint());
    if (len < 0 || this.pos + len > this.buf.length) throw new Error('truncated bytes');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wireType) {
    if (wireType === 0) this.readVarint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) { const len = Number(this.readVarint()); this.pos += len; }
    else if (wireType === 5) this.pos += 4;
    else throw new Error('unknown wireType ' + wireType);
  }
}

function decodeTensorScalar(buf) {
  const r = new ProtoReader(buf);
  let dtype = 1; // DT_FLOAT
  let tensorContent = null;
  let floatVal = null;
  let doubleVal = null;
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === 0) dtype = Number(r.readVarint());
    else if (fieldNumber === 4 && wireType === 2) tensorContent = r.readBytes();
    else if (fieldNumber === 5 && wireType === 5) { floatVal = r.buf.readFloatLE(r.pos); r.pos += 4; }
    else if (fieldNumber === 5 && wireType === 2) {
      const packed = r.readBytes();
      if (packed.length >= 4) floatVal = packed.readFloatLE(0);
    } else if (fieldNumber === 6 && wireType === 1) { doubleVal = r.buf.readDoubleLE(r.pos); r.pos += 8; }
    else r.skip(wireType);
  }
  if (tensorContent) {
    if (dtype === 2 && tensorContent.length >= 8) return tensorContent.readDoubleLE(0);
    if (tensorContent.length >= 4) return tensorContent.readFloatLE(0);
  }
  if (floatVal !== null) return floatVal;
  if (doubleVal !== null) return doubleVal;
  return null;
}

function decodeSummaryValue(buf) {
  const r = new ProtoReader(buf);
  let tag = '';
  let val = null;
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === 2) tag = r.readBytes().toString('utf8');
    else if (fieldNumber === 3 && wireType === 5) { val = r.buf.readFloatLE(r.pos); r.pos += 4; }
    else if (fieldNumber === 8 && wireType === 2) {
      const tv = decodeTensorScalar(r.readBytes());
      if (tv !== null) val = tv;
    } else r.skip(wireType);
  }
  return { tag, value: val };
}

function decodeEventPayload(buf) {
  const r = new ProtoReader(buf);
  let step = 0;
  const scalars = [];
  while (!r.eof()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 2 && wireType === 0) step = Number(r.readVarint());
    else if (fieldNumber === 5 && wireType === 2) {
      const sr = new ProtoReader(r.readBytes());
      while (!sr.eof()) {
        const st = sr.readTag();
        if (st.fieldNumber === 1 && st.wireType === 2) {
          const item = decodeSummaryValue(sr.readBytes());
          if (item.tag && typeof item.value === 'number' && Number.isFinite(item.value)) {
            scalars.push(item);
          }
        } else sr.skip(st.wireType);
      }
    } else r.skip(wireType);
  }
  return { step, scalars };
}

/**
 * 纯 JS 解析 TensorBoard `.tfevents` 二进制 Buffer，提取所有标量曲线并生成 CSV 与最终/最优指标。
 */
function parseTfeventsBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) {
    return { ok: false, tags: [], rows: [], finalMetrics: {}, csvText: '', error: 'tfevents 文件过小或格式无效' };
  }
  const byStep = new Map();
  const tagSet = new Set();
  let offset = 0;
  let records = 0;

  while (offset + 12 <= buf.length && records < 50000) {
    const lenBig = buf.readBigUInt64LE(offset);
    const len = Number(lenBig);
    offset += 12; // 8-byte len + 4-byte crc
    if (len < 0 || offset + len + 4 > buf.length) break;
    const payload = buf.subarray(offset, offset + len);
    offset += len + 4; // payload + 4-byte data crc
    records++;
    try {
      const ev = decodeEventPayload(payload);
      if (!ev.scalars.length) continue;
      let row = byStep.get(ev.step);
      if (!row) { row = { step: ev.step }; byStep.set(ev.step, row); }
      ev.scalars.forEach(({ tag, value }) => {
        const cleanTag = tag.replace(/,/g, '_');
        tagSet.add(cleanTag);
        row[cleanTag] = Number(value.toFixed(6));
      });
    } catch (_) {
      // 忽略正在写入中的末尾半截事件块
    }
  }

  const tags = Array.from(tagSet);
  const rows = Array.from(byStep.values()).sort((a, b) => a.step - b.step);
  const finalMetrics = {};
  tags.forEach((tag) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i][tag] !== undefined) {
        finalMetrics[tag] = String(rows[i][tag]);
        break;
      }
    }
  });
  const csvText = rows.length && tags.length
    ? [['step', ...tags].join(','), ...rows.map((r) => [r.step, ...tags.map((t) => (r[t] !== undefined ? r[t] : ''))].join(','))].join('\n')
    : '';
  return { ok: rows.length > 0, tags, rows, finalMetrics, csvText, records };
}

/**
 * 解析 PyTorch / HuggingFace / tqdm / LIBERO / Gym 终端训练日志：
 * 提取每步曲线（CSV）+ 最终与最优指标 + 错误行告警。
 */
function parseTrainingLog(logText) {
  const raw = String(logText || '').slice(0, MAX_LOG_BYTES);
  const lines = raw.split(/\r?\n/);
  const rows = [];
  const metricSet = new Set();
  const finalMetrics = {};
  const bestMetrics = {};
  const errors = [];
  let autoStep = 0;

  const skipKeys = new Set(['http', 'https', 'file', 'line', 'rank', 'pid', 'gpu', 'cuda', 'port', 'it', 's', 'eta', 'time', 'date']);
  const isLowerBetter = (k) => /loss|err|error|mse|mae|rmse|ppl|perplexity|latency/i.test(k);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/cuda out of memory|outofmemoryerror|traceback|runtimeerror|nan\b|assertionerror/i.test(trimmed)) {
      if (errors.length < 15) errors.push(trimmed.slice(0, 220));
    }

    const row = {};
    // 1) HuggingFace Trainer 字典日志：{'loss': 0.42, 'learning_rate': 1e-4, 'epoch': 1.5}
    if (/\{['"][A-Za-z_][^}]+:\s*-?\d/.test(trimmed)) {
      const dictRe = /['"]([A-Za-z_][A-Za-z0-9_./-]{0,36})['"]\s*:\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi;
      let dm;
      while ((dm = dictRe.exec(trimmed))) {
        const k = dm[1];
        const v = Number(dm[2]);
        if (Number.isFinite(v) && !skipKeys.has(k.toLowerCase())) row[k] = v;
      }
    }

    // 2) 通用 key=val / key: val 日志（Epoch 5/50 | step=500 | train_loss: 0.23 | val_acc: 82.5%）
    const epochM = trimmed.match(/\bepoch\s*[:=\s]\s*(\d+(?:\.\d+)?)(?:\s*\/\s*\d+)?/i);
    if (epochM && row.epoch === undefined) row.epoch = Number(epochM[1]);
    const stepM = trimmed.match(/\b(?:global_)?step\s*[:=\s]\s*(\d+)/i);
    if (stepM && row.step === undefined) row.step = Number(stepM[1]);

    const kvRe = /\b([A-Za-z_][A-Za-z0-9_./-]{1,32})\s*[:=]\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?%?)/g;
    let m;
    while ((m = kvRe.exec(trimmed))) {
      const k = m[1];
      const kl = k.toLowerCase();
      if (skipKeys.has(kl)) continue;
      if (row[k] !== undefined) continue;
      const v = Number(m[2].replace(/%$/, ''));
      if (Number.isFinite(v)) row[k] = v;
    }

    const metricKeys = Object.keys(row).filter((k) => !/^(?:step|epoch|iter|iteration)$/i.test(k));
    if (metricKeys.length) {
      autoStep++;
      const xVal = row.step !== undefined ? row.step : (row.epoch !== undefined ? row.epoch : autoStep);
      const entry = { step: xVal, ...row };
      rows.push(entry);
      metricKeys.forEach((k) => {
        metricSet.add(k);
        finalMetrics[k] = String(row[k]);
        const curBest = bestMetrics[k];
        if (curBest === undefined || (isLowerBetter(k) ? row[k] < Number(curBest) : row[k] > Number(curBest))) {
          bestMetrics[k] = String(row[k]);
        }
      });
    }
  }

  const metricCols = Array.from(metricSet).slice(0, 16);
  const csvText = rows.length >= 2 && metricCols.length
    ? [['step', ...metricCols].join(','), ...rows.slice(0, 2000).map((r) => [r.step, ...metricCols.map((c) => (r[c] !== undefined ? r[c] : ''))].join(','))].join('\n')
    : '';

  return {
    ok: rows.length > 0 || errors.length > 0,
    rowCount: rows.length,
    metricCols,
    finalMetrics,
    bestMetrics,
    csvText,
    errors
  };
}

/** 递归收集目录下最多 2 层的文件，避免遍历海量数据集目录。 */
function collectRunFiles(rootDir, maxDepth = 3) {
  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth || found.length > 400) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '__pycache__' || ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        found.push({ name: ent.name, rel: path.relative(rootDir, full).replace(/\\/g, '/'), full });
      }
    }
  }
  walk(rootDir, 0);
  return found;
}

/**
 * 扫描真实 CS 训练输出目录（Hydra / W&B / HuggingFace / PyTorch Lightning / TensorBoard / Custom）。
 */
function scanRunDirectory(dirPath) {
  const target = String(dirPath || '').trim();
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error('运行目录不存在或不是有效文件夹：' + target);
  }
  const files = collectRunFiles(target, 3);
  const frameworks = new Set();
  const config = {};
  const metrics = {};
  const environment = {};
  const curves = []; // { fileName, csvText }
  const checkpoints = [];
  const logErrors = [];
  let command = '';

  const readTextSafe = (full, limit = MAX_LOG_BYTES) => {
    try {
      const st = fs.statSync(full);
      if (st.size > limit) {
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(limit);
        fs.readSync(fd, buf, 0, limit, st.size - limit);
        fs.closeSync(fd);
        return buf.toString('utf8');
      }
      return fs.readFileSync(full, 'utf8');
    } catch (_) { return ''; }
  };

  // 1) Hydra: .hydra/config.yaml + .hydra/overrides.yaml
  const hydraCfg = files.find((f) => /(?:^|\/)\.?hydra\/config\.ya?ml$/i.test(f.rel));
  if (hydraCfg) {
    frameworks.add('Hydra');
    Object.assign(config, flattenConfig(parseYamlSafe(readTextSafe(hydraCfg.full))));
  }
  const hydraOv = files.find((f) => /(?:^|\/)\.?hydra\/overrides\.ya?ml$/i.test(f.rel));
  if (hydraOv) {
    frameworks.add('Hydra');
    const ovText = readTextSafe(hydraOv.full);
    const ovLines = ovText.split(/\r?\n/).map((l) => l.replace(/^\s*-\s*/, '').trim()).filter((l) => l && !l.startsWith('#'));
    if (ovLines.length) {
      command = `python train.py ${ovLines.join(' ')}`;
      Object.assign(config, parseCliCommand(command).config);
    }
  }

  // 2) W&B Local: wandb-metadata.json / wandb-summary.json / config.yaml / wandb-history.jsonl
  const wandbMeta = files.find((f) => f.name.toLowerCase() === 'wandb-metadata.json');
  if (wandbMeta) {
    frameworks.add('W&B');
    try {
      const meta = JSON.parse(readTextSafe(wandbMeta.full));
      if (meta.python) environment.python = `Python ${meta.python}`;
      if (meta.os) environment.system = String(meta.os);
      if (meta.gpu) environment.system = [environment.system, meta.gpu].filter(Boolean).join(' · ');
      if (meta.git && meta.git.commit) environment.codeCommit = String(meta.git.commit).slice(0, 12);
      if (meta.program && Array.isArray(meta.args)) {
        command = `python ${meta.program} ${meta.args.join(' ')}`.trim();
        Object.assign(config, parseCliCommand(command).config);
      }
    } catch (_) { /* ignore */ }
  }
  const wandbSum = files.find((f) => f.name.toLowerCase() === 'wandb-summary.json');
  if (wandbSum) {
    frameworks.add('W&B');
    try {
      const sum = JSON.parse(readTextSafe(wandbSum.full));
      for (const [k, v] of Object.entries(sum || {})) {
        if (k.startsWith('_')) continue;
        if (typeof v === 'number' && Number.isFinite(v)) metrics[k] = String(Number(v.toFixed(6)));
      }
    } catch (_) { /* ignore */ }
  }

  // 3) 通用 config.yaml / hparams.yaml / args.json / config.json
  const genericCfgFiles = files.filter((f) => /^(?:config|hparams|args|hyperparams)\.(?:ya?ml|json)$/i.test(f.name) && f !== hydraCfg);
  for (const cf of genericCfgFiles.slice(0, 3)) {
    if (/hparams/i.test(cf.name)) frameworks.add('PyTorch Lightning');
    const txt = readTextSafe(cf.full);
    if (/\.json$/i.test(cf.name)) {
      try { Object.assign(config, flattenConfig(JSON.parse(txt))); } catch (_) { /* ignore */ }
    } else {
      Object.assign(config, flattenConfig(parseYamlSafe(txt)));
    }
  }

  // 4) HuggingFace Transformers: trainer_state.json + eval_results.json / all_results.json
  const hfState = files.find((f) => f.name.toLowerCase() === 'trainer_state.json');
  if (hfState) {
    frameworks.add('HuggingFace Trainer');
    try {
      const st = JSON.parse(readTextSafe(hfState.full));
      if (st.best_metric != null && Number.isFinite(Number(st.best_metric))) {
        metrics.best_metric = String(st.best_metric);
      }
      if (Array.isArray(st.log_history) && st.log_history.length) {
        const colSet = new Set();
        st.log_history.forEach((entry) => {
          if (!entry || typeof entry !== 'object') return;
          for (const [k, v] of Object.entries(entry)) {
            if (typeof v === 'number' && Number.isFinite(v)) {
              if (k !== 'step' && k !== 'epoch') {
                colSet.add(k);
                metrics[k] = String(Number(v.toFixed(6)));
              }
            }
          }
        });
        const cols = Array.from(colSet).slice(0, 14);
        if (cols.length) {
          const csvLines = [['step', ...cols].join(',')];
          st.log_history.forEach((entry, idx) => {
            const x = entry.step !== undefined ? entry.step : (entry.epoch !== undefined ? entry.epoch : idx + 1);
            csvLines.push([x, ...cols.map((c) => (entry[c] !== undefined ? entry[c] : ''))].join(','));
          });
          curves.push({ fileName: 'hf_trainer_curve.csv', csvText: csvLines.join('\n') });
        }
      }
    } catch (_) { /* ignore */ }
  }
  const evalJsonFiles = files.filter((f) => /^(?:eval_results|all_results|test_results|metrics|results)\.json$/i.test(f.name));
  for (const ef of evalJsonFiles.slice(0, 3)) {
    try {
      const obj = JSON.parse(readTextSafe(ef.full));
      for (const [k, v] of Object.entries(obj || {})) {
        if (typeof v === 'number' && Number.isFinite(v)) metrics[k] = String(Number(v.toFixed(6)));
      }
    } catch (_) { /* ignore */ }
  }

  // 5) TensorBoard: events.out.tfevents.*
  const tfFiles = files.filter((f) => /events\.out\.tfevents/i.test(f.name));
  for (const tf of tfFiles.slice(0, 2)) {
    try {
      const st = fs.statSync(tf.full);
      if (st.size > 0 && st.size <= MAX_TFEVENTS_BYTES) {
        const parsedTf = parseTfeventsBuffer(fs.readFileSync(tf.full));
        if (parsedTf.ok) {
          frameworks.add('TensorBoard');
          Object.assign(metrics, parsedTf.finalMetrics);
          if (parsedTf.csvText) curves.push({ fileName: 'tfevents_scalars.csv', csvText: parsedTf.csvText });
        }
      }
    } catch (_) { /* ignore */ }
  }

  // 6) CSV / JSONL 指标文件（PyTorch Lightning metrics.csv / wandb-history.jsonl）
  const csvFiles = files.filter((f) => /^(?:metrics|results|eval|history|log)\.(?:csv|tsv)$/i.test(f.name) || /\.csv$/i.test(f.name));
  if (csvFiles.length) {
    const firstCsv = csvFiles[0];
    if (/metrics\.csv$/i.test(firstCsv.name)) frameworks.add('PyTorch Lightning');
    const txt = readTextSafe(firstCsv.full);
    if (txt) {
      curves.push({ fileName: firstCsv.name, csvText: txt });
      const lines = txt.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length >= 2) {
        const sep = /\.tsv$/i.test(firstCsv.name) ? '\t' : ',';
        const headers = lines[0].split(sep).map((h) => h.trim().replace(/^"|"$/g, ''));
        const lastCells = lines[lines.length - 1].split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
        headers.forEach((h, i) => {
          if (/^(?:step|epoch|iter|id)$/i.test(h)) return;
          const n = Number(lastCells[i]);
          if (h && lastCells[i] !== '' && Number.isFinite(n)) metrics[h] = String(n);
        });
      }
    }
  }

  // 7) 文本日志（*.log / train.txt）
  const logFiles = files.filter((f) => /\.(?:log|out)$/i.test(f.name) || /^train.*\.txt$/i.test(f.name));
  for (const lf of logFiles.slice(0, 2)) {
    const parsedLog = parseTrainingLog(readTextSafe(lf.full));
    if (parsedLog.ok) {
      Object.entries(parsedLog.finalMetrics).forEach(([k, v]) => {
        if (metrics[k] === undefined) metrics[k] = v;
      });
      if (parsedLog.csvText && !curves.length) {
        curves.push({ fileName: 'parsed_log_curve.csv', csvText: parsedLog.csvText });
      }
      parsedLog.errors.forEach((e) => logErrors.push(e));
    }
  }

  // 8) 权重 Checkpoint 清单（只记录路径与体积，绝不复制数 GB 权重文件！）
  files.filter((f) => /\.(?:pt|pth|ckpt|safetensors|onnx|bin)$/i.test(f.name) && !/training_args\.bin$/i.test(f.name))
    .slice(0, 20)
    .forEach((f) => {
      try {
        const sizeMb = Number((fs.statSync(f.full).size / (1024 * 1024)).toFixed(2));
        checkpoints.push({ name: f.name, relPath: f.rel, sizeMb });
      } catch (_) { /* ignore */ }
    });

  // 限制 config 键数避免巨型 Hydra 全量树淹没界面（优先保留关键超参）
  const prunedConfig = {};
  const entries = Object.entries(config);
  entries.slice(0, 36).forEach(([k, v]) => { prunedConfig[k] = String(v).slice(0, 120); });

  return {
    ok: true,
    runDir: target,
    dirName: path.basename(target),
    frameworks: Array.from(frameworks),
    command,
    config: prunedConfig,
    metrics,
    environment,
    curves,
    checkpoints,
    logErrors,
    scannedFileCount: files.length
  };
}

/**
 * 抓取本地代码仓库的 Git 快照 + 未提交改动 Diff（纯只读命令，不修改仓库）。
 */
function captureCodeSnapshot(codeDir) {
  const dir = String(codeDir || '').trim();
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('代码仓库路径不存在：' + dir);
  }
  const commitShort = runGitReadOnly(['rev-parse', '--short', 'HEAD'], dir);
  if (!commitShort.ok) {
    return { ok: false, error: '目标目录不是有效的 Git 仓库', codeDir: dir };
  }
  const commitFull = runGitReadOnly(['rev-parse', 'HEAD'], dir);
  const branch = runGitReadOnly(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  const subject = runGitReadOnly(['log', '-1', '--pretty=%s'], dir);
  const remote = runGitReadOnly(['config', '--get', 'remote.origin.url'], dir);
  const status = runGitReadOnly(['status', '--porcelain'], dir);
  const diffStat = runGitReadOnly(['diff', '--stat', 'HEAD'], dir);
  const diffRaw = runGitReadOnly(['diff', 'HEAD'], dir);
  const diffPatch = diffRaw.ok ? diffRaw.output.slice(0, MAX_DIFF_BYTES) : '';

  return {
    ok: true,
    codeDir: dir,
    branch: branch.output || '',
    commit: commitShort.output || '',
    commitFull: commitFull.output || '',
    commitMessage: subject.output || '',
    remoteUrl: remote.output || '',
    dirty: Boolean(status.ok && status.output),
    diffStat: diffStat.output || '',
    diffPatch,
    diffTruncated: Boolean(diffRaw.ok && diffRaw.output.length > MAX_DIFF_BYTES)
  };
}

/** 对比同一代码仓库内两个实验提交之间的代码变更摘要。 */
function compareCodeCommits(codeDir, commitA, commitB) {
  const dir = String(codeDir || '').trim();
  const a = String(commitA || '').trim().split(/\s+/)[0];
  const b = String(commitB || '').trim().split(/\s+/)[0];
  if (!dir || !a || !b || !/^[0-9a-f]{4,40}$/i.test(a) || !/^[0-9a-f]{4,40}$/i.test(b)) {
    return { ok: false, error: '需要同一代码仓与合法的两个 Git Commit 哈希' };
  }
  const stat = runGitReadOnly(['diff', '--stat', `${a}..${b}`], dir);
  const patch = runGitReadOnly(['diff', `${a}..${b}`], dir);
  if (!stat.ok) return { ok: false, error: stat.error || 'git diff 执行失败' };
  return {
    ok: true,
    commitA: a,
    commitB: b,
    diffStat: stat.output || '（两个提交之间无代码差异）',
    diffPatch: (patch.output || '').slice(0, MAX_DIFF_BYTES)
  };
}

/**
 * 超参 Sweep 笛卡尔网格与集群执行脚本生成器（支持 Bash / Multi-GPU 队列 / tmux / Slurm Array / Hydra multirun）。
 */
function generateSweepMatrix(baseCmd, axesInput = [], opts = {}) {
  const parsed = parseCliCommand(baseCmd || 'python train.py');
  const style = opts.syntaxStyle || parsed.syntaxStyle || 'argparse';
  const gpus = String(opts.gpus || parsed.envVars.CUDA_VISIBLE_DEVICES || '0').split(',').map((s) => s.trim()).filter(Boolean);
  const sessionName = String(opts.sessionName || 'cs_sweep').replace(/[^A-Za-z0-9_-]/g, '_');

  const axes = (Array.isArray(axesInput) ? axesInput : [])
    .map((ax) => ({
      key: String((ax && ax.key) || '').trim(),
      values: Array.isArray(ax && ax.values)
        ? ax.values.map((v) => String(v).trim()).filter(Boolean)
        : String((ax && ax.values) || '').split(/[,，\s]+/).map((v) => v.trim()).filter(Boolean)
    }))
    .filter((ax) => ax.key && ax.values.length);

  if (!axes.length) {
    throw new Error('请至少提供 1 个有效的超参 Sweep 维度（如 lr: 1e-4, 3e-4）');
  }

  let combos = [{}];
  for (const ax of axes) {
    const next = [];
    for (const c of combos) {
      for (const val of ax.values) {
        if (next.length >= 64) break;
        next.push({ ...c, [ax.key]: val });
      }
      if (next.length >= 64) break;
    }
    combos = next;
  }

  const applyOverrides = (cmd, overrides) => {
    let out = String(cmd || 'python train.py').trim();
    for (const [k, v] of Object.entries(overrides)) {
      if (style === 'hydra') {
        const re = new RegExp(`(\\b\\+*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=)([^\\s]+)`);
        out = re.test(out) ? out.replace(re, `$1${v}`) : `${out} ${k}=${v}`;
      } else {
        const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const reEq = new RegExp(`(--${escaped}=)([^\\s]+)`);
        const reSp = new RegExp(`(--${escaped}\\s+)([^\\s]+)`);
        if (reEq.test(out)) out = out.replace(reEq, `$1${v}`);
        else if (reSp.test(out)) out = out.replace(reSp, `$1${v}`);
        else out = `${out} --${k} ${v}`;
      }
    }
    return out;
  };

  const runs = combos.map((overrides, idx) => {
    const tag = Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join('_');
    const command = applyOverrides(parsed.normalizedCommand || 'python train.py', overrides);
    return {
      index: idx,
      name: `Sweep #${idx + 1} (${Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join(', ')})`,
      slug: `run_${String(idx + 1).padStart(2, '0')}_${tag.replace(/[^A-Za-z0-9_.-]/g, '_')}`,
      overrides,
      mergedConfig: { ...parsed.config, ...overrides },
      command
    };
  });

  const bashScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `mkdir -p logs/${sessionName}`,
    ...runs.map((r) => `echo "[${r.index + 1}/${runs.length}] ${r.slug}"\n${r.command} 2>&1 | tee "logs/${sessionName}/${r.slug}.log"`)
  ].join('\n\n');

  const multiGpuLines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `GPUS=(${gpus.join(' ')})`,
    `mkdir -p logs/${sessionName}`,
    'CMDS=(',
    ...runs.map((r) => `  ${JSON.stringify(r.command)}`),
    ')',
    'NAMES=(',
    ...runs.map((r) => `  ${JSON.stringify(r.slug)}`),
    ')',
    'NUM_GPUS=${#GPUS[@]}',
    'for ((g=0; g<NUM_GPUS; g++)); do',
    '  (',
    '    GPU_ID="${GPUS[$g]}"',
    '    for ((i=g; i<${#CMDS[@]}; i+=NUM_GPUS)); do',
    '      echo "[GPU ${GPU_ID}] Running ${NAMES[$i]}"',
    `      CUDA_VISIBLE_DEVICES="\${GPU_ID}" eval "\${CMDS[$i]}" > "logs/${sessionName}/\${NAMES[$i]}.log" 2>&1`,
    '    done',
    '  ) &',
    'done',
    'wait',
    'echo "All sweep runs finished."'
  ];

  const tmuxScript = [
    `tmux new-session -d -s "${sessionName}" "bash run_sweep.sh; exec bash"`,
    `tmux attach -t "${sessionName}"`
  ].join('\n');

  const slurmScript = [
    '#!/usr/bin/env bash',
    `#SBATCH --job-name=${sessionName}`,
    `#SBATCH --array=0-${Math.max(0, runs.length - 1)}`,
    '#SBATCH --gres=gpu:1',
    '#SBATCH --cpus-per-task=8',
    `#SBATCH --output=logs/${sessionName}_%A_%a.out`,
    '',
    'CMDS=(',
    ...runs.map((r) => `  ${JSON.stringify(r.command)}`),
    ')',
    'eval "${CMDS[$SLURM_ARRAY_TASK_ID]}"'
  ].join('\n');

  const hydraMultirunCmd = `${parsed.launcher || 'python'} ${parsed.script || 'train.py'} -m ${axes.map((a) => `${a.key}=${a.values.join(',')}`).join(' ')}`.trim();

  return {
    ok: true,
    syntaxStyle: style,
    totalRuns: runs.length,
    truncated: runs.length >= 64,
    runs,
    bashScript,
    multiGpuScript: multiGpuLines.join('\n'),
    tmuxScript,
    slurmScript,
    hydraMultirunCmd
  };
}

module.exports = {
  parseYamlSafe,
  flattenConfig,
  parseCliCommand,
  parseTfeventsBuffer,
  parseTrainingLog,
  scanRunDirectory,
  captureCodeSnapshot,
  compareCodeCommits,
  generateSweepMatrix
};
