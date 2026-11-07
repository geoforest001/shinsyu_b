#!/usr/bin/env python3
"""OpenStreetMap の道路データから、ブラウザで経路探索するための軽量グラフを作る。

使い方:
    python3 tools/build_route_graph.py                       # 諏訪湖周辺を Overpass API から取得して作成
    python3 tools/build_route_graph.py --area ina            # 伊那IC周辺で作成
    python3 tools/build_route_graph.py --input ways.json     # 取得済みの Overpass JSON から作成

出力: data/route/<area>_graph.json（AREAS を参照）

出力形式（GeoJSON より小さくするための独自形式）:
    origin : [経度, 緯度]  座標の基準点
    scale  : 座標の量子化係数（1e5 = 約1m単位の整数）
    nodes  : 交差点・道の端点の座標。[dx0, dy0, dx1, dy1, ...] を前の点との差分で並べた整数列
    edges  : 交差点間の道。1本ごとに [a, b, cls, flags, 長さm, 中間点数k, (dx, dy)*k] を連結した整数列
             中間点は始点 a からの差分を順に並べたもの
    cls    : CLASSES の添字（道の種別）
    flags  : 1=車で通行可, 2=徒歩で通行可, 4=車は a→b の一方通行, 8=車は b→a の一方通行
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

# 対象範囲: 名前と (南, 西, 北, 東)
AREAS = {
    'suwa': ('諏訪湖周辺', (35.93, 137.95, 36.17, 138.27)),
    'ina': ('伊那IC周辺', (35.75, 137.80, 35.95, 138.10)),
}
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'data', 'route')
SCALE = 1e5
SIMPLIFY_M = 4.0  # 中間点の間引き許容誤差（m）

# 道の種別: (OSM highway 値, 名前, 車の速度 km/h（None=車不可）, 徒歩の速度 km/h（None=徒歩不可）)
CLASSES = [
    (('motorway', 'motorway_link'), '高速道路', 80, None),
    (('trunk', 'trunk_link'), '国道（主要）', 50, 4.0),
    (('primary', 'primary_link'), '主要地方道', 45, 4.0),
    (('secondary', 'secondary_link'), '県道', 40, 4.0),
    (('tertiary', 'tertiary_link'), '市町村道（幹線）', 35, 4.0),
    (('unclassified', 'residential', 'living_street'), '一般道', 25, 4.0),
    (('service',), '施設内道路など', 15, 4.0),
    (('track',), '林道・農道', 12, 3.5),
    (('path', 'bridleway'), '登山道・小道', None, 2.5),
    (('footway',), '歩道', None, 4.0),
    (('steps',), '階段', None, 1.5),
]
HW2CLS = {hw: i for i, c in enumerate(CLASSES) for hw in c[0]}
SKIP_SERVICE = {'driveway', 'parking_aisle', 'drive-through'}
SKIP_FOOTWAY = {'sidewalk', 'crossing'}
NO = {'no', 'private'}


def fetch(bbox):
    s, w, n, e = bbox
    hw = '|'.join(HW2CLS)
    q = f'[out:json][timeout:120];way({s},{w},{n},{e})[highway~"^({hw})$"];out geom tags;'
    data = urllib.parse.urlencode({'data': q}).encode()
    wait = 15
    for _ in range(5):
        req = urllib.request.Request('https://overpass-api.de/api/interpreter', data=data,
                                     headers={'User-Agent': 'shiny_b-route-graph-builder'})
        try:
            with urllib.request.urlopen(req, timeout=200) as r:
                return json.load(r)
        except Exception as ex:  # 混雑時は待って再試行
            print(f'Overpass 失敗: {ex}。{wait}秒後に再試行', file=sys.stderr)
            time.sleep(wait)
            wait *= 2
    sys.exit('Overpass API から取得できませんでした')


def dist(a, b):
    """2点 (lon, lat) 間の距離 m（平面近似）。"""
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320


def simplify(pts, tol):
    """Douglas-Peucker 法で中間点を間引く（端点は残す）。"""
    if len(pts) < 3:
        return pts
    k = math.cos(math.radians(pts[0][1])) * 111320
    def d(p, a, b):
        ax, ay, bx, by, px, py = a[0] * k, a[1] * 111320, b[0] * k, b[1] * 111320, p[0] * k, p[1] * 111320
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        t = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
        return math.hypot(px - ax - t * dx, py - ay - t * dy)
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best, bi = 0, -1
        for m in range(i + 1, j):
            v = d(pts[m], pts[i], pts[j])
            if v > best:
                best, bi = v, m
        if best > tol:
            keep[bi] = True
            stack += [(i, bi), (bi, j)]
    return [p for p, kp in zip(pts, keep) if kp]


def access(tags, cls):
    car = CLASSES[cls][2] is not None
    foot = CLASSES[cls][3] is not None
    if tags.get('access') in NO:
        car = foot = False
    if tags.get('motor_vehicle') in NO or tags.get('motorcar') in NO:
        car = False
    if tags.get('motor_vehicle') == 'yes' or tags.get('motorcar') == 'yes':
        car = car or cls == HW2CLS['track']
    if tags.get('foot') in NO or tags.get('motorroad') == 'yes':
        foot = False
    elif tags.get('foot') in ('yes', 'designated'):
        foot = True
    return car, foot


def build(osm):
    ways = []
    for w in osm['elements']:
        t = w.get('tags', {})
        cls = HW2CLS.get(t.get('highway'))
        if cls is None or t.get('area') == 'yes':
            continue
        if t.get('service') in SKIP_SERVICE or t.get('footway') in SKIP_FOOTWAY:
            continue
        car, foot = access(t, cls)
        if not (car or foot):
            continue
        pts = [(round(g['lon'], 7), round(g['lat'], 7)) for g in w['geometry']]
        if len(pts) < 2:
            continue
        ow = t.get('oneway')
        one = 1 if ow in ('yes', 'true', '1') or t.get('junction') == 'roundabout' else -1 if ow == '-1' else 0
        ways.append((pts, cls, car, foot, one))

    # 交差点（2本以上の道が共有する点）と端点をグラフのノードにする
    use = {}
    for pts, *_ in ways:
        for p in pts:
            use[p] = use.get(p, 0) + 1
        use[pts[0]] += 1
        use[pts[-1]] += 1
    nid = {}
    edges = []
    for pts, cls, car, foot, one in ways:
        seg = [pts[0]]
        for i in range(1, len(pts)):
            p = pts[i]
            seg.append(p)
            if use[p] >= 2 or i == len(pts) - 1:
                a, b = seg[0], seg[-1]
                if a != b or len(seg) > 2:
                    for q in (a, b):
                        nid.setdefault(q, len(nid))
                    L = sum(dist(seg[i], seg[i + 1]) for i in range(len(seg) - 1))
                    fl = (1 if car else 0) | (2 if foot else 0) | (4 if car and one == 1 else 0) | (8 if car and one == -1 else 0)
                    edges.append([nid[a], nid[b], cls, fl, max(1, round(L)), simplify(seg, SIMPLIFY_M)[1:-1]])
                seg = [p]

    # 最大の連結成分だけ残す（孤立した断片に吸着して経路が出ない事態を防ぐ）
    parent = list(range(len(nid)))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for e in edges:
        parent[find(e[0])] = find(e[1])
    size = {}
    for i in range(len(nid)):
        r = find(i)
        size[r] = size.get(r, 0) + 1
    big = max(size, key=size.get)
    coords = sorted(nid, key=nid.get)
    keep = [i for i in range(len(coords)) if find(i) == big]
    remap = {old: new for new, old in enumerate(keep)}
    edges = [e for e in edges if e[0] in remap]
    print(f'ノード {len(coords)} → {len(keep)}、道 {len(edges)} 本（最大連結成分）', file=sys.stderr)
    return [coords[i] for i in keep], [[remap[e[0]], remap[e[1]], *e[2:]] for e in edges]


def encode(nodes, edges, stamp, name, bbox):
    ox = math.floor(min(p[0] for p in nodes) * 100) / 100
    oy = math.floor(min(p[1] for p in nodes) * 100) / 100
    q = lambda p: (round((p[0] - ox) * SCALE), round((p[1] - oy) * SCALE))
    qn = [q(p) for p in nodes]
    flat_n, px, py = [], 0, 0
    for x, y in qn:
        flat_n += [x - px, y - py]
        px, py = x, y
    flat_e = []
    for a, b, cls, fl, L, mid in edges:
        flat_e += [a, b, cls, fl, L, len(mid)]
        px, py = qn[a]
        for p in mid:
            x, y = q(p)
            flat_e += [x - px, y - py]
            px, py = x, y
    return {
        'v': 1,
        'name': name,
        'bbox': [bbox[1], bbox[0], bbox[3], bbox[2]],
        'source': f'© OpenStreetMap contributors (ODbL) / {stamp}',
        'origin': [ox, oy], 'scale': SCALE,
        'classes': [[c[1], c[2], c[3]] for c in CLASSES],
        'nodes': flat_n, 'edges': flat_e,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--area', default='suwa', choices=AREAS, help='対象範囲（既定: suwa）')
    ap.add_argument('--input', help='取得済みの Overpass JSON')
    ap.add_argument('--geojson', help='比較用に同じ内容の GeoJSON も書き出す')
    args = ap.parse_args()
    name, bbox = AREAS[args.area]
    osm = json.load(open(args.input)) if args.input else fetch(bbox)
    stamp = osm.get('osm3s', {}).get('timestamp_osm_base', '')[:10]
    nodes, edges = build(osm)
    out = os.path.normpath(os.path.join(OUT_DIR, f'{args.area}_graph.json'))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w') as f:
        json.dump(encode(nodes, edges, stamp, name, bbox), f, separators=(',', ':'), ensure_ascii=False)
    print(f'{out}: {os.path.getsize(out) / 1e6:.2f} MB', file=sys.stderr)
    if args.geojson:
        fc = {'type': 'FeatureCollection', 'features': [
            {'type': 'Feature', 'properties': {'cls': c, 'flags': fl, 'len': L},
             'geometry': {'type': 'LineString', 'coordinates': [nodes[a], *mid, nodes[b]]}}
            for a, b, c, fl, L, mid in edges]}
        with open(args.geojson, 'w') as f:
            json.dump(fc, f, separators=(',', ':'))
        print(f'{args.geojson}: {os.path.getsize(args.geojson) / 1e6:.2f} MB', file=sys.stderr)


if __name__ == '__main__':
    main()
