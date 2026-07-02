# 服务器部署指南（手机 SSH 即可）

把 Google Calendar ↔ aTimeLogger Pro 双向同步脚本跑在你自己的云服务器上（腾讯云 CVM 等）。
入口脚本：`scripts/gcal-atimelogger-sync.mjs`（自包含，跑一次就退，适合定时任务）。

## 0. 前提
- Node.js **>= 18**（需要内置 fetch）。检查：`node -v`。
  - 没装的话（Ubuntu/Debian）：`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs`
- Google Calendar API 的 client_id / client_secret / refresh_token（scope: calendar）。

## 1. 拉代码
```bash
git clone https://github.com/uuavv/atimelongerPro-to-notion.git
cd atimelongerPro-to-notion
```
以后更新：`git pull`。

## 2. 配置密钥
```bash
cp .env.server.example scripts/.env
nano scripts/.env   # 手机上用你的 ssh 客户端编辑器也行，填入真实值
```
> 脚本默认读取同目录 `.env`；也可用 `ENV_FILE=/路径/.env` 指定。

## 3. 先试跑（不写入）
```bash
cd scripts
node gcal-atimelogger-sync.mjs --dry-run
```
看输出的 summary 与将要写入的条目。确认无误后，把 `.env` 里的 `GCAL_DRY_RUN` 改为 `false`。

## 4. 正式跑一次
```bash
node gcal-atimelogger-sync.mjs
```

## 5. 定时（二选一）

### 方式 A：crontab（最轻量，推荐手机部署）
```bash
crontab -e
```
加一行（每 15 分钟一次，把路径换成你的实际目录）：
```cron
*/15 * * * * cd /root/atimelongerPro-to-notion/scripts && /usr/bin/node gcal-atimelogger-sync.mjs >> /root/gcal-atl-sync.log 2>&1
```
看日志：`tail -f /root/gcal-atl-sync.log`

### 方式 B：systemd service + timer（开机自启、日志规范）
`/etc/systemd/system/gcal-atl-sync.service`：
```ini
[Unit]
Description=Google Calendar <-> aTimeLogger sync
[Service]
Type=oneshot
WorkingDirectory=/root/atimelongerPro-to-notion/scripts
ExecStart=/usr/bin/node gcal-atimelogger-sync.mjs
```
`/etc/systemd/system/gcal-atl-sync.timer`：
```ini
[Unit]
Description=Run gcal-atl sync every 15 min
[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Persistent=true
[Install]
WantedBy=timers.target
```
启用：
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gcal-atl-sync.timer
sudo systemctl list-timers | grep gcal    # 查看下次触发
journalctl -u gcal-atl-sync.service -f     # 看日志
```

## 6. 安全提醒
- `.env` 已在 `.gitignore` 忽略范围内（以 `.env` 结尾），不要把真实密钥提交到仓库。
- 服务器上 `chmod 600 scripts/.env` 限制权限。

## 限制
- 当前仅做**新增**同步（幂等去重），不传播编辑/删除。
- aTimeLogger Web API v2 字段若与你实际不符，改 `atlListIntervals` / `atlCreateInterval` 两个函数即可。
