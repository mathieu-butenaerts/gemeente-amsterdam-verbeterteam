"""Check that the vendored libraries are exactly the pinned, traceable files.

Always:
  1. Every file in docs/vendor/manifest.json matches its pinned SHA-256.
  2. Every <script src="vendor/..."> in docs/index.html has an SRI hash that
     matches the file, so the browser refuses a changed file.

With --source: download each package from the npm registry, verify the
tarball against the registry's integrity hash, and check that the vendored
file is byte-for-byte the file in that package.

With --osv: ask the OSV vulnerability database (which includes GitHub
advisories and CVEs) about each pinned package version. Any hit fails.

Run from the repository root: python tests/check_vendor.py [--source] [--osv]
"""

import argparse
import base64
import hashlib
import io
import json
import re
import sys
import tarfile
import urllib.request
from pathlib import Path

DOCS = Path("docs")
VENDOR = DOCS / "vendor"


def get(url: str, data: bytes | None = None) -> bytes:
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read()


def check_hashes(manifest: list[dict]) -> list[str]:
    errors = []
    for item in manifest:
        actual = hashlib.sha256((VENDOR / item["file"]).read_bytes()).hexdigest()
        if actual != item["sha256"]:
            errors.append(f"{item['file']}: SHA-256 {actual} does not match pinned {item['sha256']}")
        else:
            print(f"ok  {item['file']} = {item['package']}@{item['version']} sha256 {actual}")
    return errors


def check_sri(manifest: list[dict]) -> list[str]:
    errors = []
    html = (DOCS / "index.html").read_text(encoding="utf-8")
    scripts = {}
    for tag in re.findall(r"<script\b[^>]*>", html):
        src = re.search(r'src="vendor/([^"]+)"', tag)
        if src:
            sri = re.search(r'integrity="sha384-([^"]+)"', tag)
            scripts[src.group(1)] = sri.group(1) if sri else None
    for item in manifest:
        actual = base64.b64encode(hashlib.sha384((VENDOR / item["file"]).read_bytes()).digest()).decode()
        if item["file"] not in scripts:
            errors.append(f"{item['file']}: not loaded by index.html")
        elif scripts[item["file"]] is None:
            errors.append(f"{item['file']}: no integrity attribute in index.html")
        elif scripts[item["file"]] != actual:
            errors.append(f"{item['file']}: SRI in index.html does not match the file (should be sha384-{actual})")
        else:
            print(f"ok  {item['file']} SRI sha384-{actual}")
    return errors


def check_source(manifest: list[dict]) -> list[str]:
    errors = []
    tarballs: dict[str, tarfile.TarFile] = {}
    for item in manifest:
        key = f"{item['package']}@{item['version']}"
        if key not in tarballs:
            meta = json.loads(get(f"https://registry.npmjs.org/{item['package']}/{item['version']}"))
            if meta["dist"]["tarball"] != item["source"]:
                errors.append(f"{key}: registry tarball {meta['dist']['tarball']} differs from manifest")
                continue
            algo, expected = meta["dist"]["integrity"].split("-", 1)
            tgz = get(meta["dist"]["tarball"])
            if base64.b64encode(hashlib.new(algo, tgz).digest()).decode() != expected:
                errors.append(f"{key}: downloaded tarball fails the registry's {algo} integrity check")
                continue
            print(f"ok  {key} tarball matches registry {algo} integrity")
            tarballs[key] = tarfile.open(fileobj=io.BytesIO(tgz))
        member = tarballs[key].extractfile(f"package/{item['path_in_package']}")
        if member is None or member.read() != (VENDOR / item["file"]).read_bytes():
            errors.append(f"{item['file']}: not identical to {item['path_in_package']} in {key}")
        else:
            print(f"ok  {item['file']} is identical to {item['path_in_package']} in {key}")
    return errors


def check_osv(manifest: list[dict]) -> list[str]:
    errors = []
    for pkg, version in sorted({(i["package"], i["version"]) for i in manifest}):
        query = json.dumps({"version": version, "package": {"name": pkg, "ecosystem": "npm"}}).encode()
        vulns = json.loads(get("https://api.osv.dev/v1/query", query)).get("vulns", [])
        if vulns:
            for v in vulns:
                errors.append(f"{pkg}@{version}: {v['id']} {v.get('aliases', [])} {v.get('summary', '')}")
        else:
            print(f"ok  {pkg}@{version}: no known vulnerabilities in OSV")
    return errors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", action="store_true", help="compare against the official npm packages")
    ap.add_argument("--osv", action="store_true", help="look up known vulnerabilities in OSV")
    args = ap.parse_args()

    manifest = json.loads((VENDOR / "manifest.json").read_text(encoding="utf-8"))
    errors = check_hashes(manifest) + check_sri(manifest)
    if args.source:
        errors += check_source(manifest)
    if args.osv:
        errors += check_osv(manifest)
    for e in errors:
        print(f"ERROR {e}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
