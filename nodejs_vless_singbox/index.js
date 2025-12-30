#!/usr/bin/env node
/**
 * =========================================
 * Sing-box VLESS 自动部署脚本（Node.js 版）
 * 定时重启：每天北京时间 00:00（24:00）
 * 
 * 【UUID 已手动设置！请修改下方双引号内的值】
 * 
 *    const UUID = "在这里填入您的UUID";
 * 
 *    示例：const UUID = "fdeeda45-0a8e-4570-bcc6-d68c995f5830";
 * 
 *    每次部署前请务必修改此值！
 * =========================================
 */
import { execSync, spawn } from "child_process";
import fs from "fs";
import https from "https";
import crypto from "crypto";

// ================== 【手动设置 UUID】==================
// 请将下方双引号内的值替换为您的 UUID
const UUID = "fdeeda45-0a8e-4570-bcc6-d68c995f5830";  // 修改这里！

// 格式校验（防止错误）
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(UUID)) {
  console.error("\nUUID 格式错误！");
  console.error("正确格式示例: fdeeda45-0a8e-4570-bcc6-d68c995f5830");
  console.error("当前值: " + UUID);
  process.exit(1);
}
console.log(`使用手动设置的 UUID: ${UUID}`);

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
const MASQ_DOMAINS = ["www.bing.com"];
const CONFIG_JSON = "config.json";
const CERT_PEM = "cert.pem";
const KEY_PEM = "key.pem";
const LINK_TXT = "vless_link.txt";
const SINGBOX_BIN = "./sing-box";

// ================== 工具函数 ==================
const randomPort = () => Math.floor(Math.random() * 40000) + 20000;
const randomSNI = () => MASQ_DOMAINS[Math.floor(Math.random() * MASQ_DOMAINS.length)];
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
    `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
    `-keyout ${KEY_PEM} -out ${CERT_PEM} -subj "/CN=${domain}" -days 365 -nodes`
  );
  fs.chmodSync(KEY_PEM, 0o600);
  fs.chmodSync(CERT_PEM, 0o644);
}

// ================== 下载 sing-box ==================
async function checkSingBox() {
  if (fileExists(SINGBOX_BIN)) {
    console.log("sing-box exists");
    return;
  }
  console.log("Downloading sing-box...");
  const url = "https://github.com/ppopcn/g/raw/refs/heads/main/sing-box-linux";
  await downloadFile(url, SINGBOX_BIN);
  fs.chmodSync(SINGBOX_BIN, 0o755);
  console.log("sing-box downloaded");
}

// ================== 生成配置 ==================
function generateConfig(uuid, port, domain) {
  const config = {
    "log": {
      "level": "warn",
      "timestamp": true
    },
    "inbounds": [
      {
        "type": "vless",
        "tag": "vless-in",
        "listen": "::",
        "listen_port": port,
        "users": [
          {
            "uuid": uuid,
            "name": "user1"
          }
        ],
        "tls": {
          "enabled": true,
          "server_name": domain,
          "certificate_path": CERT_PEM,
          "key_path": KEY_PEM
        },
        "transport": {
          "type": "ws",
          "path": "/",
          "early_data_header_name": "Sec-WebSocket-Protocol"
        }
      }
    ],
    "outbounds": [
      {
        "type": "direct",
        "tag": "direct"
      }
    ]
  };
  fs.writeFileSync(CONFIG_JSON, JSON.stringify(config, null, 2));
  console.log("Config generated:", CONFIG_JSON);
}

// ================== 生成链接 ==================
function generateLink(uuid, ip, port, domain) {
  // vless://uuid@ip:port?security=tls&encryption=none&type=ws&path=/&sni=domain#Alias
  const link = `vless://${uuid}@${ip}:${port}?security=tls&encryption=none&type=ws&path=%2F&sni=${domain}&allowInsecure=1#VLESS-WS-${ip}`;
  fs.writeFileSync(LINK_TXT, link);
  console.log("VLESS Link:");
  console.log(link);
}

// ================== 守护运行 ==================
function runLoop() {
  console.log("Starting Sing-box service...");
  const loop = () => {
    const proc = spawn(SINGBOX_BIN, ["run", "-c", CONFIG_JSON], { stdio: "ignore" });
    proc.on("exit", (code) => {
      console.log(`Sing-box exited (${code}), restarting in 5s...`);
      setTimeout(loop, 5000);
    });
  };
  loop();
}

// ================== 主流程 ==================
async function main() {
  console.log("Sing-box VLESS 自动部署开始");

  // 1. 启动定时重启
  scheduleBeijingTimeMidnight(() => {
    process.exit(0);
  });

  // 2. 部署逻辑
  const port = readPort();
  const domain = randomSNI();
  // VLESS 不需要 password, 只需要 uuid
  
  generateCert(domain);
  await checkSingBox();
  generateConfig(UUID, port, domain);
  const ip = await getPublicIP();
  generateLink(UUID, ip, port, domain);
  runLoop();
}

main().catch((err) => console.error("Error:", err));
