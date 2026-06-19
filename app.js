// ==========================================================================
// AETHER-EYE Survelliance Web Dashboard Controller
// ==========================================================================

let streamMode = 'local'; // 'local' or 'cloud'
let isConnected = false;
let wsClient = null;
let flashState = false;
let isStreamingActive = true;
let frameCount = 0;
let lastFpsUpdate = 0;
let fpsInterval = null;
let statusPollingInterval = null;
let db = null;

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let reconnectTimer = null;

// Mock camera simulation state
let mockAnimationId = null;
let mockAngle = 0;
let mockParticle = { x: 320, y: 240, dx: 3, dy: -2, radius: 10 };
let mockAlertCooldown = false;

// IndexedDB Configuration
const DB_NAME = "ESP32CamGallery";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";

// DOM Elements Cache
const ipInput = document.getElementById('ip-address');
const connectPrefix = document.getElementById('connection-prefix');
const btnConnect = document.getElementById('btn-connect');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const cameraStream = document.getElementById('camera-stream');
const mockCanvas = document.getElementById('mock-canvas');
const videoLoader = document.getElementById('video-loader');
const loaderText = document.getElementById('loader-text');
const streamFps = document.getElementById('stream-fps');
const streamRes = document.getElementById('stream-res');
const streamSourceBadge = document.getElementById('stream-source-badge');
const btnFlash = document.getElementById('btn-flash');
const alarmSound = document.getElementById('alarm-sound');
const motionOverlay = document.getElementById('motion-overlay');
const galleryGrid = document.getElementById('gallery-grid');

// Hardware Status Cards
const statRssi = document.getElementById('stat-rssi');
const statHeap = document.getElementById('stat-heap');

// Camera Settings Inputs
const settingMotion = document.getElementById('setting-motion');
const settingResolution = document.getElementById('setting-resolution');
const settingQuality = document.getElementById('setting-quality');
const settingBrightness = document.getElementById('setting-brightness');
const settingContrast = document.getElementById('setting-contrast');
const settingSaturation = document.getElementById('setting-saturation');
const settingVFlip = document.getElementById('setting-vflip');
const settingHMirror = document.getElementById('setting-hmirror');

// ==========================================================================
// LIFE CYCLE & INITIALIZATION
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
    initDatabase();
    updateConnectionPrefix();
    startMockCamera(); // Default state: show simulator radar screen
    
    // Load previously saved target IP/Domain
    const savedIP = localStorage.getItem('esp32_cam_ip');
    if (savedIP) {
        ipInput.value = savedIP;
    }
});

// Initialize IndexedDB database for saving photos locally
function initDatabase() {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = (e) => {
        console.error("IndexedDB failed to open:", e);
    };
    
    request.onsuccess = (e) => {
        db = e.target.result;
        loadFromGallery();
    };
    
    request.onupgradeneeded = (e) => {
        const dbInstance = e.target.result;
        if (!dbInstance.objectStoreNames.contains(STORE_NAME)) {
            dbInstance.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        }
    };
}

// ==========================================================================
// STREAM MODE SWITCH (LAN vs Cloud WAN)
// ==========================================================================
function switchStreamMode(mode) {
    if (isConnected) {
        disconnectFromCamera();
    }
    
    streamMode = mode;
    
    // Update button states in UI
    document.getElementById('btn-mode-local').classList.toggle('active', mode === 'local');
    document.getElementById('btn-mode-cloud').classList.toggle('active', mode === 'cloud');
    
    updateConnectionPrefix();
}

function updateConnectionPrefix() {
    if (streamMode === 'local') {
        connectPrefix.textContent = 'http://';
        ipInput.placeholder = '192.168.1.15';
        if (ipInput.value.startsWith('ws') || ipInput.value.includes('.onrender.com')) {
            ipInput.value = '192.168.1.15';
        }
    } else {
        connectPrefix.textContent = 'wss://';
        ipInput.placeholder = 'your-relay.onrender.com';
        if (ipInput.value === '192.168.1.15') {
            ipInput.value = '';
        }
    }
}

// ==========================================================================
// CONNECTION MANAGEMENT FLOW
// ==========================================================================
function toggleConnection() {
    if (isConnected) {
        disconnectFromCamera();
    } else {
        connectToCamera();
    }
}

function connectToCamera() {
    const target = ipInput.value.trim();
    if (!target) {
        alert("Vui lòng nhập địa chỉ IP mạng LAN hoặc Domain máy chủ Relay!");
        return;
    }
    
    // Cache connection target
    localStorage.setItem('esp32_cam_ip', target);
    
    isConnected = true;
    
    // Update Connection Button state
    btnConnect.innerHTML = '<i class="fa-solid fa-stop"></i> Ngắt kết nối';
    btnConnect.className = 'action-btn connect-btn connected';
    
    // Set Status Dot to Connecting
    statusDot.className = 'dot connecting';
    statusText.textContent = 'Đang kết nối...';
    
    // Show spinner overlay
    videoLoader.style.opacity = '1';
    videoLoader.style.display = 'flex';
    loaderText.textContent = streamMode === 'local' ? 'Đang gửi gói chẩn đoán tới IP...' : 'Đang kết nối WebSocket Cloud...';

    stopMockCamera();

    if (streamMode === 'local') {
        connectLocal(target);
    } else {
        connectCloud(target);
    }
}

function disconnectFromCamera() {
    isConnected = false;
    
    // Clear WebSocket Client
    if (wsClient) {
        wsClient.close();
        wsClient = null;
    }
    
    // Clear reconnect timer
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    reconnectAttempts = 0;
    
    // Clear polling timers
    if (statusPollingInterval) {
        clearInterval(statusPollingInterval);
        statusPollingInterval = null;
    }
    
    // Clear FPS meter
    if (fpsInterval) {
        clearInterval(fpsInterval);
        fpsInterval = null;
    }
    
    // Reset indicators
    streamFps.innerHTML = '<i class="fa-solid fa-gauge-high"></i> 0 FPS';
    streamSourceBadge.innerHTML = '<i class="fa-solid fa-circle-play"></i> MOCK MODE';
    streamSourceBadge.className = 'badge mode-badge';
    
    statRssi.textContent = '--';
    statHeap.textContent = '--';
    
    // Toggle video layers
    cameraStream.style.display = 'none';
    cameraStream.src = '';
    
    // Re-initialize mock canvas loop
    startMockCamera();
    videoLoader.style.display = 'none';
    
    // Reset Play button state
    isStreamingActive = true;
    const streamToggleBtn = document.getElementById('btn-stream-toggle');
    streamToggleBtn.innerHTML = '<i class="fa-solid fa-pause"></i> Dừng Phát';
    streamToggleBtn.classList.remove('paused');
    
    // Reset Connect Button in Header
    btnConnect.innerHTML = '<i class="fa-solid fa-play"></i> Kết nối';
    btnConnect.className = 'action-btn connect-btn';
    
    statusDot.className = 'dot disconnected';
    statusText.textContent = 'Chưa kết nối';
}

// --------------------------------------------------------------------------
// Mode LAN (Cục bộ): HTTP REST & MJPEG Stream
// --------------------------------------------------------------------------
function connectLocal(ip) {
    const statusUrl = `http://${ip}/status`;
    const streamUrl = `http://${ip}/stream`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500); // 3.5s connect timeout
    
    fetch(statusUrl, { signal: controller.signal })
        .then(response => {
            if (!response.ok) throw new Error("Chẩn đoán cổng status thất bại");
            return response.json();
        })
        .then(data => {
            clearTimeout(timeoutId);
            
            // Connection success
            statusDot.className = 'dot connected';
            statusText.textContent = 'Đã kết nối LAN';
            streamSourceBadge.innerHTML = '<i class="fa-solid fa-wifi"></i> LAN DIRECT';
            streamSourceBadge.className = 'badge mode-badge';
            
            // Sync camera setting variables in UI
            syncSettingsFromData(data);
            
            // Hide Loader & Display stream image
            videoLoader.style.display = 'none';
            cameraStream.style.display = 'block';
            cameraStream.src = streamUrl;
            
            // Display estimated LAN FPS
            streamFps.innerHTML = '<i class="fa-solid fa-gauge-high"></i> ~15 FPS';
            
            // Periodically poll /status every 3 seconds to keep UI synced and fetch RSSI/Heap
            statusPollingInterval = setInterval(() => {
                pollLocalStatus(ip);
            }, 3000);
        })
        .catch(err => {
            clearTimeout(timeoutId);
            console.error("Local connection diagnostic error:", err);
            disconnectFromCamera();
            alert("Không thể kết nối đến ESP32-CAM! Vui lòng kiểm tra lại địa chỉ IP và đảm bảo thiết bị đã khởi động.");
        });
}

function pollLocalStatus(ip) {
    fetch(`http://${ip}/status`)
        .then(r => r.json())
        .then(data => {
            syncSettingsFromData(data);
        })
        .catch(e => console.warn("Failed to retrieve status telemetry:", e));
}

// --------------------------------------------------------------------------
// Mode Cloud (Từ xa): WebSocket Relay
// --------------------------------------------------------------------------
function connectCloud(domain) {
    const wsUrl = `wss://${domain}/client`;
    let lastBlobUrl = null;
    
    try {
        wsClient = new WebSocket(wsUrl);
        wsClient.binaryType = 'blob';
        
        wsClient.onopen = () => {
            reconnectAttempts = 0;
            statusDot.className = 'dot connected';
            statusText.textContent = 'Đã kết nối Cloud';
            streamSourceBadge.innerHTML = '<i class="fa-solid fa-cloud"></i> CLOUD RELAY';
            streamSourceBadge.className = 'badge mode-badge';
            
            // KHÔNG tự động phát stream – chờ người dùng nhấn nút.
            // start_stream buộc ESP32 cấp phát PSRAM cho frame buffer
            // nếu PSRAM không đủ → crash → mất kết nối liên tục.
            isStreamingActive = false;
            
            // Hiển thị nút Play cho user nhấn khi sẵn sàng
            videoLoader.style.display = 'flex';
            cameraStream.style.display = 'none';
            loaderText.textContent = 'Camera đã kết nối. Nhấn ▶ Phát Luồng để bắt đầu xem.';
            
            const streamBtn = document.getElementById('btn-stream-toggle');
            if (streamBtn) {
                streamBtn.innerHTML = '<i class="fa-solid fa-play"></i> Phát Luồng';
                streamBtn.classList.add('paused');
            }
            
            startFpsCounter();
        };

        
        wsClient.onmessage = (event) => {
            if (event.data instanceof Blob) {
                // Free memory by revoking previous frame URL
                if (lastBlobUrl) {
                    URL.revokeObjectURL(lastBlobUrl);
                }
                
                lastBlobUrl = URL.createObjectURL(event.data);
                cameraStream.src = lastBlobUrl;
                frameCount++;
            } else {
                // Process JSON message broadcast from server (or camera)
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'status') {
                        if (msg.camera === 'offline') {
                            statusDot.className = 'dot connecting';
                            statusText.textContent = 'Chờ Camera...';
                            cameraStream.style.display = 'none';
                            videoLoader.style.display = 'flex';
                            loaderText.textContent = 'Đang chờ ESP32-CAM đăng ký trực tuyến...';
                        } else if (msg.camera === 'online') {
                            statusDot.className = 'dot connected';
                            statusText.textContent = 'Đã kết nối Cloud';
                            
                            // Camera vừa online: KHÔNG tự gửi start_stream.
                            // Để người dùng tự nhấn nút Phát Luồng.
                            // (Gửi start_stream ngay sau connect → ESP32 crash do thiếu PSRAM)
                            videoLoader.style.display = 'flex';
                            cameraStream.style.display = 'none';
                            loaderText.textContent = 'Camera đã kết nối. Nhấn ▶ Phát Luồng để bắt đầu xem.';
                            isStreamingActive = false;
                            
                            const streamBtn = document.getElementById('btn-stream-toggle');
                            if (streamBtn) {
                                streamBtn.innerHTML = '<i class="fa-solid fa-play"></i> Phát Luồng';
                                streamBtn.classList.add('paused');
                            }
                        }
                    }
                } catch(e) {
                    console.log("WS Text payload parsed as raw text:", event.data);
                }
            }
        };
        
        wsClient.onclose = () => {
            if (lastBlobUrl) {
                URL.revokeObjectURL(lastBlobUrl);
                lastBlobUrl = null;
            }
            if (isConnected) {
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts++;
                    statusDot.className = 'dot connecting';
                    statusText.textContent = `Kết nối lại (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`;
                    videoLoader.style.display = 'flex';
                    loaderText.textContent = `Mất kết nối với Cloud. Đang thử kết nối lại lần ${reconnectAttempts}...`;
                    
                    reconnectTimer = setTimeout(() => {
                        console.log(`Reconnecting attempt ${reconnectAttempts}...`);
                        connectCloud(domain);
                    }, 3000);
                } else {
                    disconnectFromCamera();
                    alert("Mất kết nối hoàn toàn với máy chủ Cloud Relay!");
                }
            }
        };
        
        wsClient.onerror = (err) => {
            console.error("WebSocket error:", err);
            // close event will trigger connection retry
        };
        
    } catch (e) {
        console.error(e);
        disconnectFromCamera();
    }
}

// Update UI options from hardware JSON reports
function syncSettingsFromData(data) {
    if (data.flash !== undefined) {
        flashState = data.flash;
        updateFlashUIState();
    }
    if (data.motion_detect !== undefined) {
        settingMotion.checked = data.motion_detect;
    }
    
    // Render status block cards
    if (data.wifi_rssi !== undefined) {
        let signalLabel = "Tốt";
        const rssi = data.wifi_rssi;
        if (rssi < -85) signalLabel = "Yếu";
        else if (rssi < -70) signalLabel = "Vừa";
        
        statRssi.textContent = `${rssi} dBm (${signalLabel})`;
    }
    if (data.free_heap !== undefined) {
        statHeap.textContent = `${Math.round(data.free_heap / 1024)} KB`;
    }
}

// FPS calculator for Cloud Mode binary streams
function startFpsCounter() {
    frameCount = 0;
    lastFpsUpdate = performance.now();
    
    fpsInterval = setInterval(() => {
        const now = performance.now();
        const elapsed = (now - lastFpsUpdate) / 1000;
        lastFpsUpdate = now;
        
        if (isStreamingActive) {
            const fps = Math.round(frameCount / elapsed);
            streamFps.innerHTML = `<i class="fa-solid fa-gauge-high"></i> ${fps} FPS`;
        } else {
            streamFps.innerHTML = `<i class="fa-solid fa-gauge-high"></i> 0 FPS`;
        }
        frameCount = 0;
    }, 1000);
}

// ==========================================================================
// CAMERA HARDWARE INTERACTIVE CONTROLS
// ==========================================================================

// Gửi trực tiếp lệnh tới Cloud WebSocket
function sendCloudControlCommand(command) {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(command);
    }
}

function updateCamSetting(variable, val) {
    if (isConnected) {
        if (streamMode === 'local') {
            fetch(`http://${ipInput.value}/control?var=${variable}&val=${val}`)
                .catch(e => console.error("Control API Error:", e));
        } else {
            sendCloudControlCommand(`control:${variable}:${val}`);
        }
    }
}

// Toggle Flash LED (GPIO 4 of ESP32-CAM)
function toggleFlash() {
    flashState = !flashState;
    updateFlashUIState();
    
    if (isConnected) {
        const val = flashState ? '1' : '0';
        if (streamMode === 'local') {
            fetch(`http://${ipInput.value}/control?var=flash&val=${val}`)
                .catch(e => console.error("API error flash control:", e));
        } else {
            // Relay understands 'flash_on' / 'flash_off' as direct shortcuts
            sendCloudControlCommand(flashState ? 'flash_on' : 'flash_off');
        }
    }
}

function updateFlashUIState() {
    if (flashState) {
        btnFlash.classList.add('active');
        btnFlash.innerHTML = '<i class="fa-solid fa-lightbulb"></i> Flash: BẬT';
    } else {
        btnFlash.classList.remove('active');
        btnFlash.innerHTML = '<i class="fa-solid fa-lightbulb"></i> Flash: TẮT';
    }
}

// Toggle Hardware motion detection on the chip
function toggleHardwareMotion() {
    const isEnabled = settingMotion.checked;
    const val = isEnabled ? '1' : '0';
    
    if (isConnected) {
        if (streamMode === 'local') {
            fetch(`http://${ipInput.value}/control?var=motion&val=${val}`)
                .catch(e => console.error("API error motion control:", e));
        } else {
            sendCloudControlCommand(`control:motion:${val}`);
        }
    }
}

// Adjust camera sensor resolution (FRAMESIZE)
function changeResolution(val) {
    updateCamSetting('framesize', val);
    
    const textMap = {
        "10": "UXGA",
        "9": "SXGA",
        "8": "XGA",
        "7": "SVGA",
        "6": "VGA",
        "5": "CIF",
        "4": "QVGA"
    };
    streamRes.textContent = textMap[val] || "VGA";
}

// Adjust JPEG quality compression
function changeQuality(val) {
    updateCamSetting('quality', val);
}

// Handle real-time visual UI value labels
function updateRangeLabel(type, val) {
    const valDisplay = document.getElementById(`val-${type}`);
    if (valDisplay) {
        valDisplay.textContent = val;
    }
}

// Play / Pause rendering stream
function toggleStreamState() {
    if (!isConnected) return;
    
    isStreamingActive = !isStreamingActive;
    const btn = document.getElementById('btn-stream-toggle');
    
    if (isStreamingActive) {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i> Dừng Phát';
        btn.classList.remove('paused');
        
        if (streamMode === 'local') {
            cameraStream.src = `http://${ipInput.value}/stream`;
            streamFps.innerHTML = '<i class="fa-solid fa-gauge-high"></i> ~15 FPS';
        } else if (wsClient) {
            wsClient.send('start_stream');
        }
    } else {
        btn.innerHTML = '<i class="fa-solid fa-play"></i> Phát Luồng';
        btn.classList.add('paused');
        
        if (streamMode === 'local') {
            cameraStream.src = '';
            streamFps.innerHTML = '<i class="fa-solid fa-gauge-high"></i> 0 FPS';
        } else if (wsClient) {
            wsClient.send('stop_stream');
        }
    }
}

// Fullscreen rendering viewport
function toggleFullscreen() {
    const container = document.getElementById('video-container');
    if (!document.fullscreenElement) {
        container.requestFullscreen().catch(err => {
            console.error("Failed to open fullscreen:", err);
        });
    } else {
        document.exitFullscreen();
    }
}

// ==========================================================================
// MOCK CAMERA RADAR SIMULATOR (Demonstration mode)
// ==========================================================================
function startMockCamera() {
    mockCanvas.style.display = 'block';
    
    mockCanvas.width = 640;
    mockCanvas.height = 480;
    
    mockAngle = 0;
    const ctx = mockCanvas.getContext('2d');
    
    function drawRadar() {
        if (!ctx || mockCanvas.style.display === 'none') return;
        
        // Background
        ctx.fillStyle = '#05070e';
        ctx.fillRect(0, 0, 640, 480);
        
        // CSS Filters from settings (simulated overlay filters)
        const b = parseInt(settingBrightness.value);
        const c = parseInt(settingContrast.value);
        const s = parseInt(settingSaturation.value);
        
        ctx.filter = `brightness(${100 + b * 20}%) contrast(${100 + c * 20}%) saturate(${100 + s * 25}%)`;
        
        if (settingVFlip.checked && settingHMirror.checked) {
            ctx.translate(640, 480); ctx.scale(-1, -1);
        } else if (settingVFlip.checked) {
            ctx.translate(0, 480); ctx.scale(1, -1);
        } else if (settingHMirror.checked) {
            ctx.translate(640, 0); ctx.scale(-1, 1);
        }

        // Radar circle grids
        ctx.strokeStyle = 'rgba(0, 242, 254, 0.06)';
        ctx.lineWidth = 1;
        for (let r = 80; r <= 320; r += 80) {
            ctx.beginPath();
            ctx.arc(320, 240, r, 0, Math.PI * 2);
            ctx.stroke();
        }
        
        // Cross lines
        ctx.beginPath();
        ctx.moveTo(320, 20); ctx.lineTo(320, 460);
        ctx.moveTo(20, 240); ctx.lineTo(620, 240);
        ctx.stroke();
        
        // Bouncing Target Particle (Simulated object)
        ctx.fillStyle = 'rgba(139, 92, 246, 0.7)';
        ctx.beginPath();
        ctx.arc(mockParticle.x, mockParticle.y, mockParticle.radius, 0, Math.PI * 2);
        ctx.fill();
        
        // Physics update
        mockParticle.x += mockParticle.dx;
        mockParticle.y += mockParticle.dy;
        if (mockParticle.x - mockParticle.radius <= 40 || mockParticle.x + mockParticle.radius >= 600) {
            mockParticle.dx = -mockParticle.dx;
        }
        if (mockParticle.y - mockParticle.radius <= 40 || mockParticle.y + mockParticle.radius >= 440) {
            mockParticle.dy = -mockParticle.dy;
        }
        
        // Sweeper scanner line
        ctx.strokeStyle = 'rgba(0, 242, 254, 0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(320, 240);
        mockAngle += 0.012;
        const targetX = 320 + 300 * Math.cos(mockAngle);
        const targetY = 240 + 300 * Math.sin(mockAngle);
        ctx.lineTo(targetX, targetY);
        ctx.stroke();
        
        // Reset transformation if applied
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.filter = 'none';

        // HUD overlay text
        ctx.fillStyle = 'rgba(0, 242, 254, 0.8)';
        ctx.font = "bold 13px Outfit, sans-serif";
        ctx.fillText("SIMULATION MODE - CHƯA KẾT NỐI PHẦN CỨNG", 20, 30);
        
        const timestamp = new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString();
        ctx.fillStyle = '#6b7280';
        ctx.font = "12px monospace";
        ctx.fillText(timestamp, 20, 460);
        
        // Trigger simulated motion alarm if enabled in Mock Mode
        if (settingMotion.checked && !mockAlertCooldown) {
            // Random chance or speed calculation
            const dxAngle = Math.atan2(mockParticle.y - 240, mockParticle.x - 320);
            const angleDiff = Math.abs((mockAngle % (Math.PI * 2)) - (dxAngle < 0 ? dxAngle + Math.PI * 2 : dxAngle));
            if (angleDiff < 0.05) {
                triggerMockMotionAlarm();
            }
        }
        
        mockAnimationId = requestAnimationFrame(drawRadar);
    }
    mockAnimationId = requestAnimationFrame(drawRadar);
}

function stopMockCamera() {
    if (mockAnimationId) {
        cancelAnimationFrame(mockAnimationId);
        mockAnimationId = null;
    }
    mockCanvas.style.display = 'none';
}

function triggerMockMotionAlarm() {
    mockAlertCooldown = true;
    
    // Flashing red HUD
    motionOverlay.classList.add('active');
    
    // Sound
    alarmSound.volume = 0.3;
    alarmSound.play().catch(() => {});
    
    // Capture snapshot of simulated canvas
    setTimeout(() => {
        captureMockFrame();
    }, 150);
    
    setTimeout(() => {
        motionOverlay.classList.remove('active');
    }, 2000);
    
    // 8 seconds cooldown to prevent flooding DB
    setTimeout(() => {
        mockAlertCooldown = false;
    }, 8000);
}

function captureMockFrame() {
    mockCanvas.toBlob((blob) => {
        saveSnapshotToDB(blob, "CẢNH BÁO");
    }, 'image/jpeg', 0.85);
}

// ==========================================================================
// SNAPSHOT ARCHIVING & GALLERY STORAGE (IndexedDB)
// ==========================================================================
function takeSnapshot() {
    // Button click animation
    const btn = document.getElementById('btn-capture');
    btn.style.transform = 'scale(0.95)';
    setTimeout(() => btn.style.transform = 'scale(1)', 100);
    
    if (isConnected && streamMode === 'local') {
        // Fetch High Resolution JPEG frame directly from device REST endpoint
        fetch(`http://${ipInput.value}/capture`)
            .then(res => {
                if (!res.ok) throw new Error("Chụp ảnh thất bại");
                return res.blob();
            })
            .then(blob => {
                saveSnapshotToDB(blob, "THỦ CÔNG");
            })
            .catch(err => {
                console.warn("Chụp ảnh trực tiếp lỗi, chụp ảnh từ nguồn canvas luồng stream", err);
                captureStreamElement();
            });
    } else {
        // Capture from WebSocket stream image or Mock canvas
        captureStreamElement();
    }
}

// Extract picture frame from current display tag
function captureStreamElement() {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    
    if (mockCanvas.style.display === 'block') {
        ctx.drawImage(mockCanvas, 0, 0, 640, 480);
    } else if (cameraStream.style.display === 'block') {
        ctx.drawImage(cameraStream, 0, 0, 640, 480);
    } else {
        return; // Nothing currently visible to save
    }
    
    canvas.toBlob((blob) => {
        saveSnapshotToDB(blob, "THỦ CÔNG");
    }, 'image/jpeg', 0.88);
}

function saveSnapshotToDB(blob, type) {
    if (!db) {
        console.error("IndexedDB database not active");
        return;
    }
    
    const timestamp = new Date().toLocaleTimeString() + " " + new Date().toLocaleDateString();
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    
    const entry = {
        image: blob,
        timestamp: timestamp,
        type: type
    };
    
    const request = store.add(entry);
    request.onsuccess = () => {
        console.log("Snapshot successfully written to IndexedDB store.");
        loadFromGallery();
    };
    request.onerror = (e) => {
        console.error("Failed to write to DB:", e);
    };
}

function loadFromGallery() {
    if (!db) return;
    
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    
    request.onsuccess = (event) => {
        const items = event.target.result;
        
        // Show newest images first
        items.reverse();
        
        if (items.length === 0) {
            galleryGrid.innerHTML = `
                <div class="gallery-empty">
                    <i class="fa-regular fa-image"></i>
                    <p>Chưa có ảnh chụp nào trong thư viện.</p>
                </div>
            `;
            return;
        }
        
        galleryGrid.innerHTML = "";
        
        items.forEach(item => {
            const blobUrl = URL.createObjectURL(item.image);
            const isMotion = item.type === "CẢNH BÁO";
            
            const itemDiv = document.createElement('div');
            itemDiv.className = 'gallery-item';
            
            itemDiv.innerHTML = `
                <img src="${blobUrl}" onclick="openLightbox('${blobUrl}', '${item.type} - ${item.timestamp}')" alt="Surveillance frame">
                <div class="item-overlay">
                    <div class="item-meta">
                        <span class="item-time">${item.timestamp.split(' ')[0]}</span>
                        <span class="item-type ${isMotion ? 'motion' : ''}">${item.type}</span>
                    </div>
                    <div class="item-actions">
                        <a href="${blobUrl}" download="aether_eye_${item.timestamp.replace(/[:\s]/g, '_')}.jpg" class="action-icon" title="Tải xuống">
                            <i class="fa-solid fa-download"></i>
                        </a>
                        <button class="action-icon delete-btn" onclick="deleteSnapshot(${item.id})" title="Xóa">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>
                </div>
            `;
            
            galleryGrid.appendChild(itemDiv);
        });
    };
}

function deleteSnapshot(id) {
    if (!db) return;
    
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    
    request.onsuccess = () => {
        loadFromGallery();
    };
}

function clearGallery() {
    if (!db) return;
    if (!confirm("Bạn có chắc chắn muốn xóa toàn bộ hình ảnh trong thư viện lưu trữ?")) return;
    
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();
    
    request.onsuccess = () => {
        loadFromGallery();
    };
}

// ==========================================================================
// LIGHTBOX FULL PREVIEW
// ==========================================================================
function openLightbox(src, caption) {
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    const lightboxCaption = document.getElementById('lightbox-caption');
    
    lightbox.style.display = "block";
    lightboxImg.src = src;
    lightboxCaption.textContent = caption;
}

function closeLightbox() {
    document.getElementById('lightbox').style.display = "none";
}
