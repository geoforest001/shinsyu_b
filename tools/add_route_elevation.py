#!/usr/bin/env python3
"""道路グラフに「登り下りによる歩行時間の係数」を書き足す。

使い方:
    python3 tools/add_route_elevation.py                         # data/route/*_graph.json すべて
    python3 tools/add_route_elevation.py data/route/suwa_graph.json

国土地理院の標高タイル（dem_png, z14, DEM10m 相当）から道に沿って 30m ごとに標高を読み、
Tobler の歩行関数で「平地を歩く場合に比べて何倍の時間がかかるか」を道の向きごとに求める。

    歩行速度 v(S) = 6·exp(-3.5·|S + 0.05|) km/h   （S = 勾配。下りが負）
    係数 = Σ 区間長 × v(0)/v(S) ÷ Σ 区間長

出力（グラフ JSON に追加するキー）:
    tob : 道ごとに [a→b の係数×100, b→a の係数×100] を連結した整数列（edges と同じ順番）
    dem : 標高データの出典

車道（車で通れる道）は、橋やトンネルで地表の標高と道の高さがずれるため、勾配を ±20% までに抑える。
取得したタイルは tools/.dem_cache/ に保存し、2回目からはそれを使う。
"""
import glob
import json
import math
import os
import struct
import sys
import urllib.error
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor

Z = 14
URL = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png'
CACHE = os.path.join(os.path.dirname(__file__), '.dem_cache')
STEP_M = 30.0       # 標高を読む間隔
ROAD_MAX_S = 0.20   # 車道の勾配の上限（橋・トンネル対策）
PATH_MAX_S = 1.00   # 歩道・登山道の勾配の上限（45°）
FACTOR_MAX = 20.0


def tobler(s):
    return 6 * math.exp(-3.5 * abs(s + 0.05))


V0 = tobler(0)


# ---- PNG（8bit RGB）の最小デコーダ ----
def decode_png(data):
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    p, idat, w = 8, b'', 0
    while p < len(data):
        n, typ = struct.unpack('>I4s', data[p:p + 8])
        body = data[p + 8:p + 8 + n]
        if typ == b'IHDR':
            w, h, bd, ct, _, _, il = struct.unpack('>IIBBBBB', body)
            assert bd == 8 and ct == 2 and il == 0, '8bit RGB 以外の PNG には未対応'
        elif typ == b'IDAT':
            idat += body
        p += 12 + n
    raw = zlib.decompress(idat)
    bpp, stride = 3, w * 3
    out = bytearray(stride * h)
    prev = bytearray(stride)
    for r in range(h):
        f = raw[r * (stride + 1)]
        line = bytearray(raw[r * (stride + 1) + 1:(r + 1) * (stride + 1)])
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out[r * stride:(r + 1) * stride] = line
        prev = line
    # 地理院の標高PNG: x = R·2^16 + G·2^8 + B。x < 2^23 なら x·0.01 m、x > 2^23 なら (x − 2^24)·0.01 m、2^23 は欠測
    hs = []
    for i in range(0, len(out), 3):
        x = (out[i] << 16) | (out[i + 1] << 8) | out[i + 2]
        hs.append(None if x == 1 << 23 else (x if x < 1 << 23 else x - (1 << 24)) * 0.01)
    return hs


def fetch_tile(xy):
    x, y = xy
    path = os.path.join(CACHE, f'{Z}_{x}_{y}.png')
    if not os.path.exists(path):
        req = urllib.request.Request(URL.format(z=Z, x=x, y=y), headers={'User-Agent': 'shiny_b-route-elevation'})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:  # 海など、データのないタイル
                return xy, None
            raise
        with open(path, 'wb') as f:
            f.write(data)
    with open(path, 'rb') as f:
        return xy, decode_png(f.read())


def gpx(lon, lat):
    """経度緯度 → z14 の全体ピクセル座標。"""
    n = 256 * 2 ** Z
    s = math.sin(math.radians(lat))
    return (lon + 180) / 360 * n, (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n


class Dem:
    def __init__(self, bbox):
        w, s, e, n = bbox
        x0, y0 = (int(v // 256) for v in gpx(w, n))
        x1, y1 = (int(v // 256) for v in gpx(e, s))
        need = [(x, y) for x in range(x0 - 1, x1 + 2) for y in range(y0 - 1, y1 + 2)]
        os.makedirs(CACHE, exist_ok=True)
        print(f'標高タイル {len(need)} 枚を読み込み中…', file=sys.stderr)
        with ThreadPoolExecutor(6) as ex:
            self.tiles = dict(ex.map(fetch_tile, need))

    def px(self, X, Y):
        t = self.tiles.get((X >> 8, Y >> 8))
        return None if t is None else t[(Y & 255) * 256 + (X & 255)]

    def at(self, lon, lat):
        """双一次補間した標高（m）。欠測なら None。"""
        fx, fy = gpx(lon, lat)
        fx -= 0.5
        fy -= 0.5
        X, Y = math.floor(fx), math.floor(fy)
        tx, ty = fx - X, fy - Y
        v = [self.px(X, Y), self.px(X + 1, Y), self.px(X, Y + 1), self.px(X + 1, Y + 1)]
        if any(h is None for h in v):
            ok = [h for h in v if h is not None]
            return sum(ok) / len(ok) if ok else None
        return (v[0] * (1 - tx) + v[1] * tx) * (1 - ty) + (v[2] * (1 - tx) + v[3] * tx) * ty


def dist(a, b):
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320


def resample(pts):
    """折れ線を STEP_M ごとの点列にする（両端を含む）。"""
    seg = [dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    L = sum(seg)
    n = max(1, round(L / STEP_M))
    out, i, acc = [], 0, 0.0
    for k in range(n + 1):
        t = L * k / n
        while i < len(seg) - 1 and acc + seg[i] < t:
            acc += seg[i]
            i += 1
        r = 0 if seg[i] == 0 else min(1, (t - acc) / seg[i])
        a, b = pts[i], pts[i + 1]
        out.append((a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r))
    return out, L / n


def factors(pts, dem, max_s):
    q, d = resample(pts)
    if d < 1:  # ごく短い道は平地とみなす
        return 1.0, 1.0
    hs = [dem.at(*p) for p in q]
    fab = fba = 0.0
    for i in range(len(q) - 1):
        if hs[i] is None or hs[i + 1] is None:
            fab += 1
            fba += 1
            continue
        s = max(-max_s, min(max_s, (hs[i + 1] - hs[i]) / d))
        fab += V0 / tobler(s)
        fba += V0 / tobler(-s)
    n = len(q) - 1
    return min(FACTOR_MAX, fab / n), min(FACTOR_MAX, fba / n)


def process(path):
    d = json.load(open(path))
    nN = len(d['nodes']) // 2
    lon, lat, x, y = [], [], 0, 0
    for i in range(nN):
        x += d['nodes'][2 * i]
        y += d['nodes'][2 * i + 1]
        lon.append(d['origin'][0] + x / d['scale'])
        lat.append(d['origin'][1] + y / d['scale'])
    dem = Dem(d['bbox'])
    ev, tob, p, cnt = d['edges'], [], 0, 0
    while p < len(ev):
        a, b, fl, k = ev[p], ev[p + 1], ev[p + 3], ev[p + 5]
        pts = [(lon[a], lat[a])]
        cx = round((lon[a] - d['origin'][0]) * d['scale'])
        cy = round((lat[a] - d['origin'][1]) * d['scale'])
        for j in range(k):
            cx += ev[p + 6 + 2 * j]
            cy += ev[p + 7 + 2 * j]
            pts.append((d['origin'][0] + cx / d['scale'], d['origin'][1] + cy / d['scale']))
        pts.append((lon[b], lat[b]))
        if fl & 2:
            fab, fba = factors(pts, dem, ROAD_MAX_S if fl & 1 else PATH_MAX_S)
        else:  # 歩けない道（高速道路など）は使わない
            fab = fba = 1.0
        tob += [round(fab * 100), round(fba * 100)]
        p += 6 + 2 * k
        cnt += 1
    d['tob'] = tob
    d['dem'] = '標高: 国土地理院 標高タイル（dem_png）'
    with open(path, 'w') as f:
        json.dump(d, f, separators=(',', ':'), ensure_ascii=False)
    hard = sum(1 for v in tob if v >= 200)
    print(f'{path}: 道 {cnt} 本、係数2倍以上の向き {hard} / {len(tob)}、{os.path.getsize(path) / 1e6:.2f} MB', file=sys.stderr)


def main():
    paths = sys.argv[1:] or sorted(glob.glob(os.path.join(os.path.dirname(__file__), '..', 'data', 'route', '*_graph.json')))
    for p in paths:
        process(os.path.normpath(p))


if __name__ == '__main__':
    main()
