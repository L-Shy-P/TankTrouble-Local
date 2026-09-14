# -*- coding: utf-8 -*-
"""
游戏核心本地服务器 — 含 /ajax/ JSON-RPC 本地回退
"""
import os
import sys
import json
import webbrowser
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

HOST = '127.0.0.1'
PORT = 8000

CONFIG_CATEGORIES = ('emitters', 'levels', 'map_gen')
CONFIG_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'training_configs')

_guest_counter = 0


def _ensure_config_dirs():
    for category in CONFIG_CATEGORIES:
        os.makedirs(os.path.join(CONFIG_ROOT, category), exist_ok=True)


def _safe_config_name(name):
    if not name:
        return None
    base = os.path.basename(str(name).strip())
    if not base.lower().endswith('.json'):
        base += '.json'
    safe = ''.join(ch for ch in base if ch.isalnum() or ch in '._-')
    if not safe or safe == '.json':
        return None
    return safe


def _config_category_path(category):
    if category not in CONFIG_CATEGORIES:
        return None
    return os.path.join(CONFIG_ROOT, category)


def _list_config_files(category):
    folder = _config_category_path(category)
    if not folder or not os.path.isdir(folder):
        return []
    names = []
    for entry in os.listdir(folder):
        if entry.lower().endswith('.json') and os.path.isfile(os.path.join(folder, entry)):
            names.append(entry)
    return sorted(names)


def _read_config_file(category, filename):
    folder = _config_category_path(category)
    safe = _safe_config_name(filename)
    if not folder or not safe:
        return None, 'invalid name'
    path = os.path.join(folder, safe)
    if not os.path.isfile(path):
        return None, 'not found'
    with open(path, 'r', encoding='utf-8') as fh:
        return json.load(fh), None


def _write_config_file(category, filename, payload):
    folder = _config_category_path(category)
    safe = _safe_config_name(filename)
    if not folder or not safe:
        return False, 'invalid name'
    path = os.path.join(folder, safe)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write('\n')
    return True, safe

AI_PLAYER_DETAILS = {
    '6148530': {
        'playerId': '6148530', 'username': 'Laika',
        'victories': 0, 'kills': 0, 'deaths': 0, 'suicides': 0, 'surrenders': 0, 'experience': 0,
        'turretColour': {'type': 'numeric', 'rawValue': '0x4c4c4c', 'numericValue': '0x4c4c4c', 'imageValue': ''},
        'treadColour': {'type': 'numeric', 'rawValue': '0xcccccc', 'numericValue': '0xcccccc', 'imageValue': ''},
        'baseColour': {'type': 'numeric', 'rawValue': '0x4c4c4c', 'numericValue': '0x4c4c4c', 'imageValue': ''},
        'turretAccessory': '0', 'barrelAccessory': '0', 'frontAccessory': '7', 'backAccessory': '0',
        'treadAccessory': '0', 'backgroundAccessory': '0', 'badge': '0',
        'email': None, 'lastLogin': None, 'created': None, 'realName': None, 'birthYear': None, 'country': None,
        'newsSubscriber': False, 'gmLevel': 0, 'beta': False, 'verified': True, 'banned': None,
        'usernameApproved': True, 'premium': False, 'guest': False, 'rank': 11, 'xp': 0, 'lastForumPost': 0,
    },
    '6148531': {
        'playerId': '6148531', 'username': 'Dimitri',
        'victories': 0, 'kills': 0, 'deaths': 0, 'suicides': 0, 'surrenders': 0, 'experience': 0,
        'turretColour': {'type': 'numeric', 'rawValue': '0x4c4c4c', 'numericValue': '0x4c4c4c', 'imageValue': ''},
        'treadColour': {'type': 'numeric', 'rawValue': '0xe5e5e5', 'numericValue': '0xe5e5e5', 'imageValue': ''},
        'baseColour': {'type': 'numeric', 'rawValue': '0x4c4c4c', 'numericValue': '0x4c4c4c', 'imageValue': ''},
        'turretAccessory': '0', 'barrelAccessory': '0', 'frontAccessory': '0', 'backAccessory': '0',
        'treadAccessory': '0', 'backgroundAccessory': '0', 'badge': '0',
        'email': None, 'lastLogin': None, 'created': None, 'realName': None, 'birthYear': None, 'country': None,
        'newsSubscriber': False, 'gmLevel': 0, 'beta': False, 'verified': True, 'banned': None,
        'usernameApproved': True, 'premium': False, 'guest': False, 'rank': 0, 'xp': 0, 'lastForumPost': 0,
    },
}


def _colour_hex(value):
    hex_str = format(value & 0xFFFFFF, '06x')
    s = '0x' + hex_str
    return {'type': 'numeric', 'rawValue': s, 'numericValue': s, 'imageValue': ''}


def _make_guest(player_id=None):
    global _guest_counter
    _guest_counter += 1
    pid = player_id or f'guest_{int(time.time() * 1000)}_{_guest_counter}'
    return {
        'playerId': pid,
        'username': f'Guest {_guest_counter}',
        'victories': 0, 'kills': 0, 'deaths': 0, 'suicides': 0, 'surrenders': 0, 'experience': 0,
        'turretColour': _colour_hex(0x427fff),
        'treadColour': _colour_hex(0x888888),
        'baseColour': _colour_hex(0xff9900),
        'turretAccessory': '0', 'barrelAccessory': '0', 'frontAccessory': '0', 'backAccessory': '0',
        'treadAccessory': '0', 'backgroundAccessory': '0', 'badge': '0',
        'email': None, 'lastLogin': None, 'created': None, 'realName': None, 'birthYear': None, 'country': None,
        'newsSubscriber': False, 'gmLevel': 0, 'beta': False, 'verified': False, 'banned': None,
        'usernameApproved': True, 'premium': False, 'guest': True, 'rank': 0, 'xp': 0, 'lastForumPost': 0,
    }


def _normalize_method(method):
    if method and method.startswith('tanktrouble.'):
        return method[len('tanktrouble.'):]
    return method


def _mock_rpc(method, params):
    method = _normalize_method(method)
    params = params or []

    if method == 'account.createGuests':
        n = int(params[0]) if params else 1
        ts = int(time.time() * 1000)
        details = []
        tokens = []
        for i in range(n):
            pid = f'guest_{ts}_{i}'
            details.append(_make_guest(pid))
            tokens.append(f'local_token_{pid}')
        return {'result': True, 'data': {'playerDetails': details, 'multiplayerTokens': tokens}}

    if method == 'getAIs':
        return {'result': True, 'data': [
            {
                'playerId': '6148530',
                'config': {
                    'name': 'Laika',
                    'dexterity': '0.6', 'cleverness': '0.4', 'boldness': '0.9',
                    'greediness': '0.2', 'determination': '0.6',
                    'aggressiveness': '0.9', 'vengefulness': '0.8',
                },
            },
            {
                'playerId': '6148531',
                'config': {
                    'name': 'Dimitri',
                    'dexterity': '0.5', 'cleverness': '0.7', 'boldness': '0.5',
                    'greediness': '0.4', 'determination': '0.7',
                    'aggressiveness': '0.7', 'vengefulness': '0.5',
                },
            },
        ]}

    if method == 'getPlayerDetails':
        pid = str(params[0]) if params else 'guest_0'
        if pid in AI_PLAYER_DETAILS:
            return {'result': True, 'data': AI_PLAYER_DETAILS[pid]}
        return {'result': True, 'data': _make_guest(pid)}

    if method in ('garage.getGarageContent',):
        pid = params[0] if params else 'guest_0'
        return {'result': True, 'data': {'playerId': pid, 'boxes': [{'id': 1, 'accessories': [], 'sprayCans': []}]}}

    if method in ('getFavourites', 'admin.getAdminRoles', 'achievement.getAchievements',
                  'message.getMessages', 'news.getNewsPosts'):
        return {'result': True, 'data': []}

    if method == 'getCurrency':
        return {'result': True, 'data': {'gold': 999, 'diamonds': 999}}

    if method == 'getScraps':
        return {'result': True, 'data': {'scraps': 1000, 'velocity': 0}}

    return {'result': True, 'data': {}}


class GameHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f'[{self.log_date_time_string()}] {format % args}')

    def end_headers(self):
        path = self.path.split('?', 1)[0]
        if path in ('/', '/index.html') or path.endswith('.html') or path.endswith('.js'):
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def _send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _handle_training_config_api(self, method):
        parts = self.path.split('?', 1)[0].strip('/').split('/')
        if len(parts) < 3 or parts[0] != 'api' or parts[1] != 'training-configs':
            return False
        category = parts[2]
        filename = parts[3] if len(parts) > 3 else None
        if category not in CONFIG_CATEGORIES:
            self._send_json(404, {'ok': False, 'error': 'unknown category'})
            return True

        if method == 'GET' and filename is None:
            self._send_json(200, {'ok': True, 'category': category, 'files': _list_config_files(category)})
            return True

        if method == 'GET' and filename:
            data, err = _read_config_file(category, filename)
            if err:
                self._send_json(404, {'ok': False, 'error': err})
            else:
                self._send_json(200, {'ok': True, 'category': category, 'filename': _safe_config_name(filename), 'data': data})
            return True

        if method in ('POST', 'PUT') and filename:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else b'{}'
            try:
                payload = json.loads(body.decode('utf-8'))
            except json.JSONDecodeError:
                self._send_json(400, {'ok': False, 'error': 'invalid json'})
                return True
            ok, result = _write_config_file(category, filename, payload)
            if ok:
                self._send_json(200, {'ok': True, 'category': category, 'filename': result})
            else:
                self._send_json(400, {'ok': False, 'error': result})
            return True

        self._send_json(405, {'ok': False, 'error': 'method not allowed'})
        return True

    def do_PUT(self):
        if self._handle_training_config_api('PUT'):
            return
        self.send_error(501, 'Unsupported method')

    def do_POST(self):
        if self._handle_training_config_api('POST'):
            return
        if self.path.split('?', 1)[0] == '/__agent_log':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else b'{}'
            log_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.cursor')
            os.makedirs(log_dir, exist_ok=True)
            log_path = os.path.join(log_dir, 'debug-157fbd.log')
            with open(log_path, 'a', encoding='utf-8') as fh:
                fh.write(body.decode('utf-8', errors='replace').strip() + '\n')
            self.send_response(204)
            self.end_headers()
            return
        if '/ajax/' in self.path:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else b'{}'
            try:
                req = json.loads(body.decode('utf-8'))
            except json.JSONDecodeError:
                req = {}
            method = req.get('method', '')
            params = req.get('params')
            rpc_id = req.get('id', 1)
            payload = {
                'jsonrpc': '2.0',
                'id': rpc_id,
                'result': _mock_rpc(method, params),
            }
            data = json.dumps(payload).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            print(f'[Ajax mock] {method}')
            return
        self.send_error(501, 'Unsupported method')

    def do_GET(self):
        if self._handle_training_config_api('GET'):
            return
        if self.path.startswith('/ajax/'):
            payload = json.dumps({
                'jsonrpc': '2.0', 'id': 0,
                'result': {'result': True, 'data': {}},
            }).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()


def run_server():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    _ensure_config_dirs()
    server = None
    actual_port = PORT
    # 8000 被占用时自动往后找，避免启动脚本看似正常但页面打不开。
    for port in range(PORT, PORT + 20):
        try:
            server = HTTPServer((HOST, port), GameHandler)
            actual_port = port
            break
        except OSError:
            continue
    if server is None:
        print('无法启动本地服务器：8000~8019 端口都被占用了。')
        return
    print('=' * 60)
    print('TankTrouble 游戏核心本地服务器')
    print('=' * 60)
    print(f'服务器地址: http://{HOST}:{actual_port}')
    print(f'游戏地址: http://{HOST}:{actual_port}/index.html')
    print('=' * 60)
    print('按 Ctrl+C 停止服务器')
    print('=' * 60)

    def open_browser():
        time.sleep(1.5)
        webbrowser.open(f'http://{HOST}:{actual_port}/index.html')

    threading.Thread(target=open_browser, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
        print('服务器已停止')
        server.shutdown()



if __name__ == '__main__':
    run_server()
