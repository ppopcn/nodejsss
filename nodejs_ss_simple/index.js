const net = require('net');
const crypto = require('crypto');
const https = require('https');

// 读取端口配置
function readPort() {
  if (process.env.SERVER_PORT && !isNaN(process.env.SERVER_PORT)) {
    console.log(`Using env port: ${process.env.SERVER_PORT}`);
    return Number(process.env.SERVER_PORT);
  }
  const port = 8989;
  return port;
}

// ================== 显示 Shadowsocks 连接信息 ==================
function displayShadowsocksInfo(password, ip, port, method) {
  // Shadowsocks URI 格式: ss://method:password@server:port#name
  const auth = Buffer.from(`${method}:${password}`).toString('base64');
  const link = `ss://${auth}@${ip}:${port}#nodejs-SS-${ip}`;
  
  console.log('\n🔗 Shadowsocks 连接信息:');
  console.log(`📋 连接链接: ${link}`);
  console.log('\n📱 客户端配置:');
  console.log(`   服务器: ${ip}`);
  console.log(`   端口: ${port}`);
  console.log(`   密码: ${password}`);
  console.log(`   加密: ${method}`);
}

class ShadowsocksServer {
  constructor(config) {
    this.port = config.port;
    this.password = config.password;
    this.method = 'aes-256-cfb'; // 升级到AES 256 CFB加密
    this.timeout = config.timeout * 1000; // 转换为毫秒
  }

// 生成密钥
  generateKey(password, method) {
    let keyLen = 16;
    if (method.includes('256')) keyLen = 32;
    
    const key = Buffer.alloc(keyLen);
    let keyPos = 0;
    let hash = Buffer.alloc(0);
    
    while (keyPos < keyLen) {
      const md5 = crypto.createHash('md5');
      md5.update(hash);
      md5.update(password, 'utf8');
      hash = md5.digest();
      
      const copyLen = Math.min(hash.length, keyLen - keyPos);
      hash.copy(key, keyPos, 0, copyLen);
      keyPos += copyLen;
    }
    
    return key;
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
    
    const key = this.generateKey(this.password, this.method);
    let targetSocket = null;
    let decipher = null;
    let cipher = null;
    let stage = 0;
    
    clientSocket.on('data', (data) => {
      try {
        if (stage === 0) {
          console.log(`收到初始数据: ${clientSocket.remoteAddress}:${clientSocket.remotePort}, 长度: ${data.length}`);
          
          if (data.length < 16) {
            console.log(`数据包太短: ${data.length} < 16`);
            clientSocket.destroy();
            return;
          }
          
          const iv = data.slice(0, 16);
          const encryptedData = data.slice(16);
          
          console.log(`IV长度: ${iv.length}, 加密数据长度: ${encryptedData.length}`);
          
          // 只使用配置的加密方法
          try {
            decipher = crypto.createDecipheriv(this.method, key, iv);
            const decrypted = decipher.update(encryptedData);
            
            console.log(`解密成功, 解密数据长度: ${decrypted.length}`);
            
            // 验证解密结果
            if (decrypted.length === 0) {
              console.log(`解密结果为空`);
              clientSocket.destroy();
              return;
            }
            
            const addressType = decrypted[0];
            console.log(`地址类型: ${addressType}`);
            
            if (addressType !== 1 && addressType !== 3 && addressType !== 4) {
              console.log(`无效的地址类型: ${addressType}`);
              clientSocket.destroy();
              return;
            }
            
            // 解析地址
            const result = this.parseAddress(decrypted);
            if (!result) {
              console.log(`地址解析失败`);
              clientSocket.destroy();
              return;
            }
            
            const { address, port, headerLength } = result;
            
            console.log(`代理请求: ${clientSocket.remoteAddress}:${clientSocket.remotePort} -> ${address}:${port}`);
            
            // 连接目标服务器
            targetSocket = net.createConnection(port, address);
            
            targetSocket.on('connect', () => {
              console.log(`连接建立: ${address}:${port}`);
              
              // 创建返回数据的加密器
              const responseIv = crypto.randomBytes(16);
              cipher = crypto.createCipheriv(this.method, key, responseIv);
              
              // 发送响应IV
              clientSocket.write(responseIv);
              
              // 转发剩余数据
              if (decrypted.length > headerLength) {
                const payload = decrypted.slice(headerLength);
                targetSocket.write(payload);
              }
              
              stage = 1;
            });
            
            targetSocket.on('data', (targetData) => {
              if (cipher) {
                const encrypted = cipher.update(targetData);
                clientSocket.write(encrypted);
              }
            });
            
            targetSocket.on('error', (err) => {
              console.log(`目标连接错误: ${address}:${port} - ${err.message}`);
              clientSocket.destroy();
            });
            
            targetSocket.on('close', () => {
              console.log(`目标连接关闭: ${address}:${port}`);
              clientSocket.destroy();
            });
            
          } catch (err) {
            // 解密失败，关闭连接
            console.log(`解密失败: ${clientSocket.remoteAddress}:${clientSocket.remotePort} - ${err.message}`);
            clientSocket.destroy();
            return;
          }
          
        } else if (stage === 1 && decipher && targetSocket) {
          // 后续数据包
          const decrypted = decipher.update(data);
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
      console.log(`🌐 正在获取公网IP...`);
      const publicIP = await this.getServerPublicIP();
      if (publicIP) {
        console.log(`🌐 服务器公网IP: ${publicIP}`);
        displayShadowsocksInfo(this.password, publicIP, this.port, this.method);
      } else {
        console.log(`🌐 服务器公网IP: 获取失败`);
        console.log(`📋 连接配置:`);
        console.log(`   服务器: [请手动获取公网IP]`);
        console.log(`   端口: ${this.port}`);
        console.log(`   密码: ${this.password}`);
        console.log(`   加密: ${this.method}`);
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