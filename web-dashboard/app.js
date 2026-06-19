// ==========================================================================
// CONFIGURATION & GLOBAL STATE
// ==========================================================================
let streamMode = 'local'; // 'local' or 'cloud'
let isConnected = false;
let wsClient = null;
let streamInterval = null;
let fpsInterval = null;
let flashState = false;
let isStreamingActive = true;

// Mock mode simulation variables
let mockAnimationId = null;
let mockAngle = 0;
let mockParticle = { x: 100, y: 150, dx: 3, dy: 2, radius: 15 };

// Image processing and Motion Detection variables
let prevFrameData = null;
let motionDetectionActive = false;
let motionCooldown = false;
let motionThreshold = 15; // Calculated from sensitivity
let lastFpsUpdate = 0;
let frameCount = 0;

// IndexedDB reference
let db = null;
const DB_NAME = "ESP32CamGallery";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";

// DOM Elements
const ipInput = document.getElementById('ip-address');
const connectPrefix = document.getElementById('connection-prefix');
const btnConnect = document.getElementById('btn-connect');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const cameraStream = document.getElementById('camera-stream');
const videoLoader = document.getElementById('video-loader');
const loaderText = document.getElementById('loader-text');
const streamFps = document.getElementById('stream-fps');
const streamRes = document.getElementById('stream-res');
const streamSourceBadge = document.getElementById('stream-source-badge');
const btnFlash = document.getElementById('btn-flash');
const alarmSound = document.getElementById('alarm-sound');
const motionOverlay = document.getElementById('motion-overlay');
const galleryGrid = document.getElementById('gallery-grid');

// Off-screen canvas for motion analysis
const motionCanvas = document.getElementById('motion-canvas');
const motionCtx = motionCanvas.getContext('2d');
// Mock canvas
const mockCanvas = document.getElementById('mock-canvas');
const mockCtx = mockCanvas.getContext('2d');

// Settings Elements
const settingMotion = document.getElementById('setting-motion');
const settingSensitivity = document.getElementById('setting-sensitivity');
const settingResolution = document.getElementById('setting-resolution');
const settingBrightness = document.getElementById('setting-brightness');
const settingContrast = document.getElementById('setting-contrast');
const settingSaturation = document.getElementById('setting-saturation');
const settingVFlip = document.getElementById('setting-vflip');
const settingHMirror = document.getElementById('setting-hmirror');

// ==========================================================================
// INITIALIZATION & DATABASE SETUP
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
    initDatabase();
    initMockCamera(); // Start mock animation by default
    updateConnectionPrefix();
    
    // Check if IP was previously saved
    const savedIP = localStorage.getItem('esp32_cam_ip');
    if (savedIP) ipInput.value = savedIP;
});

// Initialize IndexedDB
function initDatabase() {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = (event) => {
        console.error("IndexedDB error:", event.target.errorCode);
    };
    
    request.onsuccess = (event) => {
        db = event.target.result;
        loadFromGallery();
    };
    
    request.onupgradeneeded = (event) => {
        const dbInstance = event.target.result;
        dbInstance.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
    };
}

// ==========================================================================
// CONNECTION MODE SWITCH (LAN Cục bộ vs Cloud Từ xa)
// ==========================================================================
function switchStreamMode(mode) {
    if (isConnected) {
        // Disconnect first if active
        toggleConnection();
    }
    
    streamMode = mode;
    
    // Update active UI classes
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
// CONNECT / DISCONNECT LOGIC
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
        alert("Vui lòng nhập địa chỉ IP hoặc tên miền Server!");
        return;
    }
    
    // Save IP setting
    localStorage.setItem('esp32_cam_ip', target);
    
    isConnected = true;
    btnConnect.innerHTML = '<i class="fa-solid fa-stop"></i> Ngắt kết nối';
    btnConnect.className = 'action-btn connect-btn connected';
    
    statusDot.className = 'dot connecting';
    statusText.textContent = 'Đang kết nối...';
    
    videoLoader.style.opacity = '1';
    videoLoader.style.display = 'flex';
    loaderText.textContent = streamMode === 'local' ? 'Đang kết nối luồng MJPEG LAN...' : 'Đang thiết lập WebSocket Cloud...';

    // Stop default mock mode render loop
    stopMockCamera();

    if (streamMode === 'local') {
        connectLocal(target);
    } else {
        connectCloud(target);
    }
}

function disconnectFromCamera() {
    isConnected = false;
    btnConnect.innerHTML = '<i class="fa-solid fa-play"></i> Kết nối';
    btnConnect.className = 'action-btn connect-btn';
    
    statusDot.className = 'dot disconnected';
    statusText.textContent = 'Chưa kết nối';
    
    cameraStream.style.display = 'none';
    cameraStream.src = '';
    
    if (wsClient) {
        wsClient.close();
        wsClient = null;
    }
    
    clearInterval(fpsInterval);
    fpsInterval = null;
    
    // Reset badges
    streamFps.textContent = '0 FPS';
    streamSourceBadge.textContent = 'MOCK MODE';
    streamSourceBadge.className = 'badge mode-badge';
    
    // Return to mock simulation
    initMockCamera();
    videoLoader.style.display = 'none';
    
    // Reset stream toggle button state
    isStreamingActive = true;
    const streamToggleBtn = document.getElementById('btn-stream-toggle');
    if (streamToggleBtn) {
        streamToggleBtn.innerHTML = '<i class="fa-solid fa-pause"></i> Dừng Phát';
        streamToggleBtn.classList.remove('paused');
    }
}

// Local stream connection (LAN)
function connectLocal(ip) {
    const streamUrl = `http://${ip}/stream`;
    
    // Test connection first using fetch on status endpoint
    const statusUrl = `http://${ip}/status`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500); // 3.5s connection timeout
    
    fetch(statusUrl, { signal: controller.signal })
        .then(response => response.json())
        .then(data => {
            clearTimeout(timeoutId);
            statusDot.className = 'dot connected';
            statusText.textContent = 'Đã kết nối LAN';
            streamSourceBadge.textContent = 'LAN DIRECT';
            streamSourceBadge.className = 'badge mode-badge';
            
            // Sync settings UI with ESP32 status
            settingFlash(data.flash);
            settingMotion.checked = data.motion_detect;
            
            // Display stream image
            videoLoader.style.display = 'none';
            cameraStream.style.display = 'block';
            cameraStream.src = streamUrl;
            
            // Start local FPS / connection monitor
            startFpsCounter();
            startLocalMotionDetectionLoop();
        })
        .catch(err => {
            clearTimeout(timeoutId);
            console.warn("Không kết nối được ESP32-CAM thật, tự động chuyển sang MOCK MODE để thử nghiệm.", err);
            startMockMode("Lỗi kết nối LAN. Đang chạy giả lập...");
        });
}

// Cloud stream connection (WSS)
function connectCloud(domain) {
    const wsUrl = `wss://${domain}/client`;
    
    try {
        wsClient = new WebSocket(wsUrl);
        wsClient.binaryType = 'blob';
        
        let lastReceivedBlobUrl = null;
        
        wsClient.onopen = () => {
            statusDot.className = 'dot connected';
            statusText.textContent = 'Đã kết nối Cloud';
            streamSourceBadge.textContent = 'CLOUD RELAY';
            streamSourceBadge.className = 'badge mode-badge';
            
            videoLoader.style.display = 'none';
            cameraStream.style.display = 'block';
            
            // Không tự động phát luồng khi kết nối để tránh nghẽn lệnh trên ESP32-CAM
            isStreamingActive = false;
            const streamToggleBtn = document.getElementById('btn-stream-toggle');
            if (streamToggleBtn) {
                streamToggleBtn.innerHTML = '<i class="fa-solid fa-play"></i> Phát Luồng';
                streamToggleBtn.classList.add('paused');
            }
            
            startFpsCounter();
        };
        
        wsClient.onmessage = (event) => {
            if (event.data instanceof Blob) {
                // Revoke old URL to avoid memory leak
                if (lastReceivedBlobUrl) {
                    URL.revokeObjectURL(lastReceivedBlobUrl);
                }
                
                lastReceivedBlobUrl = URL.createObjectURL(event.data);
                cameraStream.src = lastReceivedBlobUrl;
                frameCount++;
                
                // Do browser side motion detection if enabled
                if (motionDetectionActive) {
                    processMotionDetection(cameraStream);
                }
            } else {
                // Text messages like status notifications
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'status') {
                        if (msg.flash !== undefined) {
                            settingFlash(msg.flash);
                        }
                        if (msg.motion !== undefined) {
                            settingMotion.checked = msg.motion;
                        }
                    }
                } catch(e) {
                    console.log("WebSocket text message:", event.data);
                }
            }
        };
        
        wsClient.onclose = () => {
            if (isConnected) {
                disconnectFromCamera();
                alert("Đã mất kết nối với Cloud Server!");
            }
        };
        
        wsClient.onerror = (err) => {
            console.error("WebSocket error:", err);
            startMockMode("Lỗi WebSocket. Đang chạy giả lập...");
        };
        
    } catch (e) {
        console.error(e);
        startMockMode("Lỗi thiết lập mạng. Đang chạy giả lập...");
    }
}

// Auto fallback or manual start for simulation mode
function startMockMode(message) {
    statusDot.className = 'dot connected';
    statusText.textContent = 'ĐANG GIẢ LẬP';
    streamSourceBadge.textContent = 'DEMO STREAM';
    streamSourceBadge.className = 'badge mode-badge';
    
    loaderText.textContent = message;
    setTimeout(() => {
        videoLoader.style.display = 'none';
        cameraStream.style.display = 'none';
        initMockCamera();
        startFpsCounter();
    }, 1500);
}

// ==========================================
// FPS COUNTER MONITOR
// ==========================================
function startFpsCounter() {
    frameCount = 0;
    lastFpsUpdate = performance.now();
    
    fpsInterval = setInterval(() => {
        const now = performance.now();
        const elapsed = (now - lastFpsUpdate) / 1000;
        lastFpsUpdate = now;
        
        // Calculate FPS
        const fps = Math.round(frameCount / elapsed);
        streamFps.textContent = `${fps} FPS`;
        frameCount = 0;
    }, 1000);
}

// ==========================================
// MOCK CAMERA SIMULATOR (Vẽ canvas động đẹp mắt)
// ==========================================
function initMockCamera() {
    mockCanvas.style.display = 'block';
    
    // Fit canvas resolution to actual VGA
    mockCanvas.width = 640;
    mockCanvas.height = 480;
    
    mockAngle = 0;
    
    function drawFrame() {
        if (!mockCtx) return;
        
        // 1. Draw solid background
        mockCtx.fillStyle = '#060812';
        mockCtx.fillRect(0, 0, 640, 480);
        
        // 2. Draw high tech radar grid pattern
        mockCtx.strokeStyle = 'rgba(0, 242, 254, 0.05)';
        mockCtx.lineWidth = 1;
        for (let i = 0; i < 640; i += 40) {
            mockCtx.beginPath();
            mockCtx.moveTo(i, 0);
            mockCtx.lineTo(i, 480);
            mockCtx.stroke();
        }
        for (let j = 0; j < 480; j += 40) {
            mockCtx.beginPath();
            mockCtx.moveTo(0, j);
            mockCtx.lineTo(640, j);
            mockCtx.stroke();
        }

        // Apply CSS filters from sliders if simulated
        let filterStr = "";
        const brightness = settingBrightness.value;
        const contrast = settingContrast.value;
        const saturation = settingSaturation.value;
        
        // Convert ESP32 controls (-2 to 2) to CSS filter percentages
        mockCtx.filter = `
            brightness(${100 + brightness * 25}%) 
            contrast(${100 + contrast * 25}%) 
            saturate(${100 + saturation * 25}%)
        `;

        // 3. Draw moving test particle (simulates motion to trigger detector)
        mockCtx.fillStyle = 'rgba(112, 0, 255, 0.7)';
        mockCtx.beginPath();
        mockCtx.arc(mockParticle.x, mockParticle.y, mockParticle.radius, 0, Math.PI * 2);
        mockCtx.fill();
        
        // Update particle physics
        mockParticle.x += mockParticle.dx;
        mockParticle.y += mockParticle.dy;
        if (mockParticle.x - mockParticle.radius <= 0 || mockParticle.x + mockParticle.radius >= 640) {
            mockParticle.dx = -mockParticle.dx;
        }
        if (mockParticle.y - mockParticle.radius <= 0 || mockParticle.y + mockParticle.radius >= 480) {
            mockParticle.dy = -mockParticle.dy;
        }

        // 4. Draw Rotating central lens
        mockCtx.strokeStyle = 'rgba(0, 242, 254, 0.4)';
        mockCtx.lineWidth = 2;
        mockCtx.beginPath();
        mockCtx.arc(320, 240, 90, 0, Math.PI * 2);
        mockCtx.stroke();
        
        mockCtx.strokeStyle = 'rgba(112, 0, 255, 0.6)';
        mockCtx.lineWidth = 3;
        mockCtx.beginPath();
        mockAngle += 0.015;
        mockCtx.arc(320, 240, 110, mockAngle, mockAngle + Math.PI * 0.75);
        mockCtx.stroke();
        
        // 5. Text overlays (Timestamp and Tech graphics)
        mockCtx.filter = 'none'; // reset filter for text UI
        mockCtx.font = "bold 14px Outfit, sans-serif";
        mockCtx.fillStyle = 'rgba(0, 242, 254, 0.8)';
        mockCtx.fillText("AETHER-EYE MOCK SIMULATION", 20, 30);
        
        const now = new Date();
        const timeStr = now.toLocaleDateString() + " " + now.toLocaleTimeString();
        mockCtx.fillStyle = '#fff';
        mockCtx.font = "14px Courier New, monospace";
        mockCtx.fillText(timeStr, 20, 455);
        
        // Draw crosshairs
        mockCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        mockCtx.lineWidth = 1;
        mockCtx.beginPath();
        mockCtx.moveTo(320, 20); mockCtx.lineTo(320, 150);
        mockCtx.moveTo(320, 330); mockCtx.lineTo(320, 460);
        mockCtx.moveTo(20, 240); mockCtx.lineTo(200, 240);
        mockCtx.moveTo(440, 240); mockCtx.lineTo(620, 240);
        mockCtx.stroke();

        // Increment frame count for FPS monitor in mock mode
        frameCount++;

        // Perform browser-side motion detection check in mock mode
        if (motionDetectionActive) {
            processMotionDetection(mockCanvas);
        }

        mockAnimationId = requestAnimationFrame(drawFrame);
    }
    
    mockAnimationId = requestAnimationFrame(drawFrame);
}

function stopMockCamera() {
    if (mockAnimationId) {
        cancelAnimationFrame(mockAnimationId);
        mockAnimationId = null;
    }
    mockCanvas.style.display = 'none';
}

// ==========================================
// MOTION DETECTION ALGORITHM (Browser Canvas)
// ==========================================
function toggleMotionDetection() {
    motionDetectionActive = settingMotion.checked;
    
    // In local mode, sync with ESP32-CAM via API
    if (isConnected && streamMode === 'local') {
        const val = motionDetectionActive ? '1' : '0';
        fetch(`http://${ipInput.value}/control?var=motion&val=${val}`);
    } 
    // In cloud mode, sync via WS
    else if (isConnected && streamMode === 'cloud' && wsClient) {
        wsClient.send(`control:motion:${motionDetectionActive ? '1' : '0'}`);
    }
}

// Loop to process local motion detection from direct stream <img>
function startLocalMotionDetectionLoop() {
    if (streamInterval) clearInterval(streamInterval);
    
    streamInterval = setInterval(() => {
        if (isConnected && streamMode === 'local' && motionDetectionActive) {
            processMotionDetection(cameraStream);
        }
    }, 300); // Check 3 times a second to reduce CPU usage
}

function processMotionDetection(sourceElement) {
    const width = 80;
    const height = 60;
    motionCanvas.width = width;
    motionCanvas.height = height;
    
    // 1. Draw downsampled source to hidden canvas
    try {
        motionCtx.drawImage(sourceElement, 0, 0, width, height);
    } catch(e) {
        return; // Stream not loaded yet
    }
    
    // 2. Extract image data
    const currentFrameData = motionCtx.getImageData(0, 0, width, height).data;
    
    if (prevFrameData) {
        let changedPixels = 0;
        
        // 3. Set threshold from UI sensitivity (lower sensitivity = higher difference threshold)
        const sensitivity = parseInt(settingSensitivity.value);
        const diffThreshold = 100 - sensitivity; // Range: 10 - 90
        
        // 4. Compare pixels
        for (let i = 0; i < currentFrameData.length; i += 4) {
            const rDiff = Math.abs(currentFrameData[i] - prevFrameData[i]);
            const gDiff = Math.abs(currentFrameData[i+1] - prevFrameData[i+1]);
            const bDiff = Math.abs(currentFrameData[i+2] - prevFrameData[i+2]);
            
            // Average pixel difference
            const avgDiff = (rDiff + gDiff + bDiff) / 3;
            
            if (avgDiff > diffThreshold) {
                changedPixels++;
            }
        }
        
        // 5. Calculate percentage of change
        const percentChange = (changedPixels / (width * height)) * 100;
        
        // 6. Trigger alarm if exceeds limit
        const triggerThresholdPercent = 2.5; // Trigger alarm if more than 2.5% of pixels changed
        if (percentChange > triggerThresholdPercent && !motionCooldown) {
            triggerMotionAlarm();
        }
    }
    
    prevFrameData = currentFrameData;
}

function triggerMotionAlarm() {
    motionCooldown = true;
    
    // Visual alert overlay
    motionOverlay.classList.add('active');
    
    // Sound alert
    alarmSound.volume = 0.5;
    alarmSound.play().catch(e => console.log("Không phát được âm thanh:", e));
    
    // Log alert console
    console.log("🚨 PHÁT HIỆN CHUYỂN ĐỘNG! Tự động lưu hình ảnh...");
    
    // Auto snapshot save
    setTimeout(() => {
        captureFrameAndSave("CẢNH BÁO");
    }, 100);
    
    // Remove alarm alert after 2 seconds
    setTimeout(() => {
        motionOverlay.classList.remove('active');
    }, 2000);
    
    // Cooldown 6 seconds to prevent flooding
    setTimeout(() => {
        motionCooldown = false;
    }, 6000);
}

// ==========================================
// CAMERA SNAPSHOT & GALLERY (IndexedDB)
// ==========================================
function takeSnapshot() {
    // Flash button effect
    const btn = document.getElementById('btn-capture');
    btn.style.transform = 'scale(0.95)';
    setTimeout(() => btn.style.transform = 'scale(1)', 100);
    
    if (isConnected && streamMode === 'local') {
        // Fetch fresh high resolution capture from real device
        const ip = ipInput.value.trim();
        fetch(`http://${ip}/capture`)
            .then(res => res.blob())
            .then(blob => {
                saveToGallery(blob, "THỦ CÔNG");
            })
            .catch(err => {
                console.error("Không fetch được ảnh capture, chụp ảnh canvas hiện tại.", err);
                captureFrameAndSave("THỦ CÔNG");
            });
    } else {
        // Capture from Web/Cloud WS stream or Mock Canvas directly
        captureFrameAndSave("THỦ CÔNG");
    }
}

// Capture from current canvas element / stream element
function captureFrameAndSave(type) {
    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = 640;
    snapCanvas.height = 480;
    const snapCtx = snapCanvas.getContext('2d');
    
    if (mockCanvas.style.display === 'block') {
        snapCtx.drawImage(mockCanvas, 0, 0, 640, 480);
    } else if (cameraStream.style.display === 'block') {
        snapCtx.drawImage(cameraStream, 0, 0, 640, 480);
    } else {
        return; // Nothing to capture
    }
    
    snapCanvas.toBlob((blob) => {
        saveToGallery(blob, type);
    }, 'image/jpeg', 0.85);
}

// Save snapshot blob to IndexedDB
function saveToGallery(blob, type) {
    if (!db) {
        console.error("Database not ready");
        return;
    }
    
    const timestamp = new Date().toLocaleTimeString() + " " + new Date().toLocaleDateString();
    
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    
    const item = {
        image: blob,
        timestamp: timestamp,
        type: type
    };
    
    const request = store.add(item);
    request.onsuccess = () => {
        console.log("Đã lưu ảnh chụp thành công vào IndexedDB");
        loadFromGallery(); // Refresh gallery list
    };
    request.onerror = (e) => {
        console.error("Lưu ảnh thất bại:", e);
    };
}

// Load snapshots from IndexedDB and render UI
function loadFromGallery() {
    if (!db) return;
    
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    
    request.onsuccess = (event) => {
        const items = event.target.result;
        
        // Reverse array to show newest first
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
        
        galleryGrid.innerHTML = ""; // Clear grid
        
        items.forEach(item => {
            const url = URL.createObjectURL(item.image);
            
            const galleryItem = document.createElement('div');
            galleryItem.className = 'gallery-item';
            
            const isMotion = item.type === "CẢNH BÁO";
            
            galleryItem.innerHTML = `
                <img src="${url}" onclick="openLightbox('${url}', '${item.type} - ${item.timestamp}')" alt="Snapshot">
                <div class="item-overlay">
                    <div class="item-meta">
                        <span class="item-time">${item.timestamp.split(' ')[0]}</span>
                        <span class="item-type ${isMotion ? 'motion' : ''}">${item.type}</span>
                    </div>
                    <div class="item-actions">
                        <a href="${url}" download="esp32cam_${item.timestamp.replace(/[:\s]/g, '_')}.jpg" class="action-icon" title="Tải xuống">
                            <i class="fa-solid fa-download"></i>
                        </a>
                        <button class="action-icon delete-btn" onclick="deleteFromGallery(${item.id})" title="Xóa">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>
                </div>
            `;
            
            galleryGrid.appendChild(galleryItem);
        });
    };
}

// Delete item
function deleteFromGallery(id) {
    if (!db) return;
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    
    request.onsuccess = () => {
        loadFromGallery();
    };
}

// Clear all
function clearGallery() {
    if (!db) return;
    if (!confirm("Bạn có chắc chắn muốn xóa toàn bộ ảnh trong thư viện?")) return;
    
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();
    
    request.onsuccess = () => {
        loadFromGallery();
    };
}

// ==========================================
// CONTROLS & CAMERA CONFIG API SYNC
// ==========================================
function toggleFlash() {
    flashState = !flashState;
    settingFlash(flashState);
    
    if (isConnected) {
        const val = flashState ? '1' : '0';
        if (streamMode === 'local') {
            fetch(`http://${ipInput.value}/control?var=flash&val=${val}`);
        } else if (wsClient) {
            if (isStreamingActive) {
                // Tạm dừng stream để tránh nghẽn socket của ESP32-CAM khi đang gửi ảnh nhị phân liên tục
                wsClient.send('stop_stream');
                
                setTimeout(() => {
                    // Gửi cả 2 định dạng lệnh để đảm bảo tương thích
                    wsClient.send(`control:flash:${val}`);
                    wsClient.send(flashState ? 'flash_on' : 'flash_off');
                    
                    setTimeout(() => {
                        // Tiếp tục stream lại
                        wsClient.send('start_stream');
                    }, 1000);
                }, 1000);
            } else {
                // Nếu luồng đang dừng sẵn, gửi lệnh trực tiếp mà không cần chờ đợi trì hoãn
                wsClient.send(`control:flash:${val}`);
                wsClient.send(flashState ? 'flash_on' : 'flash_off');
            }
        }
    }
}

function settingFlash(state) {
    flashState = state;
    const btn = document.getElementById('btn-flash');
    if (flashState) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-lightbulb"></i> Flash: BẬT';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-lightbulb"></i> Flash: TẮT';
    }
}

function changeResolution(val) {
    if (isConnected) {
        if (streamMode === 'local') {
            fetch(`http://${ipInput.value}/control?var=framesize&val=${val}`);
        } else if (wsClient) {
            if (isStreamingActive) {
                wsClient.send('stop_stream');
                setTimeout(() => {
                    wsClient.send(`control:framesize:${val}`);
                    setTimeout(() => {
                        wsClient.send('start_stream');
                    }, 1000);
                }, 1000);
            } else {
                wsClient.send(`control:framesize:${val}`);
            }
        }
    }
    
    // Update badge text
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

function updateCamSetting(variable, val) {
    // Show value label beside range input immediately
    if (variable === 'brightness') document.getElementById('val-brightness').textContent = val;
    if (variable === 'contrast') document.getElementById('val-contrast').textContent = val;
    if (variable === 'saturation') document.getElementById('val-saturation').textContent = val;

    if (isConnected) {
        if (streamMode === 'local') {
            fetch(`http://${ipInput.value}/control?var=${variable}&val=${val}`);
        } else if (wsClient) {
            if (isStreamingActive) {
                wsClient.send('stop_stream');
                setTimeout(() => {
                    wsClient.send(`control:${variable}:${val}`);
                    setTimeout(() => {
                        wsClient.send('start_stream');
                    }, 1000);
                }, 1000);
            } else {
                wsClient.send(`control:${variable}:${val}`);
            }
        }
    }
}

function updateRangeLabel(type, val) {
    if (type === 'sensitivity') {
        document.getElementById('val-sensitivity').textContent = val + "%";
    }
}

// ==========================================
// FULLSCREEN & LIGHTBOX OVERLAYS
// ==========================================
function toggleFullscreen() {
    const container = document.getElementById('video-container');
    if (!document.fullscreenElement) {
        container.requestFullscreen().catch(err => {
            console.error("Không thể mở toàn màn hình:", err);
        });
    } else {
        document.exitFullscreen();
    }
}

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

function toggleStreamState() {
    if (!isConnected) return;
    
    isStreamingActive = !isStreamingActive;
    const btn = document.getElementById('btn-stream-toggle');
    
    if (isStreamingActive) {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i> Dừng Phát';
        btn.classList.remove('paused');
        if (streamMode === 'cloud' && wsClient) {
            wsClient.send('start_stream');
        } else if (streamMode === 'local') {
            cameraStream.src = `http://${ipInput.value}/stream`;
        }
    } else {
        btn.innerHTML = '<i class="fa-solid fa-play"></i> Phát Luồng';
        btn.classList.add('paused');
        if (streamMode === 'cloud' && wsClient) {
            wsClient.send('stop_stream');
        } else if (streamMode === 'local') {
            cameraStream.src = '';
        }
    }
}
