"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("babycam", {
    invoke: (cmd, payload) => ipcRenderer.invoke(cmd, payload),
    onProgress: (cb) => {
        ipcRenderer.on("connect-progress", (_e, message) => cb(message));
    },
});
