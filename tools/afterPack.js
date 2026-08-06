"use strict";

const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
    const localesDir = path.join(context.appOutDir, "locales");
    try {
        for (const f of fs.readdirSync(localesDir)) {
            if (f === "en-US.pak") continue;
            fs.rmSync(path.join(localesDir, f), { force: true });
        }
    } catch (e) { /* locales dir optional */ }

    const defaultApp = path.join(context.appOutDir, "resources", "default_app.asar");
    if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp, { force: true });
};
