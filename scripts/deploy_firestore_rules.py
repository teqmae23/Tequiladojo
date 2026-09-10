#!/usr/bin/env python3
"""Firestore セキュリティルールを Firebase Rules REST API 経由でデプロイする。

`firebase deploy --only firestore:rules` は実行前に serviceusage.googleapis.com へ
「firestore.googleapis.com が有効か」を問い合わせる（ensureApiEnabled）。CI のサービス
アカウントは serviceusage.services.get 権限を持たないため、この事前チェックで 403 と
なり、ルール本体のデプロイまで到達せず失敗していた（会員パーミッションエラーの真因）。

Rules REST API（firebaserules.googleapis.com）には serviceusage の事前チェックが無い
ため、アクセストークンさえあればルールを確実に反映できる。

必要な環境変数:
  GOOGLE_OAUTH_ACCESS_TOKEN  google-github-actions/auth が発行するアクセストークン
  FIREBASE_PROJECT           プロジェクトID（省略時 tequiladojo）
"""
import json
import os
import sys
import urllib.error
import urllib.request

PROJECT = os.environ.get("FIREBASE_PROJECT", "tequiladojo")
TOKEN = os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN", "")
RULES_FILE = os.environ.get("RULES_FILE", "firestore.rules")
RELEASE = os.environ.get("RULES_RELEASE", "cloud.firestore")
BASE = "https://firebaserules.googleapis.com/v1"


def api(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        sys.stderr.write("HTTP {} {} {}\n{}\n".format(e.code, method, url, detail))
        raise


def find_release(prefix, prefer=None):
    """既存リリースのうち、リリースID（releases/以降）が prefix で始まるものを探す。
    prefer（既定のリリースID）が実在すればそれを優先。Storageルールのリリース名は
    バケット名を含む（例 firebase.storage/<bucket>）ため、バケット名を推測せず
    実在のリリースへ確実に反映するのに使う。"""
    try:
        resp = api("GET", "/projects/{}/releases?pageSize=300".format(PROJECT))
    except urllib.error.HTTPError:
        return None
    matches = []
    for r in (resp.get("releases") or []):
        name = r.get("name", "")
        rel_id = name.split("/releases/", 1)[-1] if "/releases/" in name else ""
        if rel_id.startswith(prefix):
            matches.append(rel_id)
    if prefer and prefer in matches:
        return prefer
    return matches[0] if matches else None


def main():
    if not TOKEN:
        sys.stderr.write("GOOGLE_OAUTH_ACCESS_TOKEN が未設定です\n")
        return 1

    with open(RULES_FILE, "r", encoding="utf-8") as f:
        source = f.read()

    # リリースIDの決定（Storage等はバケット名を含むため、プレフィックスから実在リリースを検出）
    release_id = RELEASE
    prefix = os.environ.get("RELEASE_DISCOVER_PREFIX", "")
    if prefix:
        found = find_release(prefix, RELEASE)
        if found:
            release_id = found
            print("既存リリースを検出: " + release_id)
        else:
            print("プレフィックス一致リリースが無いため既定を使用: " + release_id)

    # 1) ルールセットを作成
    ruleset = api(
        "POST",
        "/projects/{}/rulesets".format(PROJECT),
        {"source": {"files": [{"name": RULES_FILE, "content": source}]}},
    )
    ruleset_name = ruleset["name"]  # projects/<id>/rulesets/<uuid>
    print("作成したルールセット: " + ruleset_name)

    # 2) リリースを更新して新しいルールセットを本番へ反映
    release_path = "/projects/{}/releases/{}".format(PROJECT, release_id)
    body = {
        "release": {
            "name": "projects/{}/releases/{}".format(PROJECT, release_id),
            "rulesetName": ruleset_name,
        }
    }
    try:
        api("PATCH", release_path, body)
        print("リリースを更新しました: " + release_id)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            # リリースが存在しない場合は新規作成
            api("POST", "/projects/{}/releases".format(PROJECT), body["release"])
            print("リリースを新規作成しました: " + release_id)
        else:
            raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
