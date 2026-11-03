"""极简 Chrome DevTools Protocol 客户端（只用标准库）。

没有 node、没有 websockets 包的机器上，用它驱动 headless Edge：
真实地填表、点按钮、读 DOM、截图 —— 也就是真跑一遍端到端测试。

    python tools/cdp.py eval "document.title"
    python tools/cdp.py shot shots/x.png
    python tools/cdp.py script tools/e2e.py     # 脚本里定义 run(page)
"""

import base64
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
DEBUG_PORT = 9333
PROFILE = os.path.join(tempfile.gettempdir(), "mihsia-cdp-profile")


class WS:
    """够用的 RFC6455 客户端：文本帧 + ping/pong + 分片。"""

    def __init__(self, url, timeout=30):
        assert url.startswith("ws://"), url
        rest = url[5:]
        hostport, _, path = rest.partition("/")
        path = "/" + path
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=timeout)
        self.sock.settimeout(timeout)

        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {hostport}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())

        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("websocket 握手中断")
            buf += chunk
        head, _, self._buf = buf.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n")[0]:
            raise RuntimeError("websocket 握手失败: " + head.decode("latin-1", "replace"))

    # ── 收 ────────────────────────────────────────────────────────
    def _read(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("连接已关闭")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def recv(self):
        """返回一条完整文本消息。"""
        parts = []
        while True:
            b0, b1 = self._read(2)
            fin = b0 & 0x80
            opcode = b0 & 0x0F
            masked = b1 & 0x80
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
            mask = self._read(4) if masked else None
            payload = self._read(length) if length else b""
            if mask:
                payload = bytes(c ^ mask[i & 3] for i, c in enumerate(payload))

            if opcode == 0x9:  # ping
                self._send_frame(payload, 0xA)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x8:
                raise ConnectionError("服务端关闭了 websocket")
            parts.append(payload)
            if fin:
                return b"".join(parts).decode("utf-8", "replace")

    # ── 发 ────────────────────────────────────────────────────────
    def _send_frame(self, payload, opcode):
        mask = os.urandom(4)
        masked = bytes(c ^ mask[i & 3] for i, c in enumerate(payload))
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        self.sock.sendall(header + mask + masked)

    def send(self, text):
        self._send_frame(text.encode(), 0x1)

    def close(self):
        try:
            self._send_frame(b"", 0x8)
            self.sock.close()
        except OSError:
            pass


class Page:
    def __init__(self, ws):
        self.ws = ws
        self._id = 0

    def call(self, method, **params):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") != mid:
                continue
            if "error" in msg:
                raise RuntimeError(f"{method}: {msg['error']}")
            return msg.get("result", {})

    def js(self, expression, await_promise=True):
        r = self.call(
            "Runtime.evaluate",
            expression=expression,
            returnByValue=True,
            awaitPromise=await_promise,
            userGesture=True,
        )
        if r.get("exceptionDetails"):
            det = r["exceptionDetails"]
            text = det.get("exception", {}).get("description") or det.get("text")
            raise RuntimeError("页面脚本报错: " + str(text))
        return r.get("result", {}).get("value")

    def goto(self, url, settle=1.2):
        self.call("Page.navigate", url=url)
        time.sleep(settle)
        self.wait_load()

    def wait_load(self, timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            if self.js("document.readyState", await_promise=False) == "complete":
                return
            time.sleep(0.15)
        raise TimeoutError("页面加载超时")

    def resize(self, width=1440, height=900, scale=1):
        self.call(
            "Emulation.setDeviceMetricsOverride",
            width=width, height=height, deviceScaleFactor=scale, mobile=False,
        )

    def shot(self, path, full=False):
        params = {"format": "png", "captureBeyondViewport": bool(full)}
        if full:
            params["fromSurface"] = True
        data = self.call("Page.captureScreenshot", **params)["data"]
        raw = base64.b64decode(data)
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "wb") as f:
            f.write(raw)
        return len(raw)


def _browser():
    """确保有一个开着调试端口的 headless Edge，返回 (proc_or_None, base)。"""
    base = f"http://127.0.0.1:{DEBUG_PORT}"

    def alive():
        try:
            with urllib.request.urlopen(base + "/json/version", timeout=1.5) as r:
                return r.status == 200
        except Exception:
            return False

    if alive():
        return None, base

    os.makedirs(PROFILE, exist_ok=True)
    proc = subprocess.Popen(
        [
            EDGE,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-background-networking",
            "--autoplay-policy=no-user-gesture-required",
            f"--remote-debugging-port={DEBUG_PORT}",
            f"--user-data-dir={PROFILE}",
            "--window-size=1440,900",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    end = time.time() + 25
    while time.time() < end:
        if alive():
            return proc, base
        if proc.poll() is not None:
            raise RuntimeError("Edge 没能启动（可能被占用）")
        time.sleep(0.25)
    raise TimeoutError("等不到 Edge 的调试端口")


def _target(base):
    """永远新开一个标签页 —— 复用旧标签会撞上已经失效的会话。"""
    req = urllib.request.Request(base + "/json/new?about:blank", method="PUT")
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def _close_target(base, target_id):
    try:
        with urllib.request.urlopen(base + "/json/close/" + target_id, timeout=3) as r:
            r.read()
    except Exception:
        pass


class session:
    """with session() as page: ..."""

    def __init__(self, width=1440, height=900):
        self.width, self.height = width, height

    def __enter__(self):
        self.proc, base = _browser()
        self.base = base
        t = _target(base)
        self.target_id = t["id"]
        self.ws = WS(t["webSocketDebuggerUrl"])
        page = Page(self.ws)
        page.call("Page.enable")
        page.call("Runtime.enable")
        page.resize(self.width, self.height)
        # 让页面拿到焦点，否则 navigator.clipboard.readText 会抛 Document is not focused
        try:
            page.call("Emulation.setFocusEmulationEnabled", enabled=True)
        except Exception:
            try:
                page.call("Page.bringToFront")
            except Exception:
                pass
        return page

    def __exit__(self, *exc):
        try:
            self.ws.close()
        except Exception:
            pass
        _close_target(self.base, self.target_id)
        return False


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd = argv[1]

    if cmd == "eval":
        with session() as page:
            page.goto(argv[3] if len(argv) > 3 else "about:blank")
            print(json.dumps(page.js(argv[2]), ensure_ascii=False, indent=2))
        return 0

    if cmd == "shot":
        url = argv[3] if len(argv) > 3 else "about:blank"
        with session() as page:
            page.goto(url, settle=1.5)
            print(page.shot(argv[2]), "bytes →", argv[2])
        return 0

    if cmd == "script":
        path = argv[2]
        ns = {"__name__": "cdp_script", "__file__": path}
        with open(path, "r", encoding="utf-8") as f:
            code = compile(f.read(), path, "exec")
        exec(code, ns)
        with session() as page:
            ns["run"](page)
        return 0

    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
