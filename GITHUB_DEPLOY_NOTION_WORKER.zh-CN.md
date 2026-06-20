# 第三版：通过 GitHub CLI 部署 Notion Worker

这里的 Worker 实际运行在 Cloudflare Workers，不是 Notion 自己的服务器。Notion 只是数据写入目标。

## 一键方式

Windows 双击：

```text
deploy-notion-worker-github.cmd
```

Linux/macOS：

```bash
sh deploy-notion-worker-github.sh
```

脚本会做这些事：

- 检查 `git` 和 `gh`。
- 如果第三版目录还不是 Git 仓库，会自动初始化。
- 创建或使用 GitHub 远程仓库。
- 把部署需要的密钥写入 GitHub Secrets。
- 触发 GitHub Actions 部署 Cloudflare Worker。

## 需要提前准备

本机需要安装并登录 GitHub CLI：

```bash
gh auth login
```

Cloudflare 需要创建一个 API Token，权限至少要能部署 Worker 和写 Worker Secret。

Notion integration 必须已经被添加到目标数据库的 Connections。

## GitHub Secrets

脚本会提示你输入这些值，不会写入项目文件：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID（可选）
NOTION_TOKEN
NOTION_DATABASE_ID
ATIMELOGGER_USERNAME
ATIMELOGGER_PASSWORD
ATIMELOGGER_NOTION_SYNC_SECRET
```

如果你选择用 aTimeLogger token，可以用 `ATIMELOGGER_TOKEN` 替代账号密码。

当前 Notion 数据库 ID：

```text
36aa70c5-5943-80d1-88d2-dc00b8eeab1d
```

## 部署后手动同步

部署完成后，GitHub Actions 日志里会显示 Worker 地址。可以这样同步某一天：

```bash
curl -X POST "https://你的-worker.workers.dev/sync?date=2026-06-19" \
  -H "Authorization: Bearer 你的ATIMELOGGER_NOTION_SYNC_SECRET"
```

同步日期范围：

```bash
curl -X POST "https://你的-worker.workers.dev/sync?from=2026-06-01&to=2026-06-19" \
  -H "Authorization: Bearer 你的ATIMELOGGER_NOTION_SYNC_SECRET"
```

默认定时任务是每天北京时间 06:10 运行一次。
