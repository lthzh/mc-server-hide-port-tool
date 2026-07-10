#!/usr/bin/env python3
"""
解析 CLOUDFLARE_DOMAINS_API_TOKEN（格式  domain1:token1,domain2:token2,...），
为每个 ':'-之前的吐出 wrangler secret 名（域名小写、点换下划线）+ 对应 token 值，
写入 JSON：{ "<域名点换下划线>_CLOUDFLARE_API_TOKEN": "<token>" }

同时校验 DOMAINS（JSON 数组）中出现的根域名是否都有对应 token；缺失则警告但不退出。

用法：
  python scripts/parse_domain_tokens.py <CLOUDFLARE_DOMAINS_API_TOKEN> [--domains <DOMAINS_JSON>]
输出（stdout）：
    line 1: 逗号分隔的 wrangler secret 名列表（已配置的非空 token）
    line 2: JSON 对象，键=wrangler secret 名，值=token
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from typing import Any


def secret_name_for(domain: str) -> str:
    """域名 -> wrangler secret 名（全小写、点换下划线）。"""
    return domain.strip().lower().replace(".", "_") + "_CLOUDFLARE_API_TOKEN"


def parse_pairs(raw: str) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    if not raw or not raw.strip():
        return pairs
    # 允许单个 token 冒号在值里不太可能，按首个 ':' 切割
    for item in raw.split(","):
        item = item.strip()
        if not item or ":" not in item:
            continue
        domain, token = item.split(":", 1)
        domain = domain.strip().lower()
        token = token.strip()
        if domain and token:
            pairs.append((domain, token))
    return pairs


def parse_domains(raw: str) -> list[str]:
    if not raw or not raw.strip():
        return []
    try:
        v = json.loads(raw)
    except Exception:
        # 容错：逗号分隔
        return [d.strip().lower() for d in raw.split(",") if d.strip()]
    if isinstance(v, list):
        return [str(d).strip().lower() for d in v if str(d).strip()]
    if isinstance(v, str):
        return [v.strip().lower()]
    return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("raw", help="CLOUDFLARE_DOMAINS_API_TOKEN 原值")
    ap.add_argument("--domains", default="", help="DOMAINS JSON 数组（可选，用于一致性校验）")
    args = ap.parse_args()

    pairs = parse_pairs(args.raw)
    # 去重：相同域名取首个
    seen: dict[str, str] = {}
    for d, t in pairs:
        seen.setdefault(d, t)

    secret_map: dict[str, str] = {}
    for d, t in seen.items():
        secret_map[secret_name_for(d)] = t

    # 一致性警告
    domains = parse_domains(args.domains)
    missing = [d for d in domains if d not in seen]
    if missing:
        print(f"[warn] DOMAINS 中以下根域名未在 CLOUDFLARE_DOMAINS_API_TOKEN 中配置："
              f"{', '.join(missing)}", file=sys.stderr)
    extra = [d for d in seen if d not in domains and domains]
    if extra:
        print(f"[warn] CLOUDFLARE_DOMAINS_API_TOKEN 含 DOMAINS 未列出的域名："
              f"{', '.join(extra)}（仍会注入）", file=sys.stderr)

    # stdout: line 1 名单，line 2 JSON
    print(",".join(sorted(secret_map.keys())))
    print(json.dumps(secret_map, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
