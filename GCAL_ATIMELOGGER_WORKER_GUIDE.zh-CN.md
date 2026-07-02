# Google Calendar ↔ aTimeLogger Pro 双向同步 Worker（第三版新增）

这个 Cloudflare Worker 在云端定时（默认每 15 分钟）把 **Google 日历** 与 **aTimeLogger Pro** 双向同步：

- **Google 日历 → aTimeLogger**：日历中的定时事件（含开始/结束时间）会写入 aTimeLogger，作为一段活动记录。
- **aTimeLogger → Google 日历**：aTimeLogger 中的时间段会写入 Google 日历为事件。

## 防回声机制（不会两边互相无限复制）

- 由 aTimeLogger 生成的日历事件会打上 `extendedProperties.private.source = "atimelogger"`，并记录对应的 `atlIntervalGuid`。
- 由日历生成的 aTimeLogger interval 会在 `comment` 末尾追加 `[gcal:<事件ID>]`。
- 同步时会跳过带有对方来源标记、或已建立映射的记录。

## 一、准备 Google Calendar API（写权限）

双向需要 **写** 日历，所以不能用只读的 iCal 私密地址，要用 OAuth：

1. Google Cloud Console → 新建/选择项目 → 启用 **Google Calendar API**。
2. 创建 **OAuth 2.0 客户端 ID**（类型：桌面应用即可）。
3. 用 OAuth Playground 或本地脚本，以 scope `https://www.googleapis.com/auth/calendar` 换取 **refresh token**。
4. 记下 `client_id` / `client_secret` / `refresh_token` 三个值。

## 二、aTimeLogger 凭证

- 推荐直接用登录账号密码：`ATIMELOGGER_USERNAME` + `ATIMELOGGER_PASSWORD`（Worker 用 Basic 认证）。
- 或者用 `ATIMELOGGER_TOKEN`（配置后优先于账号密码，走 Bearer）。
- `ATIMELOGGER_BASE_URL` 默认 `https://app.atimelogger.pro`。

> aTimeLogger Web API v2 的字段以你现有可用脚本为准。若创建 interval 报错，改 `src/gcal-atimelogger-worker.js` 里的 `atlListIntervals` / `atlCreateInterval` 两个函数即可，其余逻辑无需改。

## 三、配置与部署

配置项在 `wrangler.gcal-atimelogger.jsonc` 的 `vars` 里（时区、方向、回看/前看天数、默认活动类型、cron）。机密用 secret 写入：

```bash
npx wrangler secret put GOOGLE_CLIENT_ID     -c wrangler.gcal-atimelogger.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET -c wrangler.gcal-atimelogger.jsonc
npx wrangler secret put GOOGLE_REFRESH_TOKEN -c wrangler.gcal-atimelogger.jsonc
npx wrangler secret put ATIMELOGGER_USERNAME -c wrangler.gcal-atimelogger.jsonc
npx wrangler secret put ATIMELOGGER_PASSWORD -c wrangler.gcal-atimelogger.jsonc
npx wrangler secret put GCAL_ATL_SYNC_SECRET -c wrangler.gcal-atimelogger.jsonc
```

本地调试与部署：

```bash
npm run worker:gcal-atimelogger:dev
npm run worker:gcal-atimelogger:deploy
```

## 四、先试运行（强烈建议）

`GCAL_DRY_RUN` 默认为 `true`：只计算并打印将要写入的记录，不真正写入两边。确认日志无误后，把 `wrangler.gcal-atimelogger.jsonc` 里的 `GCAL_DRY_RUN` 改为 `false` 再部署。

手动触发一次（部署后 Worker 地址在部署日志里）：

```bash
curl -X POST "https://<你的-worker>.workers.dev/sync" \
  -H "Authorization: Bearer <你的 GCAL_ATL_SYNC_SECRET>"

# 临时强制/关闭试运行：加 ?dryRun=true 或 ?dryRun=false
```

## 五、可调参数

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `SYNC_DIRECTION` | `both` / `gcal-to-atl` / `atl-to-gcal` | both |
| `GCAL_CALENDAR_ID` | 日历 ID，主日历填 `primary` | primary |
| `GCAL_ATL_LOOKBACK_DAYS` | 向前回看天数 | 1 |
| `GCAL_ATL_LOOKAHEAD_DAYS` | 向后前看天数 | 1 |
| `ATIMELOGGER_ACTIVITY_TYPE_NAME` | 日历事件写入 aTimeLogger 时使用的活动类型（可填分组名） | 工作 |
| `SYNC_TIMEZONE` | 时区 | Asia/Shanghai |
| `GCAL_DRY_RUN` | 试运行开关 | true |

## 六、限制与建议

- 当前版本只做**新增**同步（幂等去重），不处理编辑/删除的双向传播；如需删除/更新传播，可在两个方向里加 PATCH/DELETE 分支。
- Worker 无状态：靠标记去重，请勿手动删除日历事件的 `extendedProperties` 或 aTimeLogger 备注里的 `[gcal:...]` 标记。
- 建议先用一个测试日历 + 试运行验证一两天，再切主日历、关掉 dry-run。
