(function () {
    "use strict";

    if (window.babycam) return;
    if (typeof window.nativeBridge !== "object") return;

    window.__bcNextId = 1;
    window.__bcPending = {};
    window.__bcProgressCb = null;

    window.__bcResolve = function (id, err, result) {
        var p = window.__bcPending[id];
        if (!p) return;
        delete window.__bcPending[id];
        if (err) { p.reject(new Error(err)); return; }
        var val = result;
        if (typeof result === "string") {
            try { val = JSON.parse(result); } catch (e) {}
        }
        p.resolve(val);
    };

    window.__bcProgress = function (msg) {
        if (window.__bcProgressCb) window.__bcProgressCb(msg);
    };

    window.babycam = {
        invoke: function (cmd, payload) {
            return new Promise(function (resolve, reject) {
                var id = window.__bcNextId++;
                window.__bcPending[id] = { resolve: resolve, reject: reject };
                var arg = JSON.stringify(payload === undefined ? null : payload);
                window.nativeBridge.invoke(id + "\u0000" + cmd + "\u0000" + arg);
            });
        },
        onProgress: function (cb) {
            window.__bcProgressCb = cb;
        }
    };
})();
