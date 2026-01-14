#!/usr/bin/env node
/**
 * =========================================
 * MTProxy 自动部署脚本（Node.js 版）
 * 定时重启：每天北京时间 00:00
 * =========================================
 */
import { execSync, spawn } from "child_process";
import fs from "fs";
import https from "https";
import http from "http";
import crypto from "crypto";

// ================== 内置定时器（北京时间 00:00 重启）==================
function scheduleBeijingTimeMidnight(callback) {
  const now = new Date();
  const beijingNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  
  let target = new Date(beijingNow);
  target.setHours(0, 0, 0, 0);

  if (beijingNow.getTime() >= target.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  const delay = target.getTime() - beijingNow.getTime();
  console.log(`[Timer] 下次重启：${target.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} (北京时间 00:00)`);

  setTimeout(() => {
    console.log(`[Timer] 北京时间 00:00 重启触发于 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    callback();
    scheduleBeijingTimeMidnight(callback);
  }, delay);
}

// ================== 基本配置 ==================
const WORK_DIR = process.env.HOME || "/tmp";
const MTPROXY_BIN = `${WORK_DIR}/MTProxy/objs/bin/mtproto-proxy`;
const PROXY_SECRET = `${WORK_DIR}/proxy-secret`;
const PROXY_CONFIG = `${WORK_DIR}/proxy-multi.conf`;
const LINK_TXT = `${WORK_DIR}/mtproxy_link.txt`;

// ================== 工具函数 ==================
const randomPort = () => Math.floor(Math.random() * 40000) + 20000;
const randomHex = (len = 16) => crypto.randomBytes(len).toString("hex");
function fileExists(p) { return fs.existsSync(p); }
function execSafe(cmd) {
  try { return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim(); }
  catch { return ""; }
}

// ================== 获取公网 IP ==================
async function getPublicIP() {
  const sources = [
    "https://api.ipify.org",
    "https://ifconfig.me",
    "https://icanhazip.com",
    "https://ipinfo.io/ip"
  ];
  for (const url of sources) {
    try {
      const ip = await new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 3000 }, (res) => {
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => resolve(data.trim()));
        });
        req.on("error", reject);
        req.setTimeout(3000, () => req.destroy());
      });
      if (ip && !/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.|169\.254\.)/.test(ip)) {
        console.log(`公网 IP: ${ip}`);
        return ip;
      }
    } catch (e) {}
  }
  console.log("警告：无法获取公网 IP，使用 127.0.0.1");
  return "127.0.0.1";
}

// ================== 下载文件 ==================
async function downloadFile(url, dest, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("重定向次数过多"));
    
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    
    protocol.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const newUrl = res.headers.location;
        console.log(`重定向到: ${newUrl}`);
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return resolve(downloadFile(newUrl, dest, redirectCount + 1));
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`下载失败: ${res.statusCode}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => {
      file.close();
      reject(err);
    });
  });
}

// ================== 读取端口 ==================
function readPort() {
  if (process.env.PORT) {
    console.log(`使用环境变量端口: ${process.env.PORT}`);
    return Number(process.env.PORT);
  }
  if (process.env.SERVER_PORT && !isNaN(process.env.SERVER_PORT)) {
    console.log(`使用环境变量端口: ${process.env.SERVER_PORT}`);
    return Number(process.env.SERVER_PORT);
  }
  const port = randomPort();
  console.log(`使用随机端口: ${port}`);
  return port;
}

// ================== 检查并编译 MTProxy 二进制 ==================
async function checkMTProxyBinary() {
  if (fileExists(MTPROXY_BIN)) {
    console.log("MTProxy 二进制文件已存在");
    return;
  }
  
  console.log("MTProxy 二进制文件不存在，开始自动编译...");
  
  const mtproxyDir = `${WORK_DIR}/MTProxy`;
  
  try {
    // 检查是否已经克隆了仓库
    if (!fileExists(mtproxyDir)) {
      console.log("正在克隆 MTProxy 仓库...");
      execSync(`cd ${WORK_DIR} && git clone https://github.com/TelegramMessenger/MTProxy.git`, { stdio: "inherit" });
    }
    
    // 编译
    console.log("正在编译 MTProxy（可能需要几分钟）...");
    execSync(`cd ${mtproxyDir} && make`, { stdio: "inherit" });
    
    if (fileExists(MTPROXY_BIN)) {
      console.log("MTProxy 编译成功！");
    } else {
      throw new Error("编译完成但未找到二进制文件");
    }
  } catch (err) {
    console.error("MTProxy 编译失败:", err.message);
    console.log("\n请手动编译：");
    console.log("  apt-get install -y git build-essential libssl-dev zlib1g-dev");
    console.log("  cd /root && git clone https://github.com/TelegramMessenger/MTProxy.git");
    console.log("  cd MTProxy && make");
    process.exit(1);
  }
}

// ================== 下载 MTProxy 配置文件 ==================
async function downloadMTProxyConfigs() {
  // 下载 proxy-secret
  if (!fileExists(PROXY_SECRET)) {
    console.log("正在下载 proxy-secret...");
    await downloadFile("https://core.telegram.org/getProxySecret", PROXY_SECRET);
    console.log("proxy-secret 下载完成");
  } else {
    console.log("proxy-secret 已存在");
  }

  // 下载 proxy-multi.conf
  if (!fileExists(PROXY_CONFIG)) {
    console.log("正在下载 proxy-multi.conf...");
    await downloadFile("https://core.telegram.org/getProxyConfig", PROXY_CONFIG);
    console.log("proxy-multi.conf 下载完成");
  } else {
    console.log("proxy-multi.conf 已存在");
  }
}

// ================== 生成连接链接 ==================
function generateLink(secret, ip, port) {
  // MTProxy 链接格式: tg://proxy?server=IP&port=PORT&secret=SECRET
  const link = `tg://proxy?server=${ip}&port=${port}&secret=${secret}`;
  const httpLink = `https://t.me/proxy?server=${ip}&port=${port}&secret=${secret}`;
  
  const content = `MTProxy 连接信息：

Telegram 链接（直接点击）:
${httpLink}

TG 协议链接:
${link}

手动配置:
服务器: ${ip}
端口: ${port}
密钥: ${secret}
`;
  
  fs.writeFileSync(LINK_TXT, content);
  console.log("\n" + "=".repeat(60));
  console.log("MTProxy 连接链接:");
  console.log(httpLink);
  console.log("=".repeat(60) + "\n");
}

// ================== 守护运行 ==================
function runLoop(port, secret) {
  console.log("正在启动 MTProxy 服务...");
  
  const loop = () => {
    // MTProxy 命令格式: ./mtproto-proxy -u nobody -p 8888 -H 443 -S <secret> --aes-pwd proxy-secret proxy-multi.conf -M 1
    const args = [
      "-u", "nobody",
      "-p", String(port),
      "-H", String(port),
      "-S", secret,
      "--aes-pwd", PROXY_SECRET,
      PROXY_CONFIG,
      "-M", "1"
    ];
    
    console.log(`启动命令: ${MTPROXY_BIN} ${args.join(" ")}`);
    
    const proc = spawn(MTPROXY_BIN, args, { 
      stdio: "inherit",
      cwd: WORK_DIR
    });
    
    proc.on("exit", (code) => {
      console.log(`MTProxy 进程退出 (代码: ${code})，5秒后重启...`);
      setTimeout(loop, 5000);
    });
    
    proc.on("error", (err) => {
      console.error(`MTProxy 进程错误: ${err.message}`);
      setTimeout(loop, 5000);
    });
  };
  
  loop();
}

// ================== 主流程 ==================
async function main() {
  console.log("MTProxy 自动部署开始");

  // 1. 启动定时重启
  scheduleBeijingTimeMidnight(() => {
    console.log("定时重启触发，退出进程...");
    process.exit(0);
  });

  // 2. 部署逻辑
  const port = readPort();
  const secret = randomHex(16); // 生成32位十六进制密钥

  await checkMTProxyBinary();
  await downloadMTProxyConfigs();
  
  const ip = await getPublicIP();
  generateLink(secret, ip, port);
  
  runLoop(port, secret);
}

main().catch((err) => {
  console.error("错误:", err);
  process.exit(1);
});
