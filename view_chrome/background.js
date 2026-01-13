// Cấu hình Firebase mới
const config = {
    apiKey: "AIzaSyClgrlU3cOTayqLSHLvkQI1W1LtrJWHtUQ",
    projectId: "view-v1-af0a0"
};

const appId = "extension-remote-control";
let deviceId = null;
let startTime = null;
let lastProcessedTime = 0; 
let idToken = null;
let cachedIP = "0.0.0.0";

async function getPersistentData() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['deviceId', 'startTime', 'lastProcessedTime'], (result) => {
            let data = { ...result };
            let changed = false;
            if (!result.deviceId) {
                data.deviceId = 'dev_' + Math.random().toString(36).substr(2, 9);
                changed = true;
            }
            if (!result.startTime) {
                data.startTime = new Date().toISOString();
                changed = true;
            }
            if (changed) chrome.storage.local.set(data, () => resolve(data));
            else resolve(data);
        });
    });
}

async function signInAnonymous() {
    try {
        const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${config.apiKey}`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ returnSecureToken: true })
        });
        const data = await resp.json();
        if (data.idToken) {
            idToken = data.idToken;
            return true;
        }
        return false;
    } catch (e) { return false; }
}

async function fetchInitialIP() {
    try {
        const resp = await fetch('https://api.ipify.org?format=json');
        const data = await resp.json();
        cachedIP = data.ip;
    } catch (e) { }
}

// Hàm format giây thành hh:mm:ss
function formatSeconds(s) {
    if (isNaN(s)) return "00:00";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sc = Math.floor(s % 60);
    return (h > 0 ? h + ":" : "") + String(m).padStart(2, '0') + ":" + String(sc).padStart(2, '0');
}

// Hàm lấy thông tin Tab và Video YouTube
async function getActiveTabStatus() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (tabs && tabs[0]) {
                const tab = tabs[0];
                let videoTime = null;

                // Nếu là YouTube, tiến hành chọc vào DOM để lấy thời gian
                if (tab.url && tab.url.includes("youtube.com/watch")) {
                    try {
                        const results = await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            func: () => {
                                const v = document.querySelector('video');
                                if (v) return { curr: v.currentTime, dur: v.duration };
                                return null;
                            }
                        });
                        if (results && results[0].result) {
                            const { curr, dur } = results[0].result;
                            videoTime = `${formatSeconds(curr)} / ${formatSeconds(dur)}`;
                        }
                    } catch (e) { /* Có thể do trang chưa load xong hoặc quyền */ }
                }

                resolve({
                    title: tab.title || "Không có tiêu đề",
                    videoTime: videoTime
                });
            } else {
                resolve({ title: "Đang ẩn trình duyệt", videoTime: null });
            }
        });
    });
}

async function sendHeartbeat(status = "online") {
    if (!deviceId || !startTime) return;
    if (!idToken && !(await signInAnonymous())) return;

    const tabStatus = await getActiveTabStatus();

    // Cập nhật updateMask để bao gồm cả videoTime
    const url = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/artifacts/${appId}/public/data/devices/${deviceId}?updateMask.fieldPaths=status&updateMask.fieldPaths=ip&updateMask.fieldPaths=lastSeen&updateMask.fieldPaths=id&updateMask.fieldPaths=startTime&updateMask.fieldPaths=activeTitle&updateMask.fieldPaths=videoTime`;
    
    const body = {
        fields: {
            id: { stringValue: deviceId },
            status: { stringValue: status },
            ip: { stringValue: cachedIP },
            lastSeen: { timestampValue: new Date().toISOString() },
            startTime: { timestampValue: startTime },
            activeTitle: { stringValue: tabStatus.title },
            videoTime: { stringValue: tabStatus.videoTime || "" } // Gửi mốc thời gian video
        }
    };

    try {
        const resp = await fetch(url, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (resp.status === 401) idToken = null; 
    } catch (e) { idToken = null; }
}

async function checkCommands() {
    if (!idToken || !deviceId) return;
    const url = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/artifacts/${appId}/public/data/devices/${deviceId}`;
    try {
        const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${idToken}` } });
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.fields && data.fields.targetUrl && data.fields.commandTime) {
            const targetUrl = data.fields.targetUrl.stringValue;
            const commandTime = Number(data.fields.commandTime.integerValue || data.fields.commandTime.doubleValue || 0);
            if (commandTime > lastProcessedTime) {
                lastProcessedTime = commandTime;
                chrome.storage.local.set({ lastProcessedTime: commandTime });
                chrome.tabs.create({ url: targetUrl });
            }
        }
    } catch (e) { }
}

if (chrome.alarms) {
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === 'heartbeat_alarm') {
            sendHeartbeat("online");
            checkCommands();
        }
    });
}

async function main() {
    const data = await getPersistentData();
    deviceId = data.deviceId;
    startTime = data.startTime;
    lastProcessedTime = data.lastProcessedTime || 0;
    await fetchInitialIP();
    await signInAnonymous();
    await sendHeartbeat("online");
    if (chrome.alarms) chrome.alarms.create('heartbeat_alarm', { periodInMinutes: 1 });
    setInterval(() => sendHeartbeat("online"), 15000);
    setInterval(checkCommands, 2000);
}
main();