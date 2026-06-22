const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  checkDeps:     ()     => ipcRenderer.invoke('check-deps'),
  listDevices:   ()     => ipcRenderer.invoke('list-devices'),
  selectFolder:  ()     => ipcRenderer.invoke('select-folder'),
  startCapture:  (opts) => ipcRenderer.invoke('start-capture', opts),
  stopCapture:   ()     => ipcRenderer.invoke('stop-capture'),

  onCaptureOutput:   (cb) => ipcRenderer.on('capture-output',   (_, d) => cb(d)),
  onCaptureProgress: (cb) => ipcRenderer.on('capture-progress', (_, d) => cb(d)),
  onCaptureEnded:    (cb) => ipcRenderer.on('capture-ended',    (_, d) => cb(d)),

  removeListeners: (channel) => ipcRenderer.removeAllListeners(channel),
})
