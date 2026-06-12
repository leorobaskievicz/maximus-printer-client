'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hub', {
  login:          (data)   => ipcRenderer.invoke('login', data),
  logout:         ()       => ipcRenderer.invoke('logout'),
  getPrinters:    ()       => ipcRenderer.invoke('get-printers'),
  getHubPrinters: ()       => ipcRenderer.invoke('get-hub-printers'),
  updatePrinter:  (data)   => ipcRenderer.invoke('update-printer', data),
  syncPrinters:   ()       => ipcRenderer.invoke('sync-printers'),
  getStore:       (key)    => ipcRenderer.invoke('get-store', key),
  getPdfScaleMap: ()       => ipcRenderer.invoke('get-pdf-scale-map'),
  setPdfScale:    (data)   => ipcRenderer.invoke('set-pdf-scale', data),
  printTestLabel: (data)   => ipcRenderer.invoke('print-test-label', data),
})
