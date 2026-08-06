"use strict";

const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("path");
const net = require("net");
const http = require("http");
const { URL } = require("url");

const PORT = 80;
const CONNECT_TIMEOUT_MS = 1800;

let mainWindow = null;
let lastCameraUrl = null;

function settingsHome() {
    return `file://${path.join(__dirname, "..", "src", "index.html").replace(/\\/g, "/")}?manual=1`;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 750,
        backgroundColor: "#0b0e14",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    mainWindow.webContents.on("did-navigate", (_e, url) => {
        console.log("[main] did-navigate ->", url);
    });

    mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));
}

function settingsPath() {
    return path.join(app.getPath("userData"), "settings.json");
}

function defaultSettings() {
    return {
        active: "BabyCam",
        profiles: [{ name: "BabyCam", hostname: "babycam", local_ip: "", tailscale_ip: "" }],
    };
}

function normalizeSettings(settings) {
    if (!settings || !Array.isArray(settings.profiles) || settings.profiles.length === 0) {
        return defaultSettings();
    }
    if (!settings.profiles.some((p) => p && p.name === settings.active)) {
        settings.active = settings.profiles[0].name;
    }
    return settings;
}

function loadSettings() {
    try {
        const content = require("fs").readFileSync(settingsPath(), "utf8");
        const parsed = JSON.parse(content);
        if (parsed && Array.isArray(parsed.profiles)) return normalizeSettings(parsed);
        if (parsed) {
            const name = parsed.hostname || "BabyCam";
            return {
                active: name,
                profiles: [{ name, hostname: parsed.hostname || "", local_ip: parsed.local_ip || "", tailscale_ip: parsed.tailscale_ip || "" }],
            };
        }
    } catch (e) {
        /* no settings yet */
    }
    return defaultSettings();
}

function saveSettings(settings) {
    const fs = require("fs");
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(normalizeSettings(settings), null, 2), "utf8");
}

function checkTarget(addr) {
    return new Promise((resolve) => {
        const socket = net.connect({ port: PORT, host: addr, timeout: CONNECT_TIMEOUT_MS });
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => { socket.destroy(); resolve(false); });
        socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
}

async function testConnection(profile) {
    const candidates = [];
    const hostname = (profile.hostname || "").trim();
    if (hostname) {
        candidates.push(hostname);
        if (!hostname.includes(".")) candidates.push(hostname + ".local");
    }
    if ((profile.local_ip || "").trim()) candidates.push(profile.local_ip.trim());
    if ((profile.tailscale_ip || "").trim()) candidates.push(profile.tailscale_ip.trim());

    const errors = [];
    for (const candidate of candidates) {
        const addr = `${candidate}:${PORT}`;
        sendProgress(`Checking ${addr} ...`);
        if (await checkTarget(candidate)) {
            sendProgress(`Connected to ${addr}`);
            return { ok: true, url: `http://${addr}/`, winner: candidate, errors };
        }
        errors.push(`${candidate}:${PORT} not reachable`);
    }
    if (candidates.length === 0) {
        errors.push("Please provide at least one address (hostname, local IP or Tailscale IP).");
    }
    return { ok: false, url: null, winner: null, errors };
}

function httpGet(url, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
    });
}

const PLACEHOLDERS = ["No IP", "Not connected", "unknown"];

function cleanValue(value) {
    const trimmed = (value || "").trim();
    if (!trimmed || PLACEHOLDERS.some((p) => trimmed.toLowerCase() === p.toLowerCase())) return "";
    return trimmed;
}

function extractField(html, start, end) {
    const i = html.indexOf(start);
    if (i < 0) return "";
    const rest = html.slice(i + start.length);
    const j = rest.indexOf(end);
    return j < 0 ? "" : rest.slice(0, j).trim();
}

async function fetchNetworkInfo(url) {
    const base = url.replace(/\/+$/, "");
    const info = { hostname: "", ip: "", ip_tailscale: "" };

    const api = await httpGet(`${base}/api/network`);
    if (api) {
        try {
            const parsed = JSON.parse(api);
            info.hostname = cleanValue(parsed.hostname);
            info.ip = cleanValue(parsed.ip);
            info.ip_tailscale = cleanValue(parsed.ip_tailscale);
        } catch (e) { /* fall through */ }
    }

    if (!info.hostname && !info.ip && !info.ip_tailscale) {
        const html = await httpGet(`${base}/settings`);
        if (html) {
            info.hostname = cleanValue(extractField(html, 'id="hostnameInput" value="', '"'));
            info.ip = cleanValue(extractField(html, "IP Address</span> <strong>", "</strong>"));
            info.ip_tailscale = cleanValue(extractField(html, "Tailscale IP Address</span> <strong>", "</strong>"));
        }
    }
    return info;
}

function sendProgress(message) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("connect-progress", message);
    }
}

function createMenu() {
    const template = [
        {
            label: "BabyCam",
            submenu: [
                {
                    label: "Camera",
                    accelerator: "Alt+C",
                    enabled: !!lastCameraUrl,
                    click: () => {
                        if (lastCameraUrl && mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(lastCameraUrl);
                    },
                },
                { label: "Settings", accelerator: "CmdOrCtrl+Shift+S", click: () => { mainWindow.loadURL(settingsHome()); } },
                { type: "separator" },
                { role: "quit", label: "Quit" },
            ],
        },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("load_settings", () => loadSettings());
ipcMain.handle("save_settings", (_e, settings) => saveSettings(settings));
ipcMain.handle("test_connection", (_e, profile) => testConnection(profile || {}));
ipcMain.handle("fetch_network_info", (_e, url) => fetchNetworkInfo(String(url || "")));
ipcMain.handle("navigate_to", (_e, url) => {
    console.log("[main] navigate_to ->", url);
    lastCameraUrl = String(url || "");
    createMenu();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(url);
});

app.whenReady().then(() => {
    createMenu();
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
