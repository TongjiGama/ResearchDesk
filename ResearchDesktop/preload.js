/**
 * preload.js — 安全 IPC 桥
 * 向渲染进程暴露 store / ai / dialog / shell 调用。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  store: {
    call: (method, ...args) => ipcRenderer.invoke('store:call', method, ...args)
  },
  ai: {
    call: (method, ...args) => ipcRenderer.invoke('ai:call', method, ...args)
  },
  service: {
    call: (service, method, ...args) => ipcRenderer.invoke('service:call', service, method, ...args)
  },
  env: {
    capture: (opts) => ipcRenderer.invoke('env:capture', opts)
  },
  dialog: {
    openFiles: (opts) => ipcRenderer.invoke('dialog:openFiles', opts)
  },
  shell: {
    open: (target) => ipcRenderer.invoke('shell:open', target)
  },
  app: {
    dataRoot: () => ipcRenderer.invoke('app:dataRoot'),
    setBackground: (theme) => ipcRenderer.invoke('app:setBackground', theme)
  },
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close')
  }
});
