#!/usr/bin/env node
/**
 * =========================================
 * Shadowsocks2 自动部署脚本（Node.js 版）
 * 定时重启：每天北京时间 00:00（24:00）
 * 
 * 【密码固定为 qwe123】
 * 
 * 支持特性：
 * - 自动端口分配
 * - AES-256-GCM 加密
 * - TCP + UDP 支持
 * - 定时自动重启
 * - 轻量级实现（1MB 二进制文件）
 * =========================================
 */
import { execSync, spawn } from "child_process";
import fs from "fs";
import https from "https";

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
const SS_BIN = "./shadowsocks2-linux";
let SS_DOWNLOAD_URL = ""; // shadowsocks2 下载链接

// ================== 设置 Shadowsocks2 下载链接 ==================
function setShadowsocks2DownloadUrl(url) {
  SS_DOWNLOAD_URL = url;
  console.log(`Shadowsocks2 下载链接已设置: ${url}`);
}

// ================== 工具函数 ==================
const randomPort = () => Math.floor(Math.random() * 40000) + 20000;
function fileExists(p) { return fs.existsSync(p); }
function execSafe(cmd) {
  try { return execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim(); }
  catch { return ""; }
}

// ================== 准确获取公网 IP ==================
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
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const newUrl = res.headers.location;
        console.log(`Redirecting to: ${newUrl}`);
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return resolve(downloadFile(newUrl, dest, redirectCount + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`下载失败: ${res.statusCode}`));
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });
}

// ================== 读取端口（仅随机或环境变量）=================
function readPort() {
  if (process.env.SERVER_PORT && !isNaN(process.env.SERVER_PORT)) {
    console.log(`Using env port: ${process.env.SERVER_PORT}`);
    return Number(process.env.SERVER_PORT);
  }
  const port = randomPort();
  console.log(`Random port: ${port}`);
  return port;
}

// ================== 生成固定密码 ==================
function getPassword() {
  // 使用固定密码 qwe123
  return "qwe123";
}

// ================== 下载 shadowsocks2 二进制文件 ==================
async function checkShadowsocks2Binary() {
  if (fileExists(SS_BIN)) {
    console.log("Shadowsocks2 binary exists");
    
    // 检查文件权限和大小
    try {
      const stats = fs.statSync(SS_BIN);
      console.log(`[Debug] Shadowsocks2 文件大小: ${stats.size} bytes`);
      console.log(`[Debug] Shadowsocks2 文件权限: ${stats.mode.toString(8)}`);
      
      // 尝试获取版本信息
      const version = execSafe(`${SS_BIN} -version`);
      console.log(`[Debug] Shadowsocks2 版本: ${version || '无法获取版本信息'}`);
    } catch (e) {
      console.error(`[Error] 检查 Shadowsocks2 文件时出错: ${e.message}`);
    }
    
    return;
  }
  
  if (!SS_DOWNLOAD_URL) {
    console.error("Shadowsocks2 下载链接未设置，请提供下载 URL");
    process.exit(1);
  }
  
  console.log("Downloading Shadowsocks2 binary...");
  await downloadFile(SS_DOWNLOAD_URL, SS_BIN);
  fs.chmodSync(SS_BIN, 0o755);
  console.log("Shadowsocks2 binary downloaded and ready");
  
  // 验证下载的文件
  try {
    const stats = fs.statSync(SS_BIN);
    console.log(`[Debug] 下载的 Shadowsocks2 文件大小: ${stats.size} bytes`);
    
    const version = execSafe(`${SS_BIN} -version`);
    console.log(`[Debug] 下载的 Shadowsocks2 版本: ${version || '无法获取版本信息'}`);
  } catch (e) {
    console.error(`[Error] 验证下载的 Shadowsocks2 文件时出错: ${e.message}`);
  }
}

// ================== 显示 Shadowsocks 连接信息 ==================
function displayShadowsocksInfo(password, ip, port) {
  // Shadowsocks URI 格式: ss://method:password@server:port#name
  const method = "aes-256-gcm";
  const auth = Buffer.from(`${method}:${password}`).toString('base64');
  const link = `ss://${auth}@${ip}:${port}#GOST-SS-${ip}`;
  
  console.log("Shadowsocks Link:");
  console.log(link);
  console.log(`\nConnection Info:`);
  console.log(`Server: ${ip}`);
  console.log(`Port: ${port}`);
  console.log(`Method: ${method}`);
  console.log(`Password: ${password}`);
}

// ================== 守护运行（使用 shadowsocks2）==================
function runShadowsocks2Service(password, port) {
  console.log("Starting Shadowsocks2 service...");
  
  const loop = () => {
    console.log(`[${new Date().toISOString()}] 启动 Shadowsocks2 进程...`);
    
    // 构建命令行参数
    const args = [
      `-s`, `ss://aes-256-gcm:${password}@:${port}`,
      `-udp`,
      `-verbose`
    ];
    
    console.log(`[Debug] 执行命令: ${SS_BIN} ${args.join(' ')}`);
    
    // 检查文件是否存在
    if (!fileExists(SS_BIN)) {
      console.error(`[Error] Shadowsocks2 二进制文件不存在: ${SS_BIN}`);
      return;
    }
    
    // 启动进程，不显示日志输出
    const proc = spawn(SS_BIN, args, { 
      stdio: "ignore" // 忽略所有输出
    });
    
    // 监听进程退出
    proc.on("exit", (code, signal) => {
      console.log(`[${new Date().toISOString()}] Shadowsocks2 进程退出`);
      console.log(`[Debug] 退出码: ${code}, 信号: ${signal}`);
      
      if (code !== 0) {
        console.error("[Error] Shadowsocks2 异常退出，可能的原因:");
        console.error("  1. 端口被占用");
        console.error("  2. 密码格式错误");
        console.error("  3. 权限不足");
        console.error("  4. 参数格式不正确");
      }
      
      console.log(`[Debug] 5秒后重启...`);
      setTimeout(loop, 5000);
    });
    
    // 监听进程错误
    proc.on("error", (err) => {
      console.error(`[Error] Shadowsocks2 进程错误: ${err.message}`);
    });
    
    console.log(`[Debug] Shadowsocks2 进程已启动，PID: ${proc.pid}`);
  };
  
  loop();
}

// ================== 主流程 ==================
async function main() {
  console.log("Shadowsocks2 自动部署开始");

  // 0. 设置 Shadowsocks2 下载链接
  setShadowsocks2DownloadUrl("https://github.com/ppopcn/g/raw/refs/heads/main/shadowsocks2-linux");

  // 1. 启动定时重启
  scheduleBeijingTimeMidnight(() => {
    process.exit(0);
  });

  // 2. 部署逻辑
  const port = readPort();
  const password = getPassword();

  await checkShadowsocks2Binary();
  const ip = await getPublicIP();
  displayShadowsocksInfo(password, ip, port);
  runShadowsocks2Service(password, port);
}

main().catch((err) => console.error("Error:", err));
