const net = require('net');
const crypto = require('crypto');
const https = require('https');
const { AEADEncryptor, AEADDecryptor } = require('./crypto_utils');

// 读取端口配置
function readPort() {
  if (process.env.SERVER_PORT && !isNaN(process.env.SERVER_PORT)) {
    console.log(`Using env port: ${process.env.SERVER_PORT}`);
    return Number(process.env.SERVER_PORT);
  }
  const port = 8000;
  return port;
}

// ================== 显示 Shadowsocks 连接信息 ==================
function displayShadowsocksInfo(password, ip, port, method) {
  // Shadowsocks URI 格式: ss://method:password@server:port#name
  // 使用 URL 安全的 Base64 编码 (RFC 4648)
  const auth = Buffer.from(`${method}:${password}`)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
    
  const link = `ss://${auth}@${ip}:${port}#nodejs-SS-${ip}`;
  
  console.log('\n' + '━'.repeat(50));
  console.log('🚀 Shadowsocks 服务器已就绪!');
  console.log('🔗 复制下面的链接到客户端:');
  console.log('\x1b[36m%s\x1b[0m', link); // 使用青色输出链接
  console.log('━'.repeat(50));
  
  console.log('\n📱 详细配置:');
  console.log(`   服务器: ${ip}`);
  console.log(`   端口: ${port}`);
  console.log(`   密码: ${password}`);
  console.log(`   加密: ${method}`);
  console.log('━'.repeat(50) + '\n');
}

class ShadowsocksServer {
  constructor(config) {
    this.port = config.port;
    this.password = config.password;
    this.method = 'aes-256-gcm'; // 升级到 AES-256-GCM (AEAD)
    this.timeout = config.timeout * 1000;
  }

  // 解析目标地址
  parseAddress(data) {
    if (data.length < 7) return null;
    
    let offset = 0;
    const addressType = data[offset++];
    
    let address, port;
    
    try {
      if (addressType === 1) { // IPv4
        if (data.length < offset + 6) return null;
        address = Array.from(data.slice(offset, offset + 4)).join('.');
        offset += 4;
      } else if (addressType === 3) { // 域名
        if (data.length < offset + 1) return null;
        const domainLength = data[offset++];
        if (data.length < offset + domainLength + 2) return null;
        address = data.slice(offset, offset + domainLength).toString();
        offset += domainLength;
      } else if (addressType === 4) { // IPv6
        if (data.length < offset + 18) return null;
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          ipv6.push(data.readUInt16BE(offset + i * 2).toString(16));
        }
        address = ipv6.join(':');
        offset += 16;
      } else {
        return null;
      }
      
      if (data.length < offset + 2) return null;
      port = data.readUInt16BE(offset);
      offset += 2;
      
      return { address, port, headerLength: offset };
    } catch (err) {
      return null;
    }
  }

  // 处理客户端连接
  handleConnection(clientSocket) {
    console.log(`新连接: ${clientSocket.remoteAddress}:${clientSocket.remotePort}`);
    
    const decryptor = new AEADDecryptor(this.password, this.method);
    const encryptor = new AEADEncryptor(this.password, this.method);
    let targetSocket = null;
    let stage = 0; // 0: 握手, 1: 转发
    
    clientSocket.on('data', (data) => {
      try {
        const decrypted = decryptor.decrypt(data);
        if (decrypted.length === 0) return;

        if (stage === 0) {
          const result = this.parseAddress(decrypted);
          if (!result) {
            console.log(`地址解析失败`);
            clientSocket.destroy();
            return;
          }

          const { address, port, headerLength } = result;
          console.log(`代理请求: ${clientSocket.remoteAddress}:${clientSocket.remotePort} -> ${address}:${port}`);

          targetSocket = net.createConnection(port, address);

          targetSocket.on('connect', () => {
            console.log(`连接建立: ${address}:${port}`);
            stage = 1;
            
            // 转发握手包中剩余的 payload
            if (decrypted.length > headerLength) {
              const payload = decrypted.slice(headerLength);
              targetSocket.write(payload);
            }
          });

          targetSocket.on('data', (targetData) => {
            const encrypted = encryptor.encryptChunk(targetData);
            clientSocket.write(encrypted);
          });

          targetSocket.on('error', (err) => {
            console.log(`目标连接错误: ${address}:${port} - ${err.message}`);
            clientSocket.destroy();
          });

          targetSocket.on('close', () => {
            console.log(`目标连接关闭: ${address}:${port}`);
            clientSocket.destroy();
          });

        } else if (stage === 1 && targetSocket) {
          targetSocket.write(decrypted);
        }
      } catch (err) {
        console.log(`处理错误: ${clientSocket.remoteAddress}:${clientSocket.remotePort} - ${err.message}`);
        clientSocket.destroy();
      }
    });

    clientSocket.on('error', (err) => {
      console.log(`客户端错误: ${clientSocket.remoteAddress}:${clientSocket.remotePort} - ${err.message}`);
    });

    clientSocket.on('close', () => {
      console.log(`连接关闭: ${clientSocket.remoteAddress}:${clientSocket.remotePort}`);
      if (targetSocket) targetSocket.destroy();
    });

    clientSocket.setTimeout(this.timeout, () => {
      console.log(`连接超时: ${clientSocket.remoteAddress}:${clientSocket.remotePort}`);
      clientSocket.destroy();
    });
  }

  // 获取服务器公网IP
  async getServerPublicIP() {
    const services = [
      'https://icanhazip.com',
      'https://api.ipify.org',
      'https://ipecho.net/plain'
    ];

    for (const service of services) {
      try {
        const ip = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('请求超时')), 5000);
          
          https.get(service, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              clearTimeout(timeout);
              resolve(data.trim());
            });
          }).on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
        
        // 验证IP格式
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          return ip;
        }
      } catch (err) {
        console.log(`IP服务 ${service} 失败: ${err.message}`);
        continue;
      }
    }
    
    return null;
  }

  // 启动服务器
  async start() {
    const server = net.createServer((socket) => {
      this.handleConnection(socket);
    });
    
    server.listen(this.port, '0.0.0.0', async () => {
      console.log(`✅ Shadowsocks 服务器启动成功`);
      console.log(`📡 监听端口: ${this.port}`);
      console.log(`🔐 加密方法: ${this.method}`);
      
      // 获取并显示公网IP
      console.log(`🌐 正在探测公网IP...`);
      const publicIP = await this.getServerPublicIP();
      
      if (publicIP) {
        displayShadowsocksInfo(this.password, publicIP, this.port, this.method);
      } else {
        console.log(`⚠️  公网IP获取失败，请检查网络连接。`);
        // 提供一个本地/占位符链接供参考
        displayShadowsocksInfo(this.password, 'YOUR_SERVER_IP', this.port, this.method);
      }
    });
    
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ 端口 ${this.port} 已被占用`);
      } else {
        console.error('❌ 服务器错误:', err.message);
      }
    });
    
    return server;
  }
}

// 主函数
async function main() {
  try {
    // 硬编码配置
    const config = {
      port: readPort(),
      password: "qwe123",
      timeout: 300
    };
    
    console.log('=== Shadowsocks 服务器 ===');
    console.log(`端口: ${config.port}`);
    console.log(`密码: ${config.password}`);
    console.log(`超时: ${config.timeout}秒`);
    console.log('========================');
    
    const server = new ShadowsocksServer(config);
    await server.start();
    
    // 优雅关闭
    process.on('SIGINT', () => {
      console.log('\n正在关闭服务器...');
      process.exit(0);
    });
    
  } catch (err) {
    console.error('启动失败:', err.message);
    process.exit(1);
  }
}

// 如果直接运行此文件，启动服务器
if (require.main === module) {
  main();
}

module.exports = { ShadowsocksServer, main };
