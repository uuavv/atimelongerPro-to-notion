#!/usr/bin/env node
// 服务器版：Google Calendar <-> aTimeLogger Pro 双向同步（自包含，跑一次就退）
// 适用于 crontab / systemd timer 定时调起。Node >= 18（需全局 fetch）。
// 用法：
//   node gcal-atimelogger-sync.mjs            正式同步
//   node gcal-atimelogger-sync.mjs --dry-run  只打印不写入
// 配置：同目录 .env 文件（或环境变量 ENV_FILE 指定路径）。

import { readFileSync, existsSync } from "node:fs"

const GCAL_API = "https://www.googleapis.com/calendar/v3"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GCAL_MARKER_RE = /\[gcal:([^\]]+)\]/

export async function runSync(env, overrides = {}) {
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

	const atlByGcalId = new Map()
	for (const iv of atlIntervals) {
		const m = (iv.comment || "").match(GCAL_MARKER_RE)
		if (m) atlByGcalId.set(m[1], iv)
	}
	const gcalByAtlGuid = new Map()
	for (const ev of gcalEvents) {
		const g = ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.atlIntervalGuid
		if (g) gcalByAtlGuid.set(g, ev)
	}

	const summary = { gcalToAtlCreated: 0, atlToGcalCreated: 0, skipped: 0, dryRun: cfg.dryRun }
	const actions = []

	if (cfg.direction === "both" || cfg.direction === "gcal-to-atl") {
		for (const ev of gcalEvents) {
			if (!isTimedEvent(ev)) { summary.skipped++; continue }
			const fromAtl = ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.source === "atimelogger"
			if (fromAtl) { summary.skipped++; continue }
			if (atlByGcalId.has(ev.id)) { summary.skipped++; continue }
			if (!defaultTypeGuid) throw new Error("no aTimeLogger activity type; set ATIMELOGGER_ACTIVITY_TYPE_NAME")
			const from = Math.floor(new Date(ev.start.dateTime).getTime() / 1000)
			const to = Math.floor(new Date(ev.end.dateTime).getTime() / 1000)
			const comment = `${ev.summary || "(no title)"} [gcal:${ev.id}]`
			actions.push({ dir: "gcal->atl", summary: ev.summary, from, to })
			if (!cfg.dryRun) await atlCreateInterval(env, cfg, { typeGuid: defaultTypeGuid, from, to, comment })
			summary.gcalToAtlCreated++
		}
	}

	if (cfg.direction === "both" || cfg.direction === "atl-to-gcal") {
		for (const iv of atlIntervals) {
			if (GCAL_MARKER_RE.test(iv.comment || "")) { summary.skipped++; continue }
			if (!iv.from || !iv.to) { summary.skipped++; continue }
			if (gcalByAtlGuid.has(iv.guid)) { summary.skipped++; continue }
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

async function getGoogleAccessToken(env) {
	const body = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		client_secret: env.GOOGLE_CLIENT_SECRET,
		refresh_token: env.GOOGLE_REFRESH_TOKEN,
		grant_type: "refresh_token",
	})
	const res = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body })
	if (!res.ok) throw new Error(`Google token failed ${res.status}: ${await res.text()}`)
	return (await res.json()).access_token
}

async function listGcalEvents(accessToken, calendarId, timeMin, timeMax) {
	const events = []
	let pageToken
	do {
		const params = new URLSearchParams({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "2500" })
		if (pageToken) params.set("pageToken", pageToken)
		const res = await fetch(`${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } })
		if (!res.ok) throw new Error(`GCal list failed ${res.status}: ${await res.text()}`)
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
	if (!res.ok) throw new Error(`GCal insert failed ${res.status}: ${await res.text()}`)
	return res.json()
}

function isTimedEvent(ev) {
	return ev && ev.status !== "cancelled" && ev.start && ev.start.dateTime && ev.end && ev.end.dateTime
}

function atlHeaders(env) {
	if (env.ATIMELOGGER_TOKEN) return { Authorization: `Bearer ${env.ATIMELOGGER_TOKEN}` }
	const basic = Buffer.from(`${env.ATIMELOGGER_USERNAME}:${env.ATIMELOGGER_PASSWORD}`).toString("base64")
	return { Authorization: `Basic ${basic}` }
}

async function atlListTypes(env, cfg) {
	const res = await fetch(`${cfg.atlBaseUrl}/api/v2/types`, { headers: atlHeaders(env) })
	if (!res.ok) throw new Error(`aTimeLogger types failed ${res.status}: ${await res.text()}`)
	const data = await res.json()
	return data.types || data || []
}

async function atlListIntervals(env, cfg, fromEpoch, toEpoch) {
	const params = new URLSearchParams({ from: String(fromEpoch), to: String(toEpoch), limit: "1000" })
	const res = await fetch(`${cfg.atlBaseUrl}/api/v2/intervals?${params}`, { headers: atlHeaders(env) })
	if (!res.ok) throw new Error(`aTimeLogger intervals failed ${res.status}: ${await res.text()}`)
	const data = await res.json()
	return data.intervals || data || []
}

async function atlCreateInterval(env, cfg, { typeGuid, from, to, comment }) {
	const payload = { guid: crypto.randomUUID(), from, to, comment, type: { guid: typeGuid } }
	const res = await fetch(`${cfg.atlBaseUrl}/api/v2/intervals`, {
		method: "POST",
		headers: { ...atlHeaders(env), "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	})
	if (!res.ok) throw new Error(`aTimeLogger create interval failed ${res.status}: ${await res.text()}`)
	return res.json().catch(() => ({}))
}

function resolveDefaultTypeGuid(types, name) {
	if (!name) return types[0] && types[0].guid
	const hit = types.find((t) => (t.name || "").trim() === name.trim())
	if (hit) return hit.guid
	const grouped = types.find((t) => (t.group || (t.parent && t.parent.name) || "").trim() === name.trim())
	return grouped ? grouped.guid : undefined
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d }

function loadEnvFile(path) {
	if (!path || !existsSync(path)) return
	const text = readFileSync(path, "utf8")
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim()
		if (!line || line.startsWith("#")) continue
		const eq = line.indexOf("=")
		if (eq < 0) continue
		const key = line.slice(0, eq).trim()
		let val = line.slice(eq + 1).trim()
		if ((val.startsWith('\"') && val.endsWith('\"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
		if (process.env[key] === undefined) process.env[key] = val
	}
}

async function main() {
	const envFile = process.env.ENV_FILE || new URL("./.env", import.meta.url).pathname
	loadEnvFile(envFile)
	const dryRun = process.argv.includes("--dry-run")
	const result = await runSync(process.env, dryRun ? { dryRunOverride: "true" } : {})
	console.log(new Date().toISOString(), "sync", JSON.stringify(result.summary))
	for (const a of result.actions || []) console.log("  -", a.dir, "|", a.summary)
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((e) => { console.error(new Date().toISOString(), "sync failed:", (e && e.stack) || e); process.exit(1) })
}
