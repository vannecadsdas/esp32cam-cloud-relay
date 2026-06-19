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
    console.log('[CAM] ESP32-CAM kết nối mới!');

    // Đóng socket camera cũ nếu còn tồn tại
    if (cameraSocket && cameraSocket !== ws) {
        console.log('[CAM] Đóng socket camera cũ.');
        cameraSocket.terminate();
    }

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
            console.log('[CAM] Đã nhận register_camera. Camera ONLINE và sẵn sàng.');
            broadcastToClients(JSON.stringify({ type: 'status', camera: 'online' }));
            return;
        }

        // ── Mọi text khác từ camera → chuyển tiếp tới browser ──
        console.log('[CAM → Browser]', text);
        broadcastToClients(text);
    });

    ws.on('close', (code, reason) => {
        console.log(`[CAM] ESP32-CAM ngắt kết nối. Code=${code}`);
        if (cameraSocket === ws) {
            cameraSocket  = null;
            cameraReady   = false;
            cameraReadyAt = 0;
        }
        broadcastToClients(JSON.stringify({ type: 'status', camera: 'offline' }));
    });

    ws.on('error', (err) => {
        console.error('[CAM] Lỗi socket:', err.message);
        if (cameraSocket === ws) {
            cameraSocket  = null;
            cameraReady   = false;
            cameraReadyAt = 0;
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

        // Gửi lệnh trực tiếp dưới dạng TEXT (không có \0)
        // Firmware dùng: String message = String((char*)payload);
        // → Tự dừng tại \0 nếu có, nhưng không cần thiết phải gắn thêm
        cameraSocket.send(command, (err) => {
            if (err) {
                console.error(`[Server → CAM] Gửi '${command}' THẤT BẠI:`, err.message);
            } else {
                console.log(`[Server → CAM] Đã gửi '${command}' thành công.`);
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

// ─── Heartbeat (Ping/Pong mỗi 30s) ───────────────────────────
const heartbeat = setInterval(() => {
    // Camera
    if (cameraSocket) {
        if (cameraSocket.isAlive === false) {
            console.log('[Heartbeat] Camera không phản hồi pong → ngắt kết nối.');
            cameraSocket.terminate();
            cameraSocket  = null;
            cameraReady   = false;
            cameraReadyAt = 0;
            broadcastToClients(JSON.stringify({ type: 'status', camera: 'offline' }));
        } else {
            cameraSocket.isAlive = false;
            cameraSocket.ping();
        }
    }

    // Browsers
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
}, 30000);

httpServer.on('close', () => clearInterval(heartbeat));

// ─── Khởi động server ─────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log(`[Server] Aether-Eye Cloud Relay v3.0 đang chạy tại cổng ${PORT}`);
});
