// =============================================================
// Aether-Eye Cloud Relay Server v3.0
// Viết lại hoàn toàn dựa trên phân tích firmware chính xác
// =============================================================

const http = require('http');
const url  = require('url');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// ─── HTTP server (health check cho Render) ───────────────────
const httpServer = http.createServer((req, res) => {
    if (url.parse(req.url).pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>Aether-Eye Relay</title>
<style>body{font-family:sans-serif;background:#080b11;color:#f3f4f6;text-align:center;padding:80px}
h1{color:#00f2fe}.ok{color:#39ff14;font-weight:bold}</style></head>
<body><h1>Aether-Eye ESP32-CAM Cloud Relay</h1>
<p class="ok">● Đang hoạt động — Server v3.0</p>
<p>Camera endpoint: <code>wss://DOMAIN/esp32cam</code></p>
<p>Browser endpoint: <code>wss://DOMAIN/client</code></p>
</body></html>`);
    } else {
        res.writeHead(404); res.end();
    }
});

// ─── WebSocket servers ────────────────────────────────────────
const wssCamera  = new WebSocketServer({ noServer: true });
const wssClients = new WebSocketServer({ noServer: true });

let cameraSocket   = null;   // socket ESP32-CAM hiện tại
let cameraReady    = false;  // true sau khi camera gửi register_camera
let cameraReadyAt  = 0;      // timestamp sẵn sàng nhận lệnh

const clientSockets = new Set();

// ─────────────────────────────────────────────────────────────
// CAMERA WEBSOCKET  (/esp32cam)
// ─────────────────────────────────────────────────────────────
wssCamera.on('connection', (ws) => {
    const connectedAt = Date.now();
    console.log(`[CAM] ESP32-CAM kết nối mới! Time=${new Date(connectedAt).toLocaleTimeString('vi-VN')}`);

    // KHÔNG terminate() socket cũ!
    // ESP32 reconnect rất nhanh → socket cũ và mới có thể dùng chung
    // TCP stack → terminate() giết luôn connection mới → Code=1006
    // Để socket cũ tự đóng qua sự kiện 'close' bình thường.
    if (cameraSocket && cameraSocket !== ws) {
        console.log('[CAM] Có socket camera cũ, để tự đóng. KHÔNG terminate().');
        // Chỉ xóa tham chiếu, không gọi terminate/close
        cameraSocket = null;
        cameraReady  = false;
    }

    ws._connectedAt = connectedAt;

    cameraSocket  = ws;
    cameraReady   = false;
    cameraReadyAt = 0;
    ws.isAlive    = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            // Frame ảnh JPEG → chuyển tiếp tới tất cả browser
            broadcastToClients(data, true);
            return;
        }

        const text = data.toString().trim();

        // ── Handshake: camera báo đã sẵn sàng ──────────────
        // Firmware gửi "register_camera" ngay khi WStype_CONNECTED
        if (text === 'register_camera') {
            cameraReady   = true;
            cameraReadyAt = Date.now();
            const delayMs = ws._connectedAt ? cameraReadyAt - ws._connectedAt : 0;
            console.log(`[CAM] register_camera nhận sau ${delayMs}ms kết nối. Camera ONLINE.`);
            broadcastToClients(JSON.stringify({ type: 'status', camera: 'online' }));
            return;
        }

        // ── Mọi text khác từ camera → chuyển tiếp tới browser ──
        console.log('[CAM → Browser]', text);
        broadcastToClients(text);
    });

    ws.on('close', (code, reason) => {
        const aliveMs = ws._connectedAt ? Date.now() - ws._connectedAt : -1;
        const streamedMs = ws._streamStartAt ? Date.now() - ws._streamStartAt : -1;
        console.log(`[CAM] NGẮT KẾT NỐI! Code=${code} | Sống được: ${aliveMs}ms | Streaming: ${ws._isStreaming ? `${streamedMs}ms` : 'chưa phát'} | Reason: ${reason || 'none'}`);
        if (cameraSocket === ws) {
            cameraSocket  = null;
            cameraReady   = false;
        }
        broadcastToClients(JSON.stringify({ type: 'status', camera: 'offline' }));
    });

    ws.on('error', (err) => {
        console.error('[CAM] Lỗi socket:', err.message);
        if (cameraSocket === ws) {
            cameraSocket  = null;
            cameraReady   = false;
        }
    });
});

// ─────────────────────────────────────────────────────────────
// BROWSER WEBSOCKET  (/client)
// ─────────────────────────────────────────────────────────────
wssClients.on('connection', (ws) => {
    clientSockets.add(ws);
    ws.isAlive = true;
    console.log(`[Browser] Người xem kết nối. Tổng: ${clientSockets.size}`);

    ws.on('pong', () => { ws.isAlive = true; });

    // Gửi trạng thái hiện tại của camera cho browser mới
    ws.send(JSON.stringify({
        type:   'status',
        camera: (cameraSocket && cameraReady) ? 'online' : 'offline'
    }));

    ws.on('message', (data) => {
        const command = data.toString().trim();
        console.log(`[Browser → Server] Lệnh: '${command}'`);

        // Kiểm tra camera có sẵn sàng chưa
        if (!cameraSocket || !cameraReady) {
            console.log('[Server] Camera chưa sẵn sàng, bỏ qua lệnh:', command);
            return;
        }

        if (cameraSocket.readyState !== 1 /* OPEN */) {
            console.log('[Server] Camera socket không OPEN, bỏ qua.');
            return;
        }

        // Ghi log thời điểm gửi start_stream để đo thời gian tới khi crash
        if (command === 'start_stream') {
            cameraSocket._isStreaming = true;
            cameraSocket._streamStartAt = Date.now();
            const readyMs = cameraSocket._connectedAt ? Date.now() - cameraSocket._connectedAt : 0;
            console.log(`[Server → CAM] start_stream gửi sau ${readyMs}ms kể từ khi kết nối.`);
        }

        cameraSocket.send(command, (err) => {
            if (err) {
                console.error(`[Server → CAM] Gửi '${command}' THẤT BẠI:`, err.message);
            } else {
                console.log(`[Server → CAM] Đã gửi '${command}' OK.`);
            }
        });
    });

    ws.on('close', () => {
        clientSockets.delete(ws);
        console.log(`[Browser] Người xem thoát. Tổng: ${clientSockets.size}`);

        // Khi không còn ai xem → dừng stream để tiết kiệm tài nguyên ESP32
        if (clientSockets.size === 0 && cameraSocket && cameraReady && cameraSocket.readyState === 1) {
            console.log('[Server] Không còn ai xem → gửi stop_stream cho camera.');
            cameraSocket.send('stop_stream');
        }
    });

    ws.on('error', (err) => {
        clientSockets.delete(ws);
        console.error('[Browser] Lỗi socket:', err.message);
    });
});

// ─── Broadcast tới tất cả browser ────────────────────────────
function broadcastToClients(data, isBinary = false) {
    clientSockets.forEach((ws) => {
        if (ws.readyState === 1) {
            ws.send(data, { binary: isBinary });
        }
    });
}

// ─── Routing WebSocket upgrade ────────────────────────────────
httpServer.on('upgrade', (req, socket, head) => {
    const pathname = url.parse(req.url).pathname;

    if (pathname === '/esp32cam') {
        wssCamera.handleUpgrade(req, socket, head, (ws) => {
            wssCamera.emit('connection', ws, req);
        });
    } else if (pathname === '/client') {
        wssClients.handleUpgrade(req, socket, head, (ws) => {
            wssClients.emit('connection', ws, req);
        });
    } else {
        socket.destroy();
    }
});

// ─── Heartbeat: CHỈ ping Browser, KHÔNG ping Camera ───────────
// ArduinoWebSocketsClient trên ESP32 có thể crash khi nhận WS ping
// từ server (cần cấp phát RAM cho pong frame → heap overflow)
// ESP32 tự quản lý reconnect qua setReconnectInterval(5000)
const heartbeat = setInterval(() => {
    // KHÔNG ping camera
    if (cameraSocket && cameraSocket.readyState !== 1) {
        console.log('[Heartbeat] Camera socket không OPEN, dọn dẹp.');
        cameraSocket = null;
        cameraReady  = false;
        broadcastToClients(JSON.stringify({ type: 'status', camera: 'offline' }));
    }

    // Chỉ ping Browser clients
    clientSockets.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log('[Heartbeat] Browser không phản hồi pong → ngắt kết nối.');
            ws.terminate();
            clientSockets.delete(ws);
        } else {
            ws.isAlive = false;
            ws.ping();
        }
    });
}, 25000);

httpServer.on('close', () => clearInterval(heartbeat));

// ─── Khởi động server ─────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log(`[Server] Aether-Eye Cloud Relay v3.0 đang chạy tại cổng ${PORT}`);
});
