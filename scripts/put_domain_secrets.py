#!/usr/bin/env python3
"""
读取由 parse_domain_tokens.py 生成的 JSON 文件（{ "<wrangler-secret-name>": "<token>" }），
逐个执行 `npx wrangler secret put <name>` 把 token 通过 stdin 注入到 Cloudflare Worker。

用法：
  python scripts/put_domain_secrets.py <path-to-domain_tokens.json>
"""
from __future__ import annotations
import json
import subprocess
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: put_domain_secrets.py <domain_tokens.json>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    if not path.exists():
        print(f"[warn] 文件不存在：{path}，无根域名 token 需要注入", file=sys.stderr)
        return 0

    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict) or not data:
        print("[info] JSON 中没有根域名 token，跳过", file=sys.stderr)
        return 0

    for name, token in data.items():
        token = str(token or "")
        if not token:
            print(f"[warn] {name} 值为空，跳过", file=sys.stderr)
            continue
        # shell=True 让 Windows 上能找到 npx.cmd / npx.ps1；Linux 上 shell=True 也安全
        proc = subprocess.run(
            "npx wrangler secret put " + name,
            shell=True,
            input=token,
            text=True,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
        )
        if proc.returncode != 0:
            print(f"[err] wrangler secret put {name} 失败：{proc.stderr or proc.stdout}", file=sys.stderr)
            return proc.returncode
        print(f"[ok] wrangler secret put {name} -> 注入成功")

    return 0


if __name__ == "__main__":
    sys.exit(main())
