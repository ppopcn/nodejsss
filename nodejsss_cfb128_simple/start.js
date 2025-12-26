const fs = require('fs');
const ShadowsocksServer = require('./server');

function main() {
  try {
    // 只从 config.json 读取配置
    const configData = fs.readFileSync('config.json', 'utf8');
    const config = JSON.parse(configData);
    
    console.log('=== Shadowsocks 服务器 ===');
    console.log(`端口: ${config.port}`);
    console.log(`加密: ${config.method}`);
    console.log(`超时: ${config.timeout}秒`);
    console.log('========================');
    
    const server = new ShadowsocksServer(config);
    server.start();
    
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

if (require.main === module) {
  main();
}

module.exports = { main };