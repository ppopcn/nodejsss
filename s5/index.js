/**
 * Node.js SOCKS5 Proxy Server (RFC 1928)
 * 端口: 20032
 * 用户名: admin
 * 密码: qwe123
 */

const net = require('net');

// --- 配置参数硬编码 ---
const PORT = 20032;
const USERNAME = 'admin';
const PASSWORD = 'qwe123';

const server = net.createServer((clientSocket) => {
    // 状态管理：0: 初始, 1: 认证, 2: 请求
    let stage = 0;

    clientSocket.on('data', (data) => {
        if (stage === 0) {
            // 1. 处理版本协商
            // data: [VERSION, NMETHODS, METHODS...]
            if (data[0] !== 0x05) return clientSocket.destroy();

            // 检查是否支持用户名/密码认证 (0x02)
            const methods = data.slice(2);
            if (methods.includes(0x02)) {
                clientSocket.write(Buffer.from([0x05, 0x02])); // 选择用户名密码认证
                stage = 1;
            } else {
                // 如果客户端不支持加密认证，则拒绝
                clientSocket.write(Buffer.from([0x05, 0xFF]));
                return clientSocket.destroy();
            }
        } 
        else if (stage === 1) {
            // 2. 处理用户名密码校验 (Sub-negotiation)
            // data: [VER, ULEN, USERNAME, PLEN, PASSWORD]
            const ulen = data[1];
            const user = data.slice(2, 2 + ulen).toString();
            const plen = data[2 + ulen];
            const pass = data.slice(3 + ulen, 3 + ulen + plen).toString();

            if (user === USERNAME && pass === PASSWORD) {
                clientSocket.write(Buffer.from([0x01, 0x00])); // 认证成功
                stage = 2;
            } else {
                clientSocket.write(Buffer.from([0x01, 0x01])); // 认证失败
                return clientSocket.destroy();
            }
        } 
        else if (stage === 2) {
            // 3. 处理连接请求
            // data: [VER, CMD, RSV, ATYP, ADDR, PORT]
            const cmd = data[1];
            if (cmd !== 0x01) { // 仅支持 CONNECT (0x01)
                clientSocket.write(Buffer.from([0x05, 0x07])); // 不支持的命令
                return clientSocket.destroy();
            }

            let host = '';
            let offset = 4;
            const atyp = data[3];

            if (atyp === 0x01) { // IPv4
                host = data.slice(4, 8).join('.');
                offset = 8;
            } else if (atyp === 0x03) { // 域名
                const addrLen = data[4];
                host = data.slice(5, 5 + addrLen).toString();
                offset = 5 + addrLen;
            } else if (atyp === 0x04) { // IPv6
                host = data.slice(4, 20).toString('hex').match(/.{1,4}/g).join(':');
                offset = 20;
            } else {
                return clientSocket.destroy();
            }

            const port = data.readUInt16BE(offset);

            // 4. 建立与目标的连接
            const remoteSocket = net.connect(port, host, () => {
                // 连接成功，响应客户端
                const resp = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
                clientSocket.write(resp);

                // 双向数据转发
                clientSocket.pipe(remoteSocket);
                remoteSocket.pipe(clientSocket);
            });

            remoteSocket.on('error', (err) => {
                console.error(`Remote connection error (${host}:${port}):`, err.message);
                clientSocket.destroy();
            });

            // 移除 data 监听，交给 pipe 处理后续流量
            clientSocket.removeAllListeners('data');
        }
    });

    clientSocket.on('error', (err) => {
        // 忽略常见的连接重置错误
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`SOCKS5 服务端已启动`);
    console.log(`监听端口: ${PORT}`);
    console.log(`认证信息: ${USERNAME} / ${PASSWORD}`);
});