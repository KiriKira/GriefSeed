"""Real Chromium management UI smoke test against a disposable local SQLite DO."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
process = subprocess.Popen(["node", "test/browser-server.mjs"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(100):
        try:
            urllib.request.urlopen("http://localhost:8787/healthz", timeout=.2).close()
            break
        except Exception:
            time.sleep(.1)
    else:
        raise RuntimeError("test service did not start")
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        page = browser.new_page(accept_downloads=True)
        errors, urls = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: urls.append(request.url))
        page.goto("http://localhost:8787")
        page.locator("#password").fill("test-browser-password")
        page.locator("#login button").click()
        expect(page.locator("#panel")).to_be_visible()
        expect(page.locator("#node")).to_be_visible()
        name = '<img src=x onerror="alert(1)">'
        page.locator("#name").fill(name)
        page.locator("#create button").click()
        expect(page.locator("#link")).to_contain_text("gsm2sip://relay?")
        expect(page.locator("#qr img")).to_be_visible()
        expect(page.locator("#tokens")).to_contain_text(name)
        page.locator("#tokens button").click()
        expect(page.locator("#tokens")).to_contain_text("已吊销")
        page.locator("#join").click()
        expect(page.locator("#link")).to_contain_text("mahogsm://join?v=2&n=")
        with page.expect_download() as download:
            page.locator("#backup").click()
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"backup.json"
            download.value.save_as(path)
            snapshot=json.loads(path.read_text())
            assert snapshot["format"]=="griefseed-backup"
            assert all("credential" not in row for row in snapshot["tables"]["tokens"])
            page.locator("#restorefile").set_input_files(str(path))
            page.once("dialog",lambda dialog:dialog.accept())
            page.locator("#restore").click()
            expect(page.locator("#login")).to_be_visible()
        assert not errors, errors
        assert all(url.startswith(("http://localhost:8787", "data:", "blob:")) for url in urls), urls
        browser.close()
    print("Chromium: login, safe token rendering, QR, revoke, node join, backup and restore passed")
finally:
    process.terminate()
    try: process.wait(timeout=10)
    except subprocess.TimeoutExpired: process.kill();process.wait()
