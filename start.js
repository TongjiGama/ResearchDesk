/**
 * start.js — 跨平台启动器
 * 清除可能继承的 ELECTRON_RUN_AS_NODE 环境变量后启动 Electron。
 * 这样无论从普通终端还是开发环境终端，npm start 都能正确打开 GUI。
 */
const { spawn } = require('child_process');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const electron = require('electron');
const extra = process.argv.slice(2).filter((a) => a === '--dev' || a.startsWith('--shot'));
const args = [path.join(__dirname, 'main.js'), ...extra];

const child = spawn(electron, args, { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code == null ? 0 : code));
child.on('error', (err) => {
  console.error('启动失败：', err.message);
  process.exit(1);
});
