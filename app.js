// =============================================================
// Aether-Eye Web Dashboard — app.js v4.0
// Khớp chính xác với index.html (IDs + onclick functions)
// Firmware API đã phân tích:
//   Local HTTP: /stream /capture /status /control?var=X&val=Y
//   Cloud WS:   Camera gửi "register_camera" → server → browser
//               Browser → server → Camera: "start_stream","stop_stream",
//                "flash_on","flash_off","control:var:val"
// =============================================================

'use strict';

// ─────────────────────────────────────────────────────────────
// CẤU HÌNH
// ─────────────────────────────────────────────────────────────
const CLOUD_DOMAIN   = 'esp32cam-cloud-relay-1dn4.onrender.com';
const WS_CLIENT_PATH = '/client';
const STATUS_POLL_MS = 5000;
const MAX_RECONNECT  = 5;

// ─────────────────────────────────────────────────────────────
// TRẠNG THÁI
// ─────────────────────────────────────────────────────────────
let streamMode   = 'local';  // 'local' | 'cloud'
let connState    = 'idle';   // 'idle' | 'connecting' | 'connected' | 'reconnecting'
let isStreaming  = false;
let flashOn      = false;
let cameraIP     = '';
let wsCloud      = null;
let reconnectN   = 0;
let reconnectTmr = null;
let statusTmr    = null;
let fpsTmr       = null;
let fpsCount     = 0;
let lastBlobUrl  = null;

// ─────────────────────────────────────────────────────────────
// DOM ELEMENTS  (khớp đúng ID trong index.html)
// ─────────────────────────────────────────────────────────────
const elVideo       = document.getElementById('camera-stream');
const elLoader      = document.getElementById('video-loader');
const elLoaderTxt   = document.getElementById('loader-text');
const elStatusDot   = document.getElementById('status-dot');
const elStatusTxt   = document.getElementById('status-text');
const elBadge       = document.getElementById('stream-source-badge');
const elBtnConnect  = document.getElementById('btn-connect');
const elBtnStream   = document.getElementById('btn-stream-toggle');
const elBtnFlash    = document.getElementById('btn-flash');
const elBtnCapture  = document.getElementById('btn-capture');
const elIpInput     = document.getElementById('ip-address');      // ← id đúng trong HTML
const elMockCanvas  = document.getElementById('mock-canvas');     // ← id đúng trong HTML
const elGallery     = document.getElementById('gallery-grid');
const elLightbox    = document.getElementById('lightbox');
const elLightboxImg = document.getElementById('lightbox-img');
const elStatFps     = document.getElementById('stream-fps');
const elStatRes     = document.getElementById('stream-res');
const elStatRssi    = document.getElementById('stat-rssi');
const elStatHeap    = document.getElementById('stat-heap');
const elMotionAlert = document.getElementById('motion-overlay');

// ─────────────────────────────────────────────────────────────
// KHỞI TẠO
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const savedIP = localStorage.getItem('camera_ip');
    if (savedIP && elIpInput) elIpInput.value = savedIP;

    setUI('idle');
    startRadarAnimation();
    loadGallery();
    updateStreamBtn(false);
});

// ─────────────────────────────────────────────────────────────
// MODE SELECTOR  (gọi từ onclick="switchStreamMode('local')")
// ─────────────────────────────────────────────────────────────
function switchStreamMode(m) {
    if (connState !== 'idle') {
        alert('Vui lòng ngắt kết nối trước khi đổi chế độ!');
        return;
    }
    streamMode = m;

    document.getElementById('btn-mode-local').classList.toggle('active', m === 'local');
    document.getElementById('btn-mode-cloud').classList.toggle('active', m === 'cloud');

    const prefix = document.getElementById('connection-prefix');
    if (prefix) prefix.textContent = m === 'local' ? 'http://' : 'wss://';

    if (elIpInput) {
        if (m === 'local') {
            elIpInput.placeholder = '192.168.1.15';
            elIpInput.value = localStorage.getItem('camera_ip') || '';
        } else {
            elIpInput.value = CLOUD_DOMAIN;
            elIpInput.readOnly = true;
        }
    }
    if (m !== 'local' && elIpInput) elIpInput.readOnly = false;
}

// ─────────────────────────────────────────────────────────────
// KẾT NỐI / NGẮT KẾT NỐI  (onclick="toggleConnection()")
// ─────────────────────────────────────────────────────────────
function toggleConnection() {
    if (connState === 'idle') {
        doConnect();
    } else {
        doDisconnect();
    }
}

function doConnect() {
    if (streamMode === 'local') {
        cameraIP = elIpInput ? elIpInput.value.trim() : '';
        if (!cameraIP) { alert('Nhập địa chỉ IP camera!'); return; }
        localStorage.setItem('camera_ip', cameraIP);
        connectLocal();
    } else {
        connectCloud();
    }
}

function doDisconnect() {
    if (isStreaming) stopStream();

    if (wsCloud) { wsCloud.close(); wsCloud = null; }
    clearAllTimers();

    connState  = 'idle';
    isStreaming = false;
    setUI('idle');
    updateStreamBtn(false);
    hideBtnStream();

    if (elBtnConnect) {
        elBtnConnect.innerHTML = '<i class="fa-solid fa-play"></i> Kết nối';
        elBtnConnect.classList.remove('connected');
    }
    showLoader('Nhấn "Kết nối" để bắt đầu...');
}

// ─────────────────────────────────────────────────────────────
// LOCAL (LAN)
// ─────────────────────────────────────────────────────────────
function connectLocal() {
    connState = 'connected';
    setUI('connected-local');

    if (elBtnConnect) {
        elBtnConnect.innerHTML = '<i class="fa-solid fa-stop"></i> Ngắt kết nối';
        elBtnConnect.classList.add('connected');
    }
    setBadge('local');
    showLoader('Đã kết nối LAN. Nhấn ▶ Phát Luồng để xem.');
    showBtnStream();
    updateStreamBtn(false);

    // Poll status mỗi 5s
    pollStatus();
    statusTmr = setInterval(pollStatus, STATUS_POLL_MS);
    startFpsCounter();
}

async function pollStatus() {
    if (streamMode !== 'local' || connState !== 'connected') return;
    try {
        const r    = await fetch(`http://${cameraIP}/status`, { signal: AbortSignal.timeout(3000) });
        const data = await r.json();
        syncStatusData(data);
    } catch (_) { /* im lặng */ }
}

// ─────────────────────────────────────────────────────────────
// CLOUD (WebSocket Relay)
// ─────────────────────────────────────────────────────────────
function connectCloud() {
    connState = 'connecting';
    setUI('connecting');
    showLoader('Đang kết nối tới Cloud Relay...');

    if (elBtnConnect) {
        elBtnConnect.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang kết nối...';
        elBtnConnect.disabled = true;
    }

    try {
        wsCloud = new WebSocket(`wss://${CLOUD_DOMAIN}${WS_CLIENT_PATH}`);
        wsCloud.binaryType = 'blob';

        wsCloud.onopen = () => {
            reconnectN = 0;
            connState  = 'connected';

            setBadge('cloud');
            setUI('connected-cloud-waiting');
            showLoader('Đang chờ ESP32-CAM kết nối...');
            hideBtnStream();

            if (elBtnConnect) {
                elBtnConnect.innerHTML = '<i class="fa-solid fa-stop"></i> Ngắt kết nối';
                elBtnConnect.classList.add('connected');
                elBtnConnect.disabled = false;
            }
            startFpsCounter();
        };

        wsCloud.onmessage = (evt) => {
            if (evt.data instanceof Blob) {
                // Binary = JPEG frame từ camera
                if (!isStreaming) return;
                if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
                lastBlobUrl = URL.createObjectURL(evt.data);
                elVideo.src = lastBlobUrl;
                fpsCount++;
                hideLoader();
            } else {
                onCloudMessage(evt.data);
            }
        };

        wsCloud.onclose = () => {
            if (lastBlobUrl) { URL.revokeObjectURL(lastBlobUrl); lastBlobUrl = null; }

            if (connState === 'connected' || connState === 'connecting') {
                if (reconnectN < MAX_RECONNECT) {
                    reconnectN++;
                    connState = 'reconnecting';
                    setUI('reconnecting');
                    showLoader(`Mất kết nối. Thử lại lần ${reconnectN}/${MAX_RECONNECT}...`);
                    reconnectTmr = setTimeout(connectCloud, 4000);
                } else {
                    doDisconnect();
                    alert('Không thể kết nối Cloud Relay sau nhiều lần thử!');
                }
            }
        };

        wsCloud.onerror = () => {
            if (elBtnConnect) elBtnConnect.disabled = false;
        };

    } catch (e) {
        console.error('[WS]', e);
        doDisconnect();
    }
}

function onCloudMessage(text) {
    try {
        const msg = JSON.parse(text);
        if (msg.type !== 'status') return;

        if (msg.camera === 'online') {
            // Camera đã đăng ký (server nhận register_camera từ ESP32)
            setUI('connected-cloud-online');
            showLoader('Camera ONLINE. Nhấn ▶ Phát Luồng để xem!');
            showBtnStream();
            updateStreamBtn(false);

        } else if (msg.camera === 'offline') {
            setUI('connected-cloud-waiting');
            showLoader('Camera đã offline. Đang chờ ESP32-CAM kết nối lại...');
            hideBtnStream();
            isStreaming = false;
            if (lastBlobUrl) { URL.revokeObjectURL(lastBlobUrl); lastBlobUrl = null; }
        }
    } catch (_) {
        console.log('[Cloud]', text);
    }
}

// ─────────────────────────────────────────────────────────────
// STREAM  (onclick="toggleStreamState()")
// ─────────────────────────────────────────────────────────────
function toggleStreamState() {
    if (connState !== 'connected') return;
    if (isStreaming) stopStream();
    else startStream();
}

function startStream() {
    if (streamMode === 'local') {
        elVideo.src = `http://${cameraIP}/stream`;
        elVideo.style.display = 'block';
        if (elMockCanvas) elMockCanvas.style.display = 'none';
        hideLoader();
        const sel = document.getElementById('setting-resolution');
        if (sel) updateResLabel(sel.value);
    } else {
        if (!wsCloud || wsCloud.readyState !== WebSocket.OPEN) return;
        wsCloud.send('start_stream');
        showLoader('Đang yêu cầu camera phát luồng...');
    }
    isStreaming = true;
    updateStreamBtn(true);
}

function stopStream() {
    if (streamMode === 'local') {
        elVideo.src = '';
        elVideo.style.display = 'none';
        if (elMockCanvas) elMockCanvas.style.display = 'block';
        showLoader('Đã dừng phát. Nhấn ▶ để tiếp tục.');
    } else {
        if (wsCloud && wsCloud.readyState === WebSocket.OPEN) {
            wsCloud.send('stop_stream');
        }
        showLoader('Đã dừng phát. Nhấn ▶ để tiếp tục.');
    }
    isStreaming = false;
    updateStreamBtn(false);
    fpsCount = 0;
    if (elStatFps) elStatFps.textContent = '0 FPS';
}

// ─────────────────────────────────────────────────────────────
// FLASH  (onclick="toggleFlash()")
// ─────────────────────────────────────────────────────────────
function toggleFlash() {
    if (connState !== 'connected') return;
    flashOn = !flashOn;

    if (streamMode === 'local') {
        fetch(`http://${cameraIP}/control?var=flash&val=${flashOn ? '1' : '0'}`).catch(console.error);
    } else if (wsCloud && wsCloud.readyState === WebSocket.OPEN) {
        wsCloud.send(flashOn ? 'flash_on' : 'flash_off');
    }

    if (elBtnFlash) {
        elBtnFlash.innerHTML = flashOn
            ? '<i class="fa-solid fa-lightbulb"></i> Flash: BẬT'
            : '<i class="fa-solid fa-lightbulb"></i> Flash: TẮT';
        elBtnFlash.classList.toggle('active', flashOn);
    }
}

// ─────────────────────────────────────────────────────────────
// SNAPSHOT  (onclick="takeSnapshot()")
// ─────────────────────────────────────────────────────────────
function takeSnapshot() {
    if (connState !== 'connected') return;

    if (streamMode === 'local') {
        fetch(`http://${cameraIP}/capture?t=${Date.now()}`)
            .then(r => r.blob())
            .then(blob => saveToGallery(blob))
            .catch(e => alert('Chụp ảnh thất bại: ' + e.message));
    } else {
        // Cloud mode: chụp từ frame hiện tại
        if (!lastBlobUrl) { alert('Chưa có ảnh stream để chụp!'); return; }
        fetch(lastBlobUrl)
            .then(r => r.blob())
            .then(blob => saveToGallery(blob))
            .catch(console.error);
    }
}

// ─────────────────────────────────────────────────────────────
// CAMERA SETTINGS — Local HTTP controls
// ─────────────────────────────────────────────────────────────

// onclick gọi qua HTML: onchange="changeResolution(this.value)"
function changeResolution(val) {
    if (streamMode !== 'local' || connState !== 'connected') return;
    fetch(`http://${cameraIP}/control?var=framesize&val=${val}`).catch(console.error);
    updateResLabel(val);
}

// onclick gọi qua HTML: onchange="changeQuality(this.value)"
function changeQuality(val) {
    if (streamMode !== 'local' || connState !== 'connected') return;
    fetch(`http://${cameraIP}/control?var=quality&val=${val}`).catch(console.error);
}

// onclick gọi qua HTML: oninput="updateRangeLabel('quality', this.value)"
function updateRangeLabel(name, val) {
    const el = document.getElementById('val-' + name);
    if (el) el.textContent = val;
}

// onclick gọi qua HTML: onchange="updateCamSetting('brightness', this.value)"
function updateCamSetting(varName, val) {
    if (streamMode !== 'local' || connState !== 'connected') return;
    fetch(`http://${cameraIP}/control?var=${varName}&val=${val}`).catch(console.error);
}

// onclick gọi qua HTML: onchange="toggleHardwareMotion()"
function toggleHardwareMotion() {
    const el = document.getElementById('setting-motion');
    if (!el) return;
    if (streamMode !== 'local' || connState !== 'connected') return;
    fetch(`http://${cameraIP}/control?var=motion&val=${el.checked ? '1' : '0'}`).catch(console.error);
}

// ─────────────────────────────────────────────────────────────
// GALLERY  (onclick="clearGallery()")
// ─────────────────────────────────────────────────────────────
const GALLERY_KEY = 'aether_gallery_v2';

function saveToGallery(blob) {
    const reader = new FileReader();
    reader.onload = () => {
        const b64 = reader.result;
        const arr = JSON.parse(localStorage.getItem(GALLERY_KEY) || '[]');
        arr.unshift({ src: b64, ts: new Date().toLocaleString('vi-VN') });
        if (arr.length > 30) arr.pop();
        localStorage.setItem(GALLERY_KEY, JSON.stringify(arr));
        renderThumb(b64, arr[0].ts);
    };
    reader.readAsDataURL(blob);
}

function loadGallery() {
    const arr = JSON.parse(localStorage.getItem(GALLERY_KEY) || '[]');
    arr.forEach(item => renderThumb(item.src, item.ts));
}

function renderThumb(src, ts) {
    if (!elGallery) return;
    // Xóa placeholder nếu còn
    const empty = elGallery.querySelector('.gallery-empty');
    if (empty) empty.remove();

    const wrap = document.createElement('div');
    wrap.className = 'gallery-item';

    const img = document.createElement('img');
    img.src = src;
    img.className = 'gallery-thumb';
    img.addEventListener('click', () => openLightbox(src, ts));

    const caption = document.createElement('span');
    caption.className = 'gallery-ts';
    caption.textContent = ts || '';

    wrap.appendChild(img);
    wrap.appendChild(caption);
    elGallery.prepend(wrap);
}

function clearGallery() {
    if (!confirm('Xóa toàn bộ ảnh đã chụp?')) return;
    localStorage.removeItem(GALLERY_KEY);
    if (elGallery) {
        elGallery.innerHTML = `<div class="gallery-empty">
            <i class="fa-regular fa-image"></i>
            <p>Chưa có ảnh chụp nào trong thư viện.</p>
        </div>`;
    }
}

// ─────────────────────────────────────────────────────────────
// LIGHTBOX  (onclick="closeLightbox()")
// ─────────────────────────────────────────────────────────────
function openLightbox(src, caption) {
    if (!elLightbox) return;
    elLightboxImg.src = src;
    const cap = document.getElementById('lightbox-caption');
    if (cap) cap.textContent = caption || '';
    elLightbox.style.display = 'flex';
}

function closeLightbox() {
    if (elLightbox) elLightbox.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────
// FULLSCREEN  (onclick="toggleFullscreen()")
// ─────────────────────────────────────────────────────────────
function toggleFullscreen() {
    const el = document.getElementById('video-container') || elVideo;
    if (!document.fullscreenElement) {
        el.requestFullscreen && el.requestFullscreen();
    } else {
        document.exitFullscreen && document.exitFullscreen();
    }
}

// ─────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────
function setUI(state) {
    const map = {
        'idle':                   { dot: 'disconnected', txt: 'Chưa kết nối' },
        'connecting':             { dot: 'connecting',   txt: 'Đang kết nối...' },
        'reconnecting':           { dot: 'connecting',   txt: 'Đang thử lại...' },
        'connected-local':        { dot: 'connected',    txt: 'Đã kết nối LAN' },
        'connected-cloud-waiting':{ dot: 'connecting',   txt: 'Chờ Camera...' },
        'connected-cloud-online': { dot: 'connected',    txt: 'Đã kết nối Cloud' },
    };
    const s = map[state] || map['idle'];
    if (elStatusDot) elStatusDot.className = 'dot ' + s.dot;
    if (elStatusTxt) elStatusTxt.textContent = s.txt;
}

function setBadge(type) {
    if (!elBadge) return;
    if (type === 'local') {
        elBadge.innerHTML = '<i class="fa-solid fa-wifi"></i> LAN';
        elBadge.className = 'badge mode-badge';
    } else {
        elBadge.innerHTML = '<i class="fa-solid fa-cloud"></i> CLOUD';
        elBadge.className = 'badge mode-badge';
    }
}

function showLoader(txt) {
    if (elLoader)    elLoader.style.display   = 'flex';
    if (elVideo)     elVideo.style.display    = 'none';
    if (elLoaderTxt) elLoaderTxt.textContent  = txt || '';
}

function hideLoader() {
    if (elLoader) elLoader.style.display = 'none';
    if (elVideo)  elVideo.style.display  = 'block';
}

function showBtnStream() {
    if (elBtnStream) elBtnStream.style.display = '';
}

function hideBtnStream() {
    if (elBtnStream) elBtnStream.style.display = 'none';
}

function updateStreamBtn(playing) {
    if (!elBtnStream) return;
    if (playing) {
        elBtnStream.innerHTML = '<i class="fa-solid fa-pause"></i> Dừng Phát';
        elBtnStream.classList.add('active');
    } else {
        elBtnStream.innerHTML = '<i class="fa-solid fa-play"></i> Phát Luồng';
        elBtnStream.classList.remove('active');
    }
}

function updateResLabel(val) {
    const labels = { '1':'QQVGA','3':'HQVGA','4':'QVGA','5':'CIF','6':'VGA','7':'SVGA','8':'XGA','9':'SXGA','10':'UXGA' };
    if (elStatRes) elStatRes.textContent = labels[val] || 'VGA';
}

function syncStatusData(data) {
    if (!data) return;
    if (data.flash !== undefined) {
        flashOn = data.flash;
        if (elBtnFlash) {
            elBtnFlash.innerHTML = `<i class="fa-solid fa-lightbulb"></i> Flash: ${flashOn ? 'BẬT' : 'TẮT'}`;
            elBtnFlash.classList.toggle('active', flashOn);
        }
    }
    if (data.motion_detect !== undefined) {
        const el = document.getElementById('setting-motion');
        if (el) el.checked = data.motion_detect;
    }
    if (data.wifi_rssi !== undefined && elStatRssi) {
        const r = data.wifi_rssi;
        const q = r >= -60 ? 'Tốt' : r >= -75 ? 'Vừa' : 'Yếu';
        elStatRssi.textContent = `${r} dBm (${q})`;
    }
    if (data.free_heap !== undefined && elStatHeap) {
        elStatHeap.textContent = `${Math.round(data.free_heap / 1024)} KB`;
    }
}

function clearAllTimers() {
    if (reconnectTmr) { clearTimeout(reconnectTmr);  reconnectTmr = null; }
    if (statusTmr)    { clearInterval(statusTmr);     statusTmr    = null; }
    if (fpsTmr)       { clearInterval(fpsTmr);        fpsTmr       = null; }
}

// ─────────────────────────────────────────────────────────────
// FPS COUNTER
// ─────────────────────────────────────────────────────────────
function startFpsCounter() {
    if (fpsTmr) clearInterval(fpsTmr);
    fpsCount = 0;
    fpsTmr = setInterval(() => {
        if (elStatFps) elStatFps.textContent = `${fpsCount} FPS`;
        fpsCount = 0;
    }, 1000);
}

// ─────────────────────────────────────────────────────────────
// RADAR ANIMATION (canvas "mock-canvas" khi offline)
// ─────────────────────────────────────────────────────────────
function startRadarAnimation() {
    const canvas = elMockCanvas;
    if (!canvas) return;

    canvas.width  = canvas.offsetWidth  || 640;
    canvas.height = canvas.offsetHeight || 480;

    const ctx = canvas.getContext('2d');
    const cx  = canvas.width  / 2;
    const cy  = canvas.height / 2;
    const R   = Math.min(cx, cy) * 0.85;
    let angle = 0;

    // Điểm ngẫu nhiên để giả lập vật thể
    const dots = Array.from({ length: 6 }, () => ({
        angle: Math.random() * Math.PI * 2,
        dist:  Math.random() * 0.8 + 0.1,
        alpha: 0
    }));

    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Nền
        ctx.fillStyle = '#060913';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Lưới vòng tròn
        for (let i = 1; i <= 4; i++) {
            ctx.beginPath();
            ctx.arc(cx, cy, R * i / 4, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,242,254,0.15)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Đường chữ thập
        ctx.strokeStyle = 'rgba(0,242,254,0.1)';
        ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();

        // Tia quét
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        const sweep = ctx.createLinearGradient(0, 0, R, 0);
        sweep.addColorStop(0,   'rgba(0,242,254,0.6)');
        sweep.addColorStop(0.6, 'rgba(0,242,254,0.1)');
        sweep.addColorStop(1,   'rgba(0,242,254,0)');
        ctx.fillStyle = sweep;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, R, -0.25, 0.25);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // Điểm chớp
        dots.forEach(d => {
            const da = ((d.angle - angle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
            if (da < 0.25) d.alpha = 1;
            else d.alpha = Math.max(0, d.alpha - 0.02);

            if (d.alpha > 0.05) {
                const px = cx + Math.cos(d.angle) * R * d.dist;
                const py = cy + Math.sin(d.angle) * R * d.dist;
                ctx.beginPath();
                ctx.arc(px, py, 4, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(57,255,20,${d.alpha})`;
                ctx.fill();
            }
        });

        // Text
        ctx.fillStyle = 'rgba(0,242,254,0.4)';
        ctx.font = '13px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('AETHER-EYE — CHỜ KẾT NỐI CAMERA', cx, canvas.height - 16);

        angle += 0.025;
        requestAnimationFrame(draw);
    }

    draw();
}
