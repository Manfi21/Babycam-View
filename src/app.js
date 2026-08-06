(function () {
    "use strict";

    const API = window.babycam;

    if (!API || !API.invoke) {
        const statusEl = document.getElementById("status");
        statusEl.className = "status err";
        statusEl.textContent = "BabyCam bridge not available.";
        return;
    }
    const invoke = API.invoke;

    const els = {
        form: document.getElementById("settingsForm"),
        cameraName: document.getElementById("cameraName"),
        hostname: document.getElementById("hostname"),
        localIp: document.getElementById("localIp"),
        tailscaleIp: document.getElementById("tailscaleIp"),
        profileSelect: document.getElementById("profileSelect"),
        saveProfileBtn: document.getElementById("saveProfileBtn"),
        newProfileBtn: document.getElementById("newProfileBtn"),
        deleteProfileBtn: document.getElementById("deleteProfileBtn"),
        connectBtn: document.getElementById("connectBtn"),
        status: document.getElementById("status"),
    };

    let profiles = [];
    let activeName = null;
    let testing = false;
    let deleteArmed = false;
    let deleteTimer = null;

    function setStatus(kind, html) {
        els.status.className = "status " + kind;
        els.status.innerHTML = html;
    }

    function setBusy(busy) {
        testing = busy;
        els.connectBtn.disabled = busy;
        els.connectBtn.textContent = busy ? "Connecting..." : "Connect";
    }

    function currentFields() {
        return {
            hostname: els.hostname.value.trim(),
            local_ip: els.localIp.value.trim(),
            tailscale_ip: els.tailscaleIp.value.trim(),
        };
    }

    function applyFields(f) {
        els.hostname.value = f.hostname || "";
        els.localIp.value = f.local_ip || "";
        els.tailscaleIp.value = f.tailscale_ip || "";
    }

    function activeProfile() {
        return profiles.find(function (p) { return p.name === activeName; }) || null;
    }

    function hasAny(f) {
        return f.hostname || f.local_ip || f.tailscale_ip;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function defaultName(fields) {
        return fields.hostname || fields.local_ip || "Camera";
    }

    function uniqueName(base) {
        let name = base || "Camera";
        let i = 2;
        while (profiles.some(function (p) { return p.name === name; })) {
            name = base + " " + i;
            i++;
        }
        return name;
    }

    function upsertProfile(fields) {
        let name = els.cameraName.value.trim() || defaultName(fields);
        const existing = activeProfile();
        if (existing) {
            if (name !== existing.name && profiles.some(function (p) { return p.name === name; })) {
                name = uniqueName(name);
            }
            const idx = profiles.findIndex(function (p) { return p.name === existing.name; });
            profiles[idx] = { name: name, hostname: fields.hostname, local_ip: fields.local_ip, tailscale_ip: fields.tailscale_ip };
        } else {
            if (profiles.some(function (p) { return p.name === name; })) {
                name = uniqueName(name);
            }
            profiles.push({ name: name, hostname: fields.hostname, local_ip: fields.local_ip, tailscale_ip: fields.tailscale_ip });
        }
        activeName = name;
        els.cameraName.value = name;
        return name;
    }

    async function persist() {
        await invoke("save_settings", { profiles: profiles, active: activeName });
    }

    function renderProfiles() {
        els.profileSelect.innerHTML = "";
        profiles.forEach(function (p) {
            const opt = document.createElement("option");
            opt.value = p.name;
            opt.textContent = p.name;
            els.profileSelect.appendChild(opt);
        });
        if (activeName) els.profileSelect.value = activeName;
    }

    function selectProfile(name) {
        activeName = name;
        const p = activeProfile();
        if (p) {
            applyFields(p);
            els.cameraName.value = p.name;
        }
        renderProfiles();
    }

    function saveCurrent() {
        const name = upsertProfile(currentFields());
        renderProfiles();
        persist().catch(function (e) { console.warn("save failed:", e); });
        setStatus("ok", "Saved camera: <strong>" + escapeHtml(name) + "</strong>");
    }

    function newProfile() {
        activeName = null;
        els.cameraName.value = "";
        els.hostname.value = "";
        els.localIp.value = "";
        els.tailscaleIp.value = "";
        renderProfiles();
        els.hostname.focus();
    }

    function deleteActive() {
        const existing = activeProfile();
        if (!existing) return;
        profiles = profiles.filter(function (p) { return p.name !== existing.name; });
        activeName = profiles.length ? profiles[0].name : null;
        if (activeName) {
            selectProfile(activeName);
        } else {
            newProfile();
        }
        persist().catch(function (e) { console.warn("save failed:", e); });
        setStatus("ok", "Deleted camera: <strong>" + escapeHtml(existing.name) + "</strong>");
    }

    async function fetchNetworkAndApply(profile, url) {
        try {
            const net = await invoke("fetch_network_info", url);
            if (!net) return;
            if (net.hostname) profile.hostname = net.hostname;
            profile.local_ip = net.ip || "";
            profile.tailscale_ip = net.ip_tailscale || "";
            applyFields(profile);
        } catch (e) {
            console.warn("Could not fetch network info:", e);
        }
    }

    async function runConnect() {
        setBusy(true);
        setStatus("busy", '<span class="progress-line">Checking connection...</span>');

        const fields = currentFields();
        if (!hasAny(fields)) {
            setStatus("err", "Please provide at least one address (hostname, local IP or Tailscale IP).");
            setBusy(false);
            return;
        }

        const p = {
            name: els.cameraName.value.trim() || defaultName(fields),
            hostname: fields.hostname,
            local_ip: fields.local_ip,
            tailscale_ip: fields.tailscale_ip,
        };

        try {
            upsertProfile(p);
            await persist();
            renderProfiles();

            const result = await invoke("test_connection", p);

            if (result.ok) {
                setStatus("ok", "Connected to <strong>" + escapeHtml(result.winner) + "</strong> — verifying IPs...");
                await fetchNetworkAndApply(p, result.url);

                upsertProfile(p);
                await persist();
                renderProfiles();

                setStatus("ok", "Connected to <strong>" + escapeHtml(p.name) + "</strong> — opening camera...");
                setTimeout(function () {
                    invoke("navigate_to", result.url);
                }, 400);
            } else {
                const lines = result.errors
                    .map(function (e) { return "<div>• " + escapeHtml(e) + "</div>"; })
                    .join("");
                setStatus("err", "No connection possible:" + lines);
                setBusy(false);
            }
        } catch (err) {
            setStatus("err", "Error: " + escapeHtml(String(err)));
            setBusy(false);
        }
    }

    els.form.addEventListener("submit", function (e) {
        e.preventDefault();
        runConnect();
    });

    els.profileSelect.addEventListener("change", function () {
        selectProfile(els.profileSelect.value);
    });

    els.saveProfileBtn.addEventListener("click", saveCurrent);

    els.newProfileBtn.addEventListener("click", newProfile);

    els.deleteProfileBtn.addEventListener("click", function () {
        if (!activeProfile()) return;
        if (!deleteArmed) {
            deleteArmed = true;
            els.deleteProfileBtn.textContent = "Confirm?";
            deleteTimer = setTimeout(function () {
                deleteArmed = false;
                els.deleteProfileBtn.textContent = "Delete";
            }, 3000);
            return;
        }
        clearTimeout(deleteTimer);
        deleteArmed = false;
        els.deleteProfileBtn.textContent = "Delete";
        deleteActive();
    });

    API.onProgress(function (message) {
        if (testing) {
            setStatus("busy", '<span class="progress-line">' + escapeHtml(message) + "</span>");
        }
    });

    (async function init() {
        try {
            const manual = new URLSearchParams(window.location.search).has("manual");
            const settings = await invoke("load_settings");
            profiles = settings.profiles || [];
            activeName = settings.active || (profiles[0] && profiles[0].name) || null;

            renderProfiles();
            const p = activeProfile();
            if (p) {
                applyFields(p);
                els.cameraName.value = p.name;
            } else {
                newProfile();
            }

            if (!manual && p && hasAny(p)) {
                runConnect();
            }
        } catch (err) {
            setStatus("err", "Error loading: " + escapeHtml(String(err)));
        }
    })();
})();
