#!/usr/bin/env node
/**
 * =========================================
 * Trojan 自动部署脚本（Node.js 版）
 * 定时重启：每天北京时间 00:00（24:00）
 * 
 * 【密码自动随机生成】
 * 
 * 密码会在每次启动时自动生成 16 位随机字符串
 * 无需手动设置，确保每次部署的安全性
 * =========================================
 */
import { execSync, spawn } from "child_process";
import fs from "fs";
import https from "https";
import crypto from "crypto";

// ================== 密码将自动随机生成 ==================
// 密码会在每次启动时自动生成，无需手动设置
console.log("密码将自动随机生成...");

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
const CONFIG_JSON = "config.json";
const CERT_PEM = "trojan-cert.pem";
const KEY_PEM = "trojan-key.pem";
const LINK_TXT = "trojan_link.txt";
const TROJAN_BIN = "./trojan";

// ================== 工具函数 ==================
const randomPort = () => Math.floor(Math.random() * 40000) + 20000;
const randomHex = (len = 16) => crypto.randomBytes(len).toString("hex");
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

// ================== 生成证书 ==================
function generateCert(domain) {
  if (fileExists(CERT_PEM) && fileExists(KEY_PEM)) {
    console.log("Certificate exists");
    return;
  }
  console.log(`Generating cert for ${domain}...`);
  execSafe(
    `openssl req -x509 -newkey rsa:2048 ` +
    `-keyout ${KEY_PEM} -out ${CERT_PEM} -subj "/CN=${domain}" -days 365 -nodes`
  );
  fs.chmodSync(KEY_PEM, 0o600);
  fs.chmodSync(CERT_PEM, 0o644);
}

// ================== 下载 trojan ==================
async function checkTrojanServer() {
  if (fileExists(TROJAN_BIN)) {
    console.log("trojan exists");
    return;
  }
  console.log("Downloading trojan binary...");
  const url = "https://github.com/ppopcn/g/raw/refs/heads/main/trojan";
  
  // 直接下载二进制文件
  await downloadFile(url, TROJAN_BIN);
  
  // 设置执行权限
  fs.chmodSync(TROJAN_BIN, 0o755);
  console.log("trojan binary downloaded");
}

// ================== 生成配置 ==================
function generateConfig(password, port) {
  const config = {
    "run_type": "server",
    "local_addr": "0.0.0.0",
    "local_port": port,
    "remote_addr": "127.0.0.1",
    "remote_port": 80,
    "password": [password],
    "log_level": 1,
    "ssl": {
      "cert": CERT_PEM,
      "key": KEY_PEM,
      "key_password": "",
      "cipher": "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384",
      "cipher_tls13": "TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384",
      "prefer_server_cipher": true,
      "alpn": ["http/1.1"],
      "alpn_port_override": {
        "h2": 81
      },
      "reuse_session": true,
      "session_ticket": false,
      "session_timeout": 600,
      "plain_http_response": "",
      "curves": "",
      "dhparam": ""
    },
    "tcp": {
      "prefer_ipv4": false,
      "no_delay": true,
      "keep_alive": true,
      "reuse_port": false,
      "fast_open": false,
      "fast_open_qlen": 20
    },
    "mysql": {
      "enabled": false,
      "server_addr": "127.0.0.1",
      "server_port": 3306,
      "database": "trojan",
      "username": "trojan",
      "password": "",
      "cafile": ""
    }
  };
  
  fs.writeFileSync(CONFIG_JSON, JSON.stringify(config, null, 2));
  console.log("Config generated:", CONFIG_JSON);
}

// ================== 生成链接 ==================
function generateLink(password, ip, port) {
  const link = `trojan://${password}@${ip}:${port}?allowInsecure=1&sni=${ip}#Trojan-${ip}`;
  fs.writeFileSync(LINK_TXT, link);
  console.log("Trojan Link:");
  console.log(link);
  console.log(`使用随机生成的密码: ${password.substring(0, 4)}***`);
  
  // 输出证书内容供客户端使用
  if (fileExists(CERT_PEM)) {
    console.log("\n================== 证书内容 (复制到客户端) ==================");
    const certContent = fs.readFileSync(CERT_PEM, 'utf8');
    console.log(certContent);
    console.log("================== 证书内容结束 ==================\n");
  }
}

// ================== 守护运行 ==================
function runLoop() {
  console.log("Starting Trojan service...");
  const loop = () => {
    const proc = spawn(TROJAN_BIN, [CONFIG_JSON], { stdio: "ignore" });
    proc.on("exit", (code) => {
      console.log(`Trojan exited (${code}), restarting in 5s...`);
      setTimeout(loop, 5000);
    });
  };
  loop();
}

// ================== 主流程 ==================
async function main() {
  console.log("Trojan 自动部署开始");

  // 1. 启动定时重启
  scheduleBeijingTimeMidnight(() => {
    process.exit(0);
  });

  // 2. 部署逻辑
  const port = readPort();
  const domain = "www.example.com"; // Trojan 不需要 SNI 伪装
  const password = randomHex(16); // 随机生成密码，和 TUIC 一样

  generateCert(domain);
  await checkTrojanServer();
  generateConfig(password, port);
  const ip = await getPublicIP();
  generateLink(password, ip, port);
  runLoop();
}

main().catch((err) => console.error("Error:", err));