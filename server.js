const http = require('http');
const url = require('url');
const { WebSocketServer } = require('ws');

// Cấu hình cổng chạy Server (Thích ứng với Render/Glitch/Heroku)
const PORT = process.env.PORT || 8080;

// Khởi tạo HTTP Server cơ bản để phục vụ kiểm tra sức khỏe (Health Check)
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url);
    if (parsedUrl.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <html>
                <head><title>Aether-Eye Cloud Relay</title></head>
                <style>
                    body { font-family: sans-serif; background: #080b11; color: #f3f4f6; text-align: center; padding-top: 100px; }
                    h1 { color: #00f2fe; }
                    .status { display: inline-block; background: rgba(57, 255, 20, 0.15); color: #39ff14; padding: 5px 15px; border-radius: 20px; font-weight: bold; }
                </style>
                <body>
                    <h1>Aether-Eye ESP32-CAM Cloud Relay Server</h1>
                    <p class="status">● Đang hoạt động</p>
                    <p>Địa chỉ luồng Client: <code>wss://YOUR_DOMAIN/client</code></p>
                    <p>Địa chỉ luồng Camera: <code>wss://YOUR_DOMAIN/esp32cam</code></p>
                </body>
            </html>
        `);
    } else {
        res.writeHead(404);
        res.end();
    }
});

// Tạo 2 server WebSocket riêng cho Camera và Browser Client
const wssCamera = new WebSocketServer({ noServer: true });
const wssClients = new WebSocketServer({ noServer: true });

let cameraSocket = null;
const clientSockets = new Set();

// ==========================================================================
// LOGIC CAMERA WEBSOCKET
// ==========================================================================
wssCamera.on('connection', (ws) => {
    console.log('[Camera] Kết nối mới từ ESP32-CAM!');
    cameraSocket = ws;
    
    // Thông báo cho các client là camera đã trực tuyến
    broadcastToClients(JSON.stringify({ type: 'status', camera: 'online', flash: false }));

    ws.on('message', (message, isBinary) => {
        // Nếu là dữ liệu Binary (Khung ảnh JPEG), chuyển tiếp cho toàn bộ các Client
        if (isBinary) {
            broadcastToClients(message, true);
        } else {
            // Nhận lệnh text từ camera (ví dụ báo cáo trạng thái)
            const textMsg = message.toString();
            console.log('[Camera -> Server]:', textMsg);
            broadcastToClients(textMsg);
        }
    });

    ws.on('close', () => {
        console.log('[Camera] ESP32-CAM đã ngắt kết nối.');
        cameraSocket = null;
        broadcastToClients(JSON.stringify({ type: 'status', camera: 'offline' }));
    });

    ws.on('error', (error) => {
        console.error('[Camera] Lỗi socket:', error);
        cameraSocket = null;
    });
});

// ==========================================
// LOGIC BROWSER CLIENT WEBSOCKET
// ==========================================
wssClients.on('connection', (ws) => {
    console.log(`[Client] Người xem mới kết nối. Tổng số người xem: ${clientSockets.size + 1}`);
    clientSockets.add(ws);

    // Gửi trạng thái camera hiện tại cho client mới kết nối
    ws.send(JSON.stringify({
        type: 'status',
        camera: cameraSocket ? 'online' : 'offline'
    }));

    // Nếu camera đã kết nối, ra lệnh bắt đầu stream ngay
    if (cameraSocket) {
        cameraSocket.send('start_stream');
    }

    ws.on('message', (message) => {
        const command = message.toString();
        console.log('[Client -> Camera]:', command);

        // Chuyển tiếp lệnh từ Client trực tiếp tới ESP32-CAM
        if (cameraSocket && cameraSocket.readyState === cameraSocket.OPEN) {
            cameraSocket.send(command);
        }
    });

    ws.on('close', () => {
        clientSockets.delete(ws);
        console.log(`[Client] Người xem thoát. Tổng số người xem: ${clientSockets.size}`);

        // Tiết kiệm băng thông: Nếu không còn ai xem nữa, ra lệnh cho ESP32-CAM dừng stream
        if (clientSockets.size === 0 && cameraSocket && cameraSocket.readyState === cameraSocket.OPEN) {
            console.log('[Server] Không còn ai xem. Ra lệnh ESP32-CAM tạm dừng camera để mát chip.');
            cameraSocket.send('stop_stream');
        }
    });

    ws.on('error', (err) => {
        clientSockets.delete(ws);
        console.error('[Client] Lỗi socket:', err);
    });
});

// Chuyển tiếp dữ liệu đến toàn bộ Client trình duyệt
function broadcastToClients(data, isBinary = false) {
    clientSockets.forEach((client) => {
        if (client.readyState === client.OPEN) {
            client.send(data, { binary: isBinary });
        }
    });
}

// ==========================================
// PHÂN LOẠI UPGRADE KẾT NỐI (ROUTING)
// ==========================================
server.on('upgrade', (request, socket, head) => {
    const pathname = url.parse(request.url).pathname;

    if (pathname === '/esp32cam') {
        wssCamera.handleUpgrade(request, socket, head, (ws) => {
            wssCamera.emit('connection', ws, request);
        });
    } else if (pathname === '/client') {
        wssClients.handleUpgrade(request, socket, head, (ws) => {
            wssClients.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

// Khởi động HTTP server lắng nghe kết nối
server.listen(PORT, () => {
    console.log(`Server Cloud Relay đang chạy tại cổng http://localhost:${PORT}`);
});
