// Google Calendar <-> aTimeLogger Pro 双向同步 Cloudflare Worker
// - scheduled(): 由 wrangler.gcal-atimelogger.jsonc 的 cron 触发，自动双向同步
// - fetch(): 提供 /sync 手动触发端点（需 Bearer <GCAL_ATL_SYNC_SECRET>）与 /health
//
// 防回声（避免两边互相无限复制）依赖两类标记：
//   1. 由 aTimeLogger 生成的 Google 日历事件：extendedProperties.private.source = "atimelogger"
//      并记录 extendedProperties.private.atlIntervalGuid = <aTimeLogger interval guid>
//   2. 由 Google 日历生成的 aTimeLogger interval：comment 结尾追加 "[gcal:<eventId>]"
//
// 注意：aTimeLogger Web API v2 的字段以你现有可用脚本为准；如有出入，改 atlListIntervals /
// atlCreateInterval 两个函数即可，其余同步逻辑无需改动。

const GCAL_API = "https://www.googleapis.com/calendar/v3"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GCAL_MARKER_RE = /\[gcal:([^\]]+)\]/

export default {
	async scheduled(event, env, ctx) {
		ctx.waitUntil(
			runSync(env)
				.then((r) => console.log("[cron] sync ok", JSON.stringify(r.summary)))
				.catch((err) => console.error("[cron] sync failed", err && err.stack || err)),
		)
	},

	async fetch(request, env) {
		const url = new URL(request.url)
		if (url.pathname === "/" || url.pathname === "/health") {
			return json({ ok: true, service: "gcal-atimelogger-worker", endpoints: ["/sync"] })
		}
		if (url.pathname === "/sync") {
			const token = extractBearer(request)
			if (!env.GCAL_ATL_SYNC_SECRET || token !== env.GCAL_ATL_SYNC_SECRET) {
				return json({ ok: false, error: "Unauthorized" }, 401)
			}
			try {
				const dryRunOverride = url.searchParams.get("dryRun")
				const result = await runSync(env, { dryRunOverride })
				return json({ ok: true, ...result })
			} catch (err) {
				return json({ ok: false, error: String((err && err.message) || err) }, 500)
			}
		}
		return json({ ok: false, error: "Not found" }, 404)
	},
}

async function runSync(env, overrides = {}) {
	const cfg = readConfig(env, overrides)
	const now = Date.now()
	const timeMin = new Date(now - cfg.lookbackDays * 86400000)
	const timeMax = new Date(now + cfg.lookaheadDays * 86400000)

	const accessToken = await getGoogleAccessToken(env)
	const [gcalEvents, atlIntervals, atlTypes] = await Promise.all([
		listGcalEvents(accessToken, cfg.calendarId, timeMin, timeMax),
		atlListIntervals(env, cfg, Math.floor(timeMin.getTime() / 1000), Math.floor(timeMax.getTime() / 1000)),
		atlListTypes(env, cfg),
	])

	const typeByGuid = new Map()
	for (const t of atlTypes) typeByGuid.set(t.guid, t)
	const defaultTypeGuid = resolveDefaultTypeGuid(atlTypes, cfg.defaultActivityTypeName)

	// 建立映射，用于防回声与去重
	const atlByGcalId = new Map() // gcalEventId -> interval
	for (const iv of atlIntervals) {
		const m = (iv.comment || "").match(GCAL_MARKER_RE)
		if (m) atlByGcalId.set(m[1], iv)
	}
	const gcalByAtlGuid = new Map() // atlGuid -> gcal event
	for (const ev of gcalEvents) {
		const g = ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.atlIntervalGuid
		if (g) gcalByAtlGuid.set(g, ev)
	}

	const summary = { gcalToAtlCreated: 0, atlToGcalCreated: 0, skipped: 0, dryRun: cfg.dryRun }
	const actions = []

	// 方向 A：Google Calendar -> aTimeLogger
	if (cfg.direction === "both" || cfg.direction === "gcal-to-atl") {
		for (const ev of gcalEvents) {
			if (!isTimedEvent(ev)) { summary.skipped++; continue }
			const fromAtl = ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.source === "atimelogger"
			if (fromAtl) { summary.skipped++; continue } // 本来就是我们从 ATL 写过去的，不回灌
			if (atlByGcalId.has(ev.id)) { summary.skipped++; continue } // 已同步过
			if (!defaultTypeGuid) throw new Error("未找到 aTimeLogger 活动类型：请设置 ATIMELOGGER_ACTIVITY_TYPE_NAME")
			const from = Math.floor(new Date(ev.start.dateTime).getTime() / 1000)
			const to = Math.floor(new Date(ev.end.dateTime).getTime() / 1000)
			const comment = `${ev.summary || "(无标题)"} [gcal:${ev.id}]`
			actions.push({ dir: "gcal->atl", summary: ev.summary, from, to })
			if (!cfg.dryRun) await atlCreateInterval(env, cfg, { typeGuid: defaultTypeGuid, from, to, comment })
			summary.gcalToAtlCreated++
		}
	}

	// 方向 B：aTimeLogger -> Google Calendar
	if (cfg.direction === "both" || cfg.direction === "atl-to-gcal") {
		for (const iv of atlIntervals) {
			if (GCAL_MARKER_RE.test(iv.comment || "")) { summary.skipped++; continue } // 本来就是从 gcal 来的，不回灌
			if (!iv.from || !iv.to) { summary.skipped++; continue }
			if (gcalByAtlGuid.has(iv.guid)) { summary.skipped++; continue } // 已同步过
			const typeName = (iv.type && (iv.type.name || (typeByGuid.get(iv.type.guid) || {}).name)) || "aTimeLogger"
			const title = iv.comment ? `${typeName}: ${iv.comment}` : typeName
			const body = {
				summary: title,
				start: { dateTime: new Date(iv.from * 1000).toISOString(), timeZone: cfg.timezone },
				end: { dateTime: new Date(iv.to * 1000).toISOString(), timeZone: cfg.timezone },
				extendedProperties: { private: { source: "atimelogger", atlIntervalGuid: iv.guid } },
			}
			actions.push({ dir: "atl->gcal", summary: title, from: iv.from, to: iv.to })
			if (!cfg.dryRun) await insertGcalEvent(accessToken, cfg.calendarId, body)
			summary.atlToGcalCreated++
		}
	}

	return { summary, window: { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString() }, actions }
}

function readConfig(env, overrides) {
	const dryRun = overrides.dryRunOverride != null
		? overrides.dryRunOverride === "true"
		: String(env.GCAL_DRY_RUN || "false") === "true"
	return {
		timezone: env.SYNC_TIMEZONE || "Asia/Shanghai",
		direction: (env.SYNC_DIRECTION || "both").toLowerCase(),
		calendarId: env.GCAL_CALENDAR_ID || "primary",
		lookbackDays: num(env.GCAL_ATL_LOOKBACK_DAYS, 1),
		lookaheadDays: num(env.GCAL_ATL_LOOKAHEAD_DAYS, 1),
		defaultActivityTypeName: env.ATIMELOGGER_ACTIVITY_TYPE_NAME || "",
		atlBaseUrl: (env.ATIMELOGGER_BASE_URL || "https://app.atimelogger.pro").replace(/\/$/, ""),
		dryRun,
	}
}

// ---------- Google Calendar ----------
async function getGoogleAccessToken(env) {
	const body = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		client_secret: env.GOOGLE_CLIENT_SECRET,
		refresh_token: env.GOOGLE_REFRESH_TOKEN,
		grant_type: "refresh_token",
	})
	const res = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	})
	if (!res.ok) throw new Error(`Google token 失败 ${res.status}: ${await res.text()}`)
	return (await res.json()).access_token
}

async function listGcalEvents(accessToken, calendarId, timeMin, timeMax) {
	const events = []
	let pageToken
	do {
		const params = new URLSearchParams({
			timeMin: timeMin.toISOString(),
			timeMax: timeMax.toISOString(),
			singleEvents: "true",
			orderBy: "startTime",
			maxResults: "2500",
		})
		if (pageToken) params.set("pageToken", pageToken)
		const res = await fetch(`${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		})
		if (!res.ok) throw new Error(`GCal 列表失败 ${res.status}: ${await res.text()}`)
		const data = await res.json()
		for (const it of data.items || []) events.push(it)
		pageToken = data.nextPageToken
	} while (pageToken)
	return events
}

async function insertGcalEvent(accessToken, calendarId, body) {
	const res = await fetch(`${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})
	if (!res.ok) throw new Error(`GCal 创建失败 ${res.status}: ${await res.text()}`)
	return res.json()
}

function isTimedEvent(ev) {
	return ev && ev.status !== "cancelled" && ev.start && ev.start.dateTime && ev.end && ev.end.dateTime
}

// ---------- aTimeLogger ----------
function atlHeaders(env) {
	if (env.ATIMELOGGER_TOKEN) return { Authorization: `Bearer ${env.ATIMELOGGER_TOKEN}` }
	const basic = btoa(`${env.ATIMELOGGER_USERNAME}:${env.ATIMELOGGER_PASSWORD}`)
	return { Authorization: `Basic ${basic}` }
}

async function atlListTypes(env, cfg) {
	const res = await fetch(`${cfg.atlBaseUrl}/api/v2/types`, { headers: atlHeaders(env) })
	if (!res.ok) throw new Error(`aTimeLogger types 失败 ${res.status}: ${await res.text()}`)
	const data = await res.json()
	return data.types || data || []
}

async function atlListIntervals(env, cfg, fromEpoch, toEpoch) {
	const params = new URLSearchParams({ from: String(fromEpoch), to: String(toEpoch), limit: "1000" })
	const res = await fetch(`${cfg.atlBaseUrl}/api/v2/intervals?${params}`, { headers: atlHeaders(env) })
	if (!res.ok) throw new Error(`aTimeLogger intervals 失败 ${res.status}: ${await res.text()}`)
	const data = await res.json()
	return data.intervals || data || []
}

async function atlCreateInterval(env, cfg, { typeGuid, from, to, comment }) {
	const payload = {
		guid: crypto.randomUUID(),
		from,
		to,
		comment,
		type: { guid: typeGuid },
	}
	const res = await fetch(`${cfg.atlBaseUrl}/api/v2/intervals`, {
		method: "POST",
		headers: { ...atlHeaders(env), "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	})
	if (!res.ok) throw new Error(`aTimeLogger 创建 interval 失败 ${res.status}: ${await res.text()}`)
	return res.json().catch(() => ({}))
}

function resolveDefaultTypeGuid(types, name) {
	if (!name) return types[0] && types[0].guid
	const hit = types.find((t) => (t.name || "").trim() === name.trim())
	if (hit) return hit.guid
	// 允许按分组名匹配：取该分组下第一个类型
	const grouped = types.find((t) => (t.group || (t.parent && t.parent.name) || "").trim() === name.trim())
	return grouped ? grouped.guid : undefined
}

// ---------- utils ----------
function num(v, d) {
	const n = Number(v)
	return Number.isFinite(n) ? n : d
}
function extractBearer(request) {
	const h = request.headers.get("authorization") || ""
	const m = h.match(/^Bearer\s+(.+)$/i)
	return m ? m[1] : request.headers.get("x-sync-secret") || ""
}
function json(obj, status = 200) {
	return new Response(JSON.stringify(obj, null, 2), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	})
}
