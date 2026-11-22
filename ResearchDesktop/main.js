/**
 * main.js — Electron 主进程入口
 * 窗口管理 + IPC dispatch（store / ai / dialog / shell）
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./src/main/store');
const ai = require('./src/main/ai');
const openalex = require('./src/main/openalex');
const rating = require('./src/main/rating');
const skills = require('./src/main/search/skills');
const lineageService = require('./src/main/services/lineage-service');
const ideaService = require('./src/main/services/idea-service');
const experimentService = require('./src/main/services/experiment-service');

let win = null;

function winBgColor() {
  const ui = (store.getConfig().ui || {});
  return (ui.theme || 'classic') === 'neo' ? '#090d18' : '#f5f6f8';
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    title: '科研台',
    backgroundColor: winBgColor(),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  // 隐藏 Electron 默认的 File/Edit/View 菜单栏
  win.setMenu(null);
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'src/renderer/index.html'));
  // 转发渲染进程日志，便于无头环境验证
  win.webContents.on('console-message', (event, level, message, line, source) => {
    console.log(`[renderer:${level}] ${message} (${source}:${line})`);
  });
  win.webContents.on('render-process-gone', (event, details) => {
    console.log('[renderer-gone]', JSON.stringify(details));
  });
  if (process.argv.includes('--dev')) win.webContents.openDevTools();

  // 无头截图验证：node start.js --shot[=绝对路径] 加载完成后截图并退出
  const shotArg = process.argv.find((a) => a === '--shot' || a.startsWith('--shot='));
  if (shotArg) {
    const out = shotArg.includes('=') ? shotArg.slice(shotArg.indexOf('=') + 1) : path.join(__dirname, 'shot.png');
    const shotAction = (process.argv.find((a) => a.startsWith('--shot-action=')) || '').split('=').slice(1).join('=');
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // QA 增补（严过关）：stats / claim / stats-classic 仅用于无头截图验证，
          // 不改动业务逻辑；stats-classic 只切 body class（不写 app-config）。
          const actions = {
            cmdk: `document.querySelector('#cmdBtn')?.click()`,
            help: `document.querySelector('#helpBtn')?.click()`,
            classic: `document.querySelector('#themeToggleBtn')?.click()`,
            empty: `document.querySelector('#detailRoot').innerHTML='';document.querySelector('#detailEmpty').style.display='flex'`,
            stats: `document.querySelector('#statsBtn')?.click()`,
            claim: `(()=>{document.querySelector('#cmdBtn')?.click();const i=document.querySelector('#cmdkInput');if(i){i.value='论断中心';i.dispatchEvent(new Event('input',{bubbles:true}));}const it=document.querySelector('#cmdkList .cmdk-item');if(it)it.click();})()`,
            'stats-classic': `(()=>{document.body.classList.remove('theme-neo');document.querySelector('#statsBtn')?.click();})()`,
            // QA 增补（严过关，v3 验证）：仅用于无头截图，点击入口按钮打开宽模态，不改业务逻辑。
            discovery: `document.querySelector('.board-tab[data-board="discovery"]')?.click()`,
            idea: `document.querySelector('.board-tab[data-board="ideas"]')?.click()`,
            experiment: `document.querySelector('.board-tab[data-board="experiments"]')?.click()`,
            timeline: `document.querySelector('#timelineBtn')?.click()`
          };
          if (actions[shotAction]) {
            await win.webContents.executeJavaScript(actions[shotAction]);
            const waitMs = (shotAction === 'stats' || shotAction === 'claim' || shotAction === 'stats-classic') ? 900
              : (shotAction === 'timeline' || shotAction === 'discovery' || shotAction === 'idea' || shotAction === 'experiment') ? 1500 : 450;
            await new Promise((r) => setTimeout(r, waitMs));
            // QA 增补：在无头环境回读脉络图 DOM，提供节点数/边数硬证据（只读取，不写入）。
            if (shotAction === 'timeline') {
              const chk = await win.webContents.executeJavaScript(`(()=>{
                const svg=document.querySelector('.timeline-svg');
                const nodes=document.querySelectorAll('.timeline-node').length;
                const edges=document.querySelectorAll('.timeline-edge').length;
                console.log('TIMELINE_CHECK nodeCount='+nodes+' svg='+(svg?1:0)+' edges='+edges);
                return {nodes,edges,svg:!!svg};
              })()`);
              console.log('TIMELINE_CHECK_RESULT', JSON.stringify(chk));
            }
          }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(out, img.toPNG());
          console.log('SHOT_OK', out);
        } catch (e) {
          console.log('SHOT_FAIL', e && e.message);
        }
        app.quit();
      }, 2500);
    });
  }
}

app.whenReady().then(() => {
  store.init();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC ----------
ipcMain.handle('store:call', async (event, method, ...args) => {
  try {
    if (typeof store[method] !== 'function') throw new Error('未知方法：' + method);
    const result = await store[method](...args);
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('ai:call', async (event, method, ...args) => {
  try {
    if (typeof ai[method] !== 'function') throw new Error('未知方法：' + method);
    const result = await ai[method](...args);
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// 服务层白名单 dispatch：渲染层只能调用已登记模块的公开方法，避免任意模块调用。
// openalex / rating 单向依赖 store / ai，挂在此处不会与 ai:call 形成循环依赖。
const SERVICES = { openalex, rating };
const ALL_SERVICES = Object.assign({}, SERVICES, {
  skills,
  lineage: lineageService,
  idea: ideaService,
  experiment: experimentService
});
ipcMain.handle('service:call', async (event, service, method, ...args) => {
  try {
    const mod = ALL_SERVICES[service];
    if (!mod) throw new Error('未知服务：' + service);
    if (typeof mod[method] !== 'function') throw new Error('未知方法：' + service + '.' + method);
    const result = await mod[method](...args);
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('env:capture', async (_event, opts) => {
  try {
    return experimentService.captureEnvironment(opts);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('dialog:openFiles', async (event, opts = {}) => {
  const props = opts.multi ? ['openFile', 'multiSelections'] : ['openFile'];
  if (opts.directory) props[0] = 'openDirectory';
  const res = await dialog.showOpenDialog(win, {
    properties: props,
    filters: opts.filters || undefined,
    title: opts.title || '选择文件'
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('shell:open', async (event, target) => {
  try {
    if (target && target.startsWith('http')) {
      await shell.openExternal(target);
    } else {
      await shell.openPath(target);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('app:dataRoot', async () => store.DATA_ROOT);

ipcMain.handle('app:setBackground', async (event, theme) => {
  if (win) win.setBackgroundColor(theme === 'neo' ? '#090d18' : '#f5f6f8');
  return true;
});

// 无边框窗口控制
ipcMain.handle('win:minimize', () => { if (win) win.minimize(); return true; });
ipcMain.handle('win:maximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('win:close', () => { if (win) win.close(); return true; });
