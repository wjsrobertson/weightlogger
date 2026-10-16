"""Screenshot the app at desktop and phone sizes via headless Chromium + a minimal stdlib WebSocket
CDP client (learnthai's tools/phone_shots.py, adapted; Node 18 has no WebSocket).

    python3 -u tools/phone_shots.py <out_dir> <label>   # needs the server on :8777 and snap chromium
    CHROME=~/.cache/ms-playwright/chromium-1134/chrome-linux/chrome python3 -u tools/phone_shots.py …

Seeds a throwaway profile with ~4 months of sample weigh-ins (missed days, some days twice, a goal),
then takes the main page, the chart's tooltip, the edit and goal dialogs and Settings in dark and
light, and st & lb. Prints console errors and anything wider than the viewport (sideways overflow).
"""
import base64, json, os, shutil, socket, struct, subprocess, sys, tempfile, time, urllib.request

PORT = 9334
# The app's server: python3 -m http.server 8777. Not 8766, which is the one used by hand.
URL = os.environ.get('APP_URL', 'http://localhost:8777/')
PROFILE = os.path.expanduser('~/snap/chromium/common/weightlogger-shots-profile')  # throwaway, snap-accessible
DEVICES = {'desktop': (1100, 900, False), 'iphone14': (390, 844, True), 'iphoneSE': (375, 667, True)}

# Sample data, made in the page: a slow fall with day-to-day noise, from a fixed seed.
SEED_JS = """(() => {
  let s = 7; const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const DAY = 864e5, entries = []; const start = new Date(); start.setHours(7, 20, 0, 0);
  for (let d = 120; d >= 0; d--) {
    if (d > 0 && rand() < 0.15) continue;                       // a missed day
    const at = start.getTime() - d * DAY + Math.round(rand() * 40) * 60e3;
    const kg = 84 - (120 - d) * 0.035 + (rand() - 0.5) * 1.2;
    entries.push({ id: 'seed' + d, at, kg: Math.round(kg * 10) / 10, ...(d === 30 ? { note: 'After the holiday' } : {}) });
    if (rand() < 0.08) entries.push({ id: 'seed' + d + 'pm', at: at + 13 * 36e5, kg: Math.round((kg + 0.6) * 10) / 10 });
  }
  localStorage.setItem('weightlogger:v1', JSON.stringify({ settings: { goalKg: 78 }, entries }));
  return entries.length;
})()"""


class WS:
    def __init__(self, url):
        host, path = url.split('//', 1)[1].split('/', 1)
        h, p = host.split(':')
        self.s = socket.create_connection((h, int(p)))
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f'GET /{path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                        f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        resp = b''
        while b'\r\n\r\n' not in resp:
            resp += self.s.recv(4096)
        assert b' 101 ' in resp.split(b'\r\n')[0], resp
        self.buf = resp.split(b'\r\n\r\n', 1)[1]
        self.i = 0
        self.events = []  # everything that isn't a reply, e.g. console errors

    def _read(self, n):
        while len(self.buf) < n:
            self.buf += self.s.recv(1 << 16)
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, obj):
        data = json.dumps(obj).encode()
        hdr = bytearray([0x81])
        n = len(data)
        if n < 126: hdr.append(0x80 | n)
        elif n < 1 << 16: hdr += bytes([0x80 | 126]) + struct.pack('>H', n)
        else: hdr += bytes([0x80 | 127]) + struct.pack('>Q', n)
        mask = os.urandom(4)
        self.s.sendall(bytes(hdr) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self):
        payload = b''
        while True:
            b1, b2 = self._read(2)
            n = b2 & 0x7f
            if n == 126: n = struct.unpack('>H', self._read(2))[0]
            elif n == 127: n = struct.unpack('>Q', self._read(8))[0]
            payload += self._read(n)
            if b1 & 0x80: return json.loads(payload)

    def call(self, method, **params):
        self.i += 1
        self.send({'id': self.i, 'method': method, 'params': params})
        while True:
            msg = self.recv()
            if msg.get('id') == self.i:
                if 'error' in msg: raise RuntimeError(msg['error'])
                return msg.get('result', {})
            self.events.append(msg)

    def errors(self):
        out = []
        for m in self.events:
            if m.get('method') == 'Runtime.exceptionThrown':
                d = m['params']['exceptionDetails']
                out.append(d.get('exception', {}).get('description') or d.get('text'))
            elif m.get('method') == 'Runtime.consoleAPICalled' and m['params']['type'] in ('error', 'warning'):
                out.append(' '.join(str(a.get('value', a.get('description'))) for a in m['params']['args']))
        self.events.clear()
        return out


def js(ws, expr):
    res = ws.call('Runtime.evaluate', expression=expr, awaitPromise=True, returnByValue=True)
    if 'exceptionDetails' in res:
        raise RuntimeError(res['exceptionDetails'].get('exception', {}).get('description'))
    return res.get('result', {}).get('value')


def shot(ws, path):
    data = ws.call('Page.captureScreenshot', format='png')['data']
    open(path, 'wb').write(base64.b64decode(data))


def start_browser():
    # CHROME=<path> uses another Chromium (e.g. Playwright's, where snap chromium can't start). It runs
    # without its sandbox, which needs user namespaces: fine for our own page on localhost.
    chrome = os.environ.get('CHROME')
    profile = tempfile.mkdtemp(prefix='weightlogger-shots-') if chrome else PROFILE
    shutil.rmtree(profile, ignore_errors=True)
    cmd = [chrome or 'chromium', '--headless=new', f'--remote-debugging-port={PORT}', f'--user-data-dir={profile}', '--no-first-run']
    if chrome: cmd.append('--no-sandbox')
    proc = subprocess.Popen(cmd + ['about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    proc.profile = profile
    targets = []
    for _ in range(50):
        try:
            targets = json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list'))
            break
        except Exception:
            time.sleep(0.3)
    page = next((t for t in targets if t['type'] == 'page'), None)
    if not page:
        proc.kill()
        raise SystemExit('Chromium did not start (snap chromium needs a desktop session; or set CHROME=<path>)')
    ws = WS(page['webSocketDebuggerUrl'])
    ws.call('Runtime.enable')
    return proc, ws


def stop_browser(proc):
    proc.terminate()
    proc.wait(timeout=10)
    shutil.rmtree(proc.profile, ignore_errors=True)


def load(ws, ready="document.querySelectorAll('#entries li').length > 0"):
    ws.call('Page.navigate', url=URL)
    for _ in range(50):
        time.sleep(0.2)
        try:
            if js(ws, ready): return
        except RuntimeError:
            pass
    raise SystemExit(f'app did not load (is the server running at {URL}?)')


def overflow(ws):
    return js(ws, """(() => { const W = innerWidth; return [...document.querySelectorAll('body *')]
        .filter(e => e.offsetParent && e.getBoundingClientRect().right > W + 1)
        .slice(0, 8).map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '.' + [...e.classList].join('.')
        + ' right=' + Math.round(e.getBoundingClientRect().right)); })()""")


def main():
    out, label = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    proc, ws = start_browser()
    try:
        load(ws, 'true')
        print('seeded', js(ws, SEED_JS), 'weigh-ins')
        for dev, (w, h, mobile) in DEVICES.items():
            ws.call('Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=2 if mobile else 1, mobile=mobile)
            ws.call('Emulation.setTouchEmulationEnabled', enabled=mobile)
            p = lambda name: os.path.join(out, f'{label}-{dev}-{name}.png')
            for theme in ('dark', 'light'):
                js(ws, f"(() => {{ const s = JSON.parse(localStorage.getItem('weightlogger:v1')); s.settings.theme = '{theme}'; s.settings.unit = 'kg'; localStorage.setItem('weightlogger:v1', JSON.stringify(s)); }})()")
                load(ws)
                time.sleep(0.4)
                shot(ws, p(f'0-{theme}'))
                # The tooltip on the 10th weigh-in from the end.
                js(ws, """(() => { const r = document.getElementById('chart').getBoundingClientRect();
                    const dots = document.querySelectorAll('#chart-svg circle.dot'); const d = dots[dots.length - 10].getBoundingClientRect();
                    document.getElementById('chart').dispatchEvent(new PointerEvent('pointerdown', { clientX: d.x + d.width / 2, clientY: d.y, bubbles: true }));
                    document.getElementById('chart').scrollIntoView({ block: 'center' }); })()""")
                time.sleep(0.3)
                shot(ws, p(f'1-tooltip-{theme}'))
            js(ws, "window.scrollTo(0, 0)")
            js(ws, "document.querySelector('#entries .entry').click()")
            time.sleep(0.3)
            shot(ws, p('2-edit'))
            js(ws, "document.getElementById('entry-dialog').close()")
            js(ws, "document.querySelector('.goal-tile').click()")
            time.sleep(0.3)
            shot(ws, p('2b-goal'))
            js(ws, "document.getElementById('goal-dialog').close()")
            js(ws, "document.querySelector('[data-unit=st]') && document.getElementById('settings-button').click()")
            js(ws, "document.querySelector('[data-unit=st]').click()")
            time.sleep(0.3)
            shot(ws, p('3-settings-st'))
            js(ws, "document.getElementById('settings-dialog').close()")
            time.sleep(0.2)
            shot(ws, p('4-st'))
            print(f'{dev} {w}x{h}: scrollWidth={js(ws, "document.documentElement.scrollWidth")} overflowing={overflow(ws)}')
            errs = ws.errors()
            if errs: print(f'{dev}: console errors: {errs}')
    finally:
        stop_browser(proc)


if __name__ == '__main__':
    main()
