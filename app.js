// =============================================================
// Aether-Eye Web Dashboard — app.js v3.0
// Viết lại hoàn toàn theo đúng firmware ESP32-CAM
//
// Firmware API (Local HTTP):
//   GET /stream        → MJPEG stream
//   GET /capture       → JPEG tĩnh
//   GET /status        → JSON { flash, motion_detect, is_cloud_streaming, wifi_rssi, free_heap }
//   GET /control?var=X&val=Y → Điều khiển: flash, motion, framesize, quality, vflip, hmirror...
//
// Cloud WebSocket (qua server relay):
//   Camera gửi: "register_camera" khi kết nối
//   Server → Camera text: "start_stream", "stop_stream", "flash_on", "flash_off"
//                         "control:framesize:N", "control:quality:N", ...
//   Camera → Server binary: frame JPEG bytes
// =============================================================

'use strict';

// ─────────────────────────────────────────────────────────────
// CẤU HÌNH
// ─────────────────────────────────────────────────────────────
const CLOUD_DOMAIN   = 'esp32cam-cloud-relay-1dn4.onrender.com';
const WS_CLIENT_PATH = '/client';
const STATUS_POLL_MS = 5000;  // Poll /status mỗi 5 giây (chế độ LAN)
const MAX_RECONNECT  = 5;     // Số lần thử kết nối lại Cloud tối đa

// ─────────────────────────────────────────────────────────────
// TRẠNG THÁI ỨNG DỤNG
// ─────────────────────────────────────────────────────────────
let mode         = 'idle';   // 'idle' | 'local' | 'cloud'
let wsCloud      = null;     // WebSocket tới relay server
let isStreaming  = false;    // Camera đang gửi frames
let flashOn      = false;
let reconnectN   = 0;
let reconnectTmr = null;
let statusTmr    = null;
let fpsTmr       = null;
let fpsCount     = 0;
let lastBlobUrl  = null;
let cameraIP     = '';

// ─────────────────────────────────────────────────────────────
// DOM REFERENCES
// ─────────────────────────────────────────────────────────────
const elVideo        = document.getElementById('camera-stream');
const elLoader       = document.getElementById('video-loader');
const elLoaderTxt    = document.getElementById('loader-text');
const elStatusDot    = document.getElementById('status-dot');
const elStatusTxt    = document.getElementById('status-text');
const elBadge        = document.getElementById('stream-source-badge');
const elBtnConnect   = document.getElementById('btn-connect');
const elBtnStream    = document.getElementById('btn-stream-toggle');
const elBtnFlash     = document.getElementById('btn-flash');
const elBtnCapture   = document.getElementById('btn-capture');
const elIpInput      = document.getElementById('ip-input');
const elModeLocal    = document.getElementById('mode-local');
const elModeCloud    = document.getElementById('mode-cloud');
const elResSelect    = document.getElementById('setting-resolution');
const elQualSlider   = document.getElementById('setting-quality');
const elMotionSwitch = document.getElementById('setting-motion');
const elStatFps      = document.getElementById('stream-fps');
const elStatRes      = document.getElementById('stream-res');
const elStatRssi     = document.getElementById('stat-rssi');
const elStatHeap     = document.getElementById('stat-heap');
const elGallery      = document.getElementById('gallery-grid');

// ─────────────────────────────────────────────────────────────
// KHỞI TẠO
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    setStatus('idle');
    setupEventListeners();
    initRadarCanvas();
    loadGalleryFromStorage();
    // Đọc IP đã lưu
    const savedIP = localStorage.getItem('camera_ip');
    if (savedIP && elIpInput) elIpInput.value = savedIP;
});

// ─────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────────────────────
function setupEventListeners() {
    // Nút kết nối / ngắt kết nối
    if (elBtnConnect) elBtnConnect.addEventListener('click', onClickConnect);

    // Nút phát / dừng stream
    if (elBtnStream) elBtnStream.addEventListener('click', onClickStream);

    // Nút flash
    if (elBtnFlash) elBtnFlash.addEventListener('click', onClickFlash);

    // Nút chụp ảnh
    if (elBtnCapture) elBtnCapture.addEventListener('click', onClickCapture);

    // Chọn chế độ (Local / Cloud)
    if (elModeLocal) elModeLocal.addEventListener('change', onModeChange);
    if (elModeCloud) elModeCloud.addEventListener('change', onModeChange);

    // Thay đổi resolution (chỉ Local)
    if (elResSelect) elResSelect.addEventListener('change', onResolutionChange);

    // Thay đổi quality slider (chỉ Local)
    if (elQualSlider) elQualSlider.addEventListener('input', onQualityChange);

    // Toggle phát hiện chuyển động (chỉ Local)
    if (elMotionSwitch) elMotionSwitch.addEventListener('change', onMotionChange);

    // Fullscreen
    const btnFs = document.getElementById('btn-fullscreen');
    if (btnFs) btnFs.addEventListener('click', toggleFullscreen);
}

// ─────────────────────────────────────────────────────────────
// CONNECT / DISCONNECT
// ─────────────────────────────────────────────────────────────
function onClickConnect() {
    if (mode !== 'idle') {
        disconnect();
    } else {
        connect();
    }
}

function connect() {
    const selectedMode = getSelectedMode();

    if (selectedMode === 'local') {
        cameraIP = elIpInput ? elIpInput.value.trim() : '';
        if (!cameraIP) {
            alert('Vui lòng nhập địa chỉ IP của camera!');
            return;
        }
        localStorage.setItem('camera_ip', cameraIP);
        connectLocal();
    } else {
        connectCloud();
    }
}

function disconnect() {
    stopStream();

    if (wsCloud) {
        wsCloud.close();
        wsCloud = null;
    }

    clearTimers();
    mode = 'idle';
    setStatus('idle');
    setStreamBtnState('hidden');

    if (elBtnConnect) {
        elBtnConnect.textContent = 'Kết nối';
        elBtnConnect.classList.remove('connected');
    }

    showLoader('Nhấn Kết nối để bắt đầu...');
}

// ─── Local (LAN) ─────────────────────────────────────────────
function connectLocal() {
    mode = 'local';
    setStatus('connected-local');

    if (elBtnConnect) {
        elBtnConnect.textContent = 'Ngắt kết nối';
        elBtnConnect.classList.add('connected');
    }

    updateBadge('local');
    showLoader('Đã kết nối LAN. Nhấn ▶ Phát Luồng để xem.');
    setStreamBtnState('play');

    // Poll trạng thái camera
    pollStatus();
    statusTmr = setInterval(pollStatus, STATUS_POLL_MS);
}

async function pollStatus() {
    if (mode !== 'local') return;
    try {
        const res  = await fetch(`http://${cameraIP}/status`, { signal: AbortSignal.timeout(3000) });
        const data = await res.json();
        updateStatusUI(data);
    } catch (_) {
        // Không báo lỗi mỗi poll, chỉ im lặng
    }
}

// ─── Cloud (WebSocket relay) ──────────────────────────────────
function connectCloud() {
    setStatus('connecting');
    showLoader('Đang kết nối tới Cloud Relay...');

    if (elBtnConnect) {
        elBtnConnect.textContent = 'Đang kết nối...';
        elBtnConnect.disabled = true;
    }

    try {
        wsCloud = new WebSocket(`wss://${CLOUD_DOMAIN}${WS_CLIENT_PATH}`);
        wsCloud.binaryType = 'blob';

        wsCloud.onopen = () => {
            reconnectN = 0;
            mode       = 'cloud';

            if (elBtnConnect) {
                elBtnConnect.textContent = 'Ngắt kết nối';
                elBtnConnect.classList.add('connected');
                elBtnConnect.disabled = false;
            }

            updateBadge('cloud');
            // Không tự động start_stream — chờ camera online và user nhấn nút
            showLoader('Đang chờ ESP32-CAM đăng ký kết nối...');
            setStatus('cloud-waiting');
            setStreamBtnState('hidden');

            startFpsCounter();
        };

        wsCloud.onmessage = (evt) => {
            if (evt.data instanceof Blob) {
                // Binary = JPEG frame
                if (!isStreaming) return; // Bỏ qua nếu user chưa nhấn Play
                if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
                lastBlobUrl = URL.createObjectURL(evt.data);
                elVideo.src = lastBlobUrl;
                fpsCount++;
                hideLoader();
            } else {
                // Text = JSON status
                handleCloudMessage(evt.data);
            }
        };

        wsCloud.onclose = () => {
            if (lastBlobUrl) { URL.revokeObjectURL(lastBlobUrl); lastBlobUrl = null; }

            if (mode === 'cloud') {
                // Thử kết nối lại
                if (reconnectN < MAX_RECONNECT) {
                    reconnectN++;
                    setStatus('reconnecting');
                    showLoader(`Mất kết nối Cloud. Thử lại lần ${reconnectN}/${MAX_RECONNECT}...`);
                    reconnectTmr = setTimeout(connectCloud, 4000);
                } else {
                    disconnect();
                    alert('Không thể kết nối lại Cloud Relay sau nhiều lần thử!');
                }
            }
        };

        wsCloud.onerror = (e) => {
            console.error('[WS] Lỗi:', e);
            if (elBtnConnect) elBtnConnect.disabled = false;
        };

    } catch (e) {
        console.error('[WS] Không thể tạo WebSocket:', e);
        disconnect();
    }
}

function handleCloudMessage(text) {
    try {
        const msg = JSON.parse(text);

        if (msg.type === 'status') {
            if (msg.camera === 'online') {
                // Camera đã đăng ký (register_camera đã nhận ở server)
                setStatus('connected-cloud');
                showLoader('Camera ONLINE. Nhấn ▶ Phát Luồng để xem.');
                setStreamBtnState('play');
            } else if (msg.camera === 'offline') {
                setStatus('cloud-waiting');
                showLoader('Camera đã ngắt kết nối. Đang chờ kết nối lại...');
                setStreamBtnState('hidden');
                isStreaming = false;
                if (lastBlobUrl) { URL.revokeObjectURL(lastBlobUrl); lastBlobUrl = null; }
            }
            return;
        }
    } catch (_) {
        // Không phải JSON → log thô
        console.log('[Cloud text]', text);
    }
}

// ─────────────────────────────────────────────────────────────
// STREAM CONTROL
// ─────────────────────────────────────────────────────────────
function onClickStream() {
    if (isStreaming) {
        stopStream();
    } else {
        startStream();
    }
}

function startStream() {
    if (mode === 'local') {
        elVideo.src = `http://${cameraIP}/stream`;
        hideLoader();
        isStreaming = true;
        setStreamBtnState('pause');
        elStatRes.textContent = 'MJPEG';
    } else if (mode === 'cloud') {
        if (!wsCloud || wsCloud.readyState !== WebSocket.OPEN) {
            alert('Chưa kết nối Cloud!'); return;
        }
        isStreaming = true;
        setStreamBtnState('pause');
        showLoader('Đang yêu cầu camera bắt đầu phát...');
        wsCloud.send('start_stream');
    }
}

function stopStream() {
    if (mode === 'local') {
        elVideo.src = '';
        showLoader('Stream đã dừng. Nhấn ▶ để tiếp tục.');
    } else if (mode === 'cloud') {
        if (wsCloud && wsCloud.readyState === WebSocket.OPEN) {
            wsCloud.send('stop_stream');
        }
        showLoader('Stream đã dừng. Nhấn ▶ để tiếp tục.');
    }
    isStreaming = false;
    setStreamBtnState('play');
    fpsCount = 0;
    elStatFps.textContent = '0 FPS';
}

// ─────────────────────────────────────────────────────────────
// FLASH
// ─────────────────────────────────────────────────────────────
function onClickFlash() {
    flashOn = !flashOn;

    if (mode === 'local') {
        fetch(`http://${cameraIP}/control?var=flash&val=${flashOn ? '1' : '0'}`)
            .catch(console.error);
    } else if (mode === 'cloud' && wsCloud && wsCloud.readyState === WebSocket.OPEN) {
        wsCloud.send(flashOn ? 'flash_on' : 'flash_off');
    }

    updateFlashUI();
}

function updateFlashUI() {
    if (!elBtnFlash) return;
    if (flashOn) {
        elBtnFlash.classList.add('active');
        elBtnFlash.innerHTML = '<i class="fa-solid fa-bolt"></i> Flash ON';
    } else {
        elBtnFlash.classList.remove('active');
        elBtnFlash.innerHTML = '<i class="fa-solid fa-bolt"></i> Flash';
    }
}

// ─────────────────────────────────────────────────────────────
// CAPTURE (chỉ Local)
// ─────────────────────────────────────────────────────────────
function onClickCapture() {
    if (mode !== 'local') {
        alert('Chức năng chụp ảnh chỉ hỗ trợ ở chế độ LAN!');
        return;
    }
    const src = `http://${cameraIP}/capture?t=${Date.now()}`;
    fetch(src)
        .then(r => r.blob())
        .then(blob => {
            const imgUrl = URL.createObjectURL(blob);
            saveToGallery(imgUrl, blob);
        })
        .catch(e => alert('Chụp ảnh thất bại: ' + e.message));
}

// ─────────────────────────────────────────────────────────────
// CAMERA CONTROLS (Local)
// ─────────────────────────────────────────────────────────────
function onModeChange() {
    // Chỉ cập nhật UI, không kết nối
    const m = getSelectedMode();
    if (m === 'local') {
        if (elIpInput) elIpInput.closest('.ip-row') && (elIpInput.parentElement.style.display = 'flex');
    }
}

function onResolutionChange() {
    if (mode !== 'local') return;
    const val = elResSelect.value;
    fetch(`http://${cameraIP}/control?var=framesize&val=${val}`).catch(console.error);
    const labels = { '1': 'QQVGA', '3': 'HQVGA', '4': 'QVGA', '5': 'CIF', '6': 'HVGA', '7': 'VGA', '8': 'SVGA' };
    elStatRes.textContent = labels[val] || 'VGA';
}

function onQualityChange() {
    if (mode !== 'local') return;
    const val = elQualSlider.value;
    const label = document.getElementById('quality-label');
    if (label) label.textContent = val;
    fetch(`http://${cameraIP}/control?var=quality&val=${val}`).catch(console.error);
}

function onMotionChange() {
    if (mode !== 'local') return;
    const val = elMotionSwitch.checked ? '1' : '0';
    fetch(`http://${cameraIP}/control?var=motion&val=${val}`).catch(console.error);
}

// ─────────────────────────────────────────────────────────────
// STATUS / UI HELPERS
// ─────────────────────────────────────────────────────────────
function setStatus(state) {
    if (!elStatusDot || !elStatusTxt) return;
    const states = {
        'idle':             { dot: '',            text: 'Chưa kết nối' },
        'connecting':       { dot: 'connecting',  text: 'Đang kết nối...' },
        'reconnecting':     { dot: 'connecting',  text: 'Đang thử kết nối lại...' },
        'connected-local':  { dot: 'connected',   text: 'Đã kết nối LAN' },
        'cloud-waiting':    { dot: 'connecting',  text: 'Chờ Camera...' },
        'connected-cloud':  { dot: 'connected',   text: 'Đã kết nối Cloud' },
    };
    const s = states[state] || states['idle'];
    elStatusDot.className = 'dot ' + s.dot;
    elStatusTxt.textContent = s.text;
}

function updateBadge(type) {
    if (!elBadge) return;
    if (type === 'local') {
        elBadge.innerHTML = '<i class="fa-solid fa-wifi"></i> LAN';
        elBadge.className = 'badge mode-badge local';
    } else {
        elBadge.innerHTML = '<i class="fa-solid fa-cloud"></i> CLOUD';
        elBadge.className = 'badge mode-badge cloud';
    }
}

function showLoader(text) {
    if (elLoader) elLoader.style.display = 'flex';
    if (elVideo)  elVideo.style.display  = 'none';
    if (elLoaderTxt) elLoaderTxt.textContent = text || '';
}

function hideLoader() {
    if (elLoader) elLoader.style.display = 'none';
    if (elVideo)  elVideo.style.display  = 'block';
}

function setStreamBtnState(state) {
    if (!elBtnStream) return;
    if (state === 'hidden') {
        elBtnStream.style.display = 'none';
    } else if (state === 'play') {
        elBtnStream.style.display = '';
        elBtnStream.innerHTML = '<i class="fa-solid fa-play"></i> Phát Luồng';
        elBtnStream.classList.remove('active');
    } else if (state === 'pause') {
        elBtnStream.style.display = '';
        elBtnStream.innerHTML = '<i class="fa-solid fa-pause"></i> Dừng Phát';
        elBtnStream.classList.add('active');
    }
}

function updateStatusUI(data) {
    if (!data) return;
    if (data.flash !== undefined) {
        flashOn = data.flash;
        updateFlashUI();
    }
    if (data.motion_detect !== undefined && elMotionSwitch) {
        elMotionSwitch.checked = data.motion_detect;
    }
    if (data.wifi_rssi !== undefined && elStatRssi) {
        const rssi = data.wifi_rssi;
        const q = rssi >= -60 ? 'Tốt' : rssi >= -75 ? 'Vừa' : 'Yếu';
        elStatRssi.textContent = `${rssi} dBm (${q})`;
    }
    if (data.free_heap !== undefined && elStatHeap) {
        elStatHeap.textContent = `${Math.round(data.free_heap / 1024)} KB`;
    }
}

function getSelectedMode() {
    if (elModeCloud && elModeCloud.checked) return 'cloud';
    return 'local';
}

function clearTimers() {
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
// FULLSCREEN
// ─────────────────────────────────────────────────────────────
function toggleFullscreen() {
    const wrap = document.getElementById('video-wrapper') || elVideo;
    if (!document.fullscreenElement) {
        wrap.requestFullscreen && wrap.requestFullscreen();
    } else {
        document.exitFullscreen && document.exitFullscreen();
    }
}

// ─────────────────────────────────────────────────────────────
// GALLERY (lưu ảnh chụp vào localStorage)
// ─────────────────────────────────────────────────────────────
const GALLERY_KEY = 'aether_gallery';

function saveToGallery(imgUrl, blob) {
    const reader = new FileReader();
    reader.onload = () => {
        const b64 = reader.result;
        const stored = JSON.parse(localStorage.getItem(GALLERY_KEY) || '[]');
        stored.unshift({ src: b64, ts: Date.now() });
        if (stored.length > 20) stored.pop(); // Giữ tối đa 20 ảnh
        localStorage.setItem(GALLERY_KEY, JSON.stringify(stored));
        renderGalleryItem(b64);
    };
    reader.readAsDataURL(blob);
}

function loadGalleryFromStorage() {
    const stored = JSON.parse(localStorage.getItem(GALLERY_KEY) || '[]');
    stored.forEach(item => renderGalleryItem(item.src));
}

function renderGalleryItem(src) {
    if (!elGallery) return;
    const img = document.createElement('img');
    img.src   = src;
    img.className = 'gallery-thumb';
    img.addEventListener('click', () => window.open(src, '_blank'));
    elGallery.prepend(img);
}

// ─────────────────────────────────────────────────────────────
// RADAR CANVAS (hiệu ứng khi chưa kết nối)
// ─────────────────────────────────────────────────────────────
function initRadarCanvas() {
    const canvas = document.getElementById('radar-canvas');
    if (!canvas) return;
    const ctx    = canvas.getContext('2d');
    let angle    = 0;
    const W      = canvas.width;
    const H      = canvas.height;
    const cx     = W / 2;
    const cy     = H / 2;
    const r      = Math.min(cx, cy) - 10;

    function drawRadar() {
        ctx.clearRect(0, 0, W, H);

        // Vòng tròn
        ctx.strokeStyle = 'rgba(0,242,254,0.2)';
        ctx.lineWidth   = 1;
        for (let i = 1; i <= 4; i++) {
            ctx.beginPath();
            ctx.arc(cx, cy, r * i / 4, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Tia quét
        const grad = ctx.createConicalGradient
            ? ctx.createConicalGradient(cx, cy, angle - 1, angle + 0.5)
            : null;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        const sweep = ctx.createLinearGradient(0, 0, r, 0);
        sweep.addColorStop(0,   'rgba(0,242,254,0.7)');
        sweep.addColorStop(1,   'rgba(0,242,254,0)');
        ctx.fillStyle = sweep;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r, -0.3, 0.3);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        angle += 0.04;
        requestAnimationFrame(drawRadar);
    }
    drawRadar();
}
