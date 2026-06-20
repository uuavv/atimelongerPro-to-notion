# 第三版：aTimeLogger Pro 同步到 Notion Worker

这个 Worker 会定时读取 aTimeLogger Pro 的活动区间，并写入 Notion 数据库。它只保存在第三版目录中，不会修改第一版或第二版。

## Notion 字段

至少需要：

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `Name` | Title | 记录标题 |
| `aTimeLogger Interval ID` | Rich text | 查重和更新同一条 aTimeLogger 区间 |

可选字段存在且类型匹配时会自动写入：

| 字段 | 推荐类型 |
| --- | --- |
| `aTimeLogger Activity ID` | Rich text |
| `aTimeLogger Type ID` | Rich text |
| `Activity Type` | Rich text 或 Select |
| `Start` | Date |
| `End` | Date |
| `Duration Seconds` | Number |
| `Comment` | Rich text |
| `Tags` | Multi-select |
| `Source` | Select 或 Rich text |
| `Last Synced` | Date |
| `aTimeLogger From Timestamp` | Number |
| `aTimeLogger To Timestamp` | Number |
| `aTimeLogger API Duration` | Number |
| `Type Group` | Checkbox |
| `Type Color` | Number |
| `Type Image ID` | Rich text |
| `Type Parent ID` | Rich text |
| `Type Order` | Number |
| `Type Deleted` | Checkbox |
| `Type Archived` | Checkbox |
| `Type Occurrence` | Checkbox |
| `aTimeLogger Raw JSON` | Rich text |

## Cloudflare Secrets

部署前设置：

```bash
npx wrangler secret put NOTION_TOKEN -c wrangler.atimelogger-notion.jsonc
npx wrangler secret put NOTION_DATA_SOURCE_ID -c wrangler.atimelogger-notion.jsonc
npx wrangler secret put ATIMELOGGER_USERNAME -c wrangler.atimelogger-notion.jsonc
npx wrangler secret put ATIMELOGGER_PASSWORD -c wrangler.atimelogger-notion.jsonc
npx wrangler secret put ATIMELOGGER_NOTION_SYNC_SECRET -c wrangler.atimelogger-notion.jsonc
```

如果你使用旧版 Notion database ID，可以改用 `NOTION_DATABASE_ID`。

## 本地安全配置 Notion 字段

可以运行一次性配置工具：

```bash
npm run notion:setup-fields
```

它会在本机终端中要求输入 `NOTION_TOKEN`，输入时不会显示。工具会：

- 读取目标 Notion 数据库或 data source。
- 检查第三版 Worker 需要的字段。
- 自动添加缺失字段。
- 可选写入 `NOTION_TOKEN` 和 `NOTION_DATA_SOURCE_ID` / `NOTION_DATABASE_ID` 到 Cloudflare secrets。

token 不会写入项目文件。

## 运行方式

本地测试：

```bash
npm test
```

本地启动 Worker：

```bash
npm run worker:atimelogger-notion:dev
```

部署：

```bash
npm run worker:atimelogger-notion:deploy
```

## 手动触发

部署后可以手动同步指定日期：

```bash
curl -X POST "https://你的-worker.workers.dev/sync?date=2026-06-19" \
  -H "Authorization: Bearer 你的ATIMELOGGER_NOTION_SYNC_SECRET"
```

也可以同步日期范围：

```bash
curl -X POST "https://你的-worker.workers.dev/sync?from=2026-06-01&to=2026-06-19" \
  -H "Authorization: Bearer 你的ATIMELOGGER_NOTION_SYNC_SECRET"
```

## 定时同步

`wrangler.atimelogger-notion.jsonc` 默认每天 UTC 22:10 运行一次，对应北京时间 06:10。Worker 会按 `SYNC_TIMEZONE=Asia/Shanghai` 计算当天日期。

如果想每次补同步最近几天，修改：

```json
"ATIMELOGGER_NOTION_LOOKBACK_DAYS": "3"
```

## aTimeLogger 官方过滤字段

Worker 已按作者提供的 OpenAPI 文档使用 `/api/intervals` 历史接口。默认请求全部类型和全部标签：

```json
{
  "types": [],
  "tags": []
}
```

如果只想同步某些 aTimeLogger 活动类型 ID 或标签，可以设置：

```text
ATIMELOGGER_NOTION_TYPE_IDS=type-id-1,type-id-2
ATIMELOGGER_NOTION_TAGS=focus,deep work
```

如果你在 aTimeLogger Pro 里已有过滤器，也可以设置：

```text
ATIMELOGGER_NOTION_FILTER_ID=filter-uuid
```

设置 `ATIMELOGGER_NOTION_FILTER_ID` 后，aTimeLogger 会优先使用这个过滤器，`types` 和 `tags` 会被忽略。

## 查重规则

Worker 使用 `aTimeLogger Interval ID` 查找 Notion 页面：

- 找不到：创建新页面。
- 找到：更新原页面。

因此不需要依赖本地 `.toggl-atimelogger-state.json`。
