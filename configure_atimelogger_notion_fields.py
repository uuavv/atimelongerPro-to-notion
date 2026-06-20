from __future__ import annotations

import getpass
import json
import re
import shutil
import subprocess
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


PROJECT_DIR = Path(__file__).resolve().parent
WRANGLER_CONFIG = PROJECT_DIR / "wrangler.atimelogger-notion.jsonc"
DATA_SOURCE_VERSION = "2025-09-03"
DATABASE_VERSION = "2022-06-28"

REQUIRED_PROPERTIES: dict[str, dict] = {
    "aTimeLogger Interval ID": {"rich_text": {}},
    "aTimeLogger Activity ID": {"rich_text": {}},
    "aTimeLogger Type ID": {"rich_text": {}},
    "Activity Type": {"rich_text": {}},
    "Start": {"date": {}},
    "End": {"date": {}},
    "Duration Seconds": {"number": {"format": "number"}},
    "Comment": {"rich_text": {}},
    "Tags": {"multi_select": {"options": []}},
    "Source": {"rich_text": {}},
    "Last Synced": {"date": {}},
    "aTimeLogger From Timestamp": {"number": {"format": "number"}},
    "aTimeLogger To Timestamp": {"number": {"format": "number"}},
    "aTimeLogger API Duration": {"number": {"format": "number"}},
    "Type Group": {"checkbox": {}},
    "Type Color": {"number": {"format": "number"}},
    "Type Image ID": {"rich_text": {}},
    "Type Parent ID": {"rich_text": {}},
    "Type Order": {"number": {"format": "number"}},
    "Type Deleted": {"checkbox": {}},
    "Type Archived": {"checkbox": {}},
    "Type Occurrence": {"checkbox": {}},
    "aTimeLogger Raw JSON": {"rich_text": {}},
}


def main() -> int:
    print("第三版 Notion 字段配置工具")
    print("token 只会在本机内存中使用，不会写入项目文件。")

    token = getpass.getpass("粘贴 NOTION_TOKEN（输入时不会显示）：").strip()
    if not token:
        print("未输入 NOTION_TOKEN。")
        return 1

    default_target = (
        "https://app.notion.com/p/dieday/"
        "36aa70c5594380d188d2dc00b8eeab1d"
        "?v=36aa70c559438109a739000c53c276cd"
    )
    target = input(f"Notion 数据库/Data Source 链接或 ID [{default_target}]: ").strip() or default_target
    target_info = resolve_target(token, target)
    if not target_info:
        print("无法读取这个 Notion 数据库。请确认 integration 已添加到数据库 Connections。")
        return 1

    kind, target_id, schema = target_info
    print(f"已识别目标：{kind} {target_id}")

    title_names = [
        name for name, prop in schema.get("properties", {}).items()
        if prop.get("type") == "title"
    ]
    if title_names:
        print(f"标题字段：{title_names[0]}")
    else:
        print("警告：没有找到 Title 字段。")

    existing = set(schema.get("properties", {}))
    missing = {
        name: definition
        for name, definition in REQUIRED_PROPERTIES.items()
        if name not in existing
    }

    if not missing:
        print("字段已经齐全，不需要添加。")
    else:
        print("将添加字段：")
        for name in missing:
            print(f" - {name}")
        if not confirm("确认添加这些字段？", default=True):
            print("已取消。")
            return 1
        update_properties(token, kind, target_id, missing)
        print("字段已添加。")

    if confirm("是否同时写入 Cloudflare Notion secrets？", default=True):
        put_secret("NOTION_TOKEN", token)
        if kind == "data_source":
            put_secret("NOTION_DATA_SOURCE_ID", target_id)
        else:
            put_secret("NOTION_DATABASE_ID", target_id)
        print("Cloudflare Notion secrets 已写入。")

    print("完成。")
    return 0


def resolve_target(token: str, value: str) -> tuple[str, str, dict] | None:
    candidates = extract_ids(value) or [value.strip()]

    for candidate in candidates:
        schema = notion_request(
            "GET",
            f"https://api.notion.com/v1/data_sources/{candidate}",
            token,
            DATA_SOURCE_VERSION,
            None,
            quiet=True,
        )
        if schema and schema.get("properties"):
            return "data_source", normalize_id(candidate), schema

    for candidate in candidates:
        schema = notion_request(
            "GET",
            f"https://api.notion.com/v1/databases/{candidate}",
            token,
            DATABASE_VERSION,
            None,
            quiet=True,
        )
        if schema and schema.get("properties"):
            return "database", normalize_id(candidate), schema

    return None


def update_properties(token: str, kind: str, target_id: str, properties: dict[str, dict]) -> None:
    if kind == "data_source":
        url = f"https://api.notion.com/v1/data_sources/{target_id}"
        version = DATA_SOURCE_VERSION
    else:
        url = f"https://api.notion.com/v1/databases/{target_id}"
        version = DATABASE_VERSION
    notion_request("PATCH", url, token, version, {"properties": properties})


def notion_request(
    method: str,
    url: str,
    token: str,
    notion_version: str,
    body: dict | None,
    quiet: bool = False,
) -> dict | None:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Notion-Version": notion_version,
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            text = response.read().decode("utf-8")
            return json.loads(text) if text else {}
    except HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        if not quiet:
            raise RuntimeError(f"Notion API {error.code}: {details}") from error
    except URLError as error:
        if not quiet:
            raise RuntimeError(f"请求 Notion 失败：{error}") from error
    return None


def extract_ids(value: str) -> list[str]:
    ids: list[str] = []
    for pattern in (
        r"[0-9a-fA-F]{32}",
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
    ):
        for match in re.findall(pattern, value):
            normalized = normalize_id(match)
            if normalized not in ids:
                ids.append(normalized)
    return ids


def normalize_id(value: str) -> str:
    compact = value.replace("-", "").lower()
    if len(compact) != 32:
        return value
    return f"{compact[:8]}-{compact[8:12]}-{compact[12:16]}-{compact[16:20]}-{compact[20:]}"


def confirm(prompt: str, default: bool) -> bool:
    suffix = "[Y/n]" if default else "[y/N]"
    answer = input(f"{prompt} {suffix}: ").strip().lower()
    if not answer:
        return default
    return answer in {"y", "yes", "是"}


def put_secret(name: str, value: str) -> None:
    npx = shutil.which("npx.cmd") or shutil.which("npx")
    if not npx:
        raise RuntimeError("没有找到 npx。请先安装 Node.js，或确认 npx 在 PATH 中。")
    command = [npx, "wrangler", "secret", "put", name, "-c", str(WRANGLER_CONFIG)]
    completed = subprocess.run(
        command,
        cwd=PROJECT_DIR,
        input=value + "\n",
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"写入 Cloudflare secret 失败：{name}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n已取消。")
        raise SystemExit(1)
