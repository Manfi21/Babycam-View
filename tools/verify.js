"use strict";

const { app, BrowserWindow } = require("electron");

const URL = process.argv[2] || "http://babycam.local:8889/cam_with_audio/";

function probe() {
    return `(() => {
        const v = document.querySelector("video");
        if (!v) return { noVideo: true };
        return {
            readyState: v.readyState,
            paused: v.paused,
            currentTime: v.currentTime,
            duration: v.duration,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            error: v.error ? (v.error.code + " " + v.error.message) : null,
            src: (v.src || "").slice(0, 80),
            connected: typeof v.srcObject !== "undefined" ? (v.srcObject ? "srcObject" : "none") : "n/a",
            tracks: v.srcObject ? v.srcObject.getTracks().map(t => t.kind + ":" + (t.readyState)) : [],
        };
    })()`;
}

app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 1000,
        height: 700,
        show: false,
        webPreferences: { sandbox: true },
    });

    win.webContents.on("did-fail-load", (_e, code, desc, url) => {
        console.log(JSON.stringify({ stage: "did-fail-load", code, desc, url }));
        app.quit();
    });

    win.webContents.on("console-message", (_e, level, msg) => {
        console.log(JSON.stringify({ stage: "console", level, msg: msg.slice(0, 200) }));
    });

    win.webContents.on("did-finish-load", () => {
        console.log(JSON.stringify({ stage: "loaded", url: win.webContents.getURL() }));
        setTimeout(async () => {
            const r1 = await win.webContents.executeJavaScript(probe()).catch(e => ({ evalError: String(e) }));
            console.log(JSON.stringify({ stage: "t0", result: r1 }));
            setTimeout(async () => {
                const r2 = await win.webContents.executeJavaScript(probe()).catch(e => ({ evalError: String(e) }));
                console.log(JSON.stringify({ stage: "t+5s", result: r2 }));
                app.quit();
            }, 5000);
        }, 10000);
    });

    win.loadURL(URL);
});
