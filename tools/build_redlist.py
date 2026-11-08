#!/usr/bin/env python3
"""環境省・長野県レッドリストの掲載種を GBIF の出現記録と学名で突き合わせ、5kmメッシュに集計する。

入力（公式サイトからダウンロードしたもの。リポジトリには含めない）:
  環境省 第5次レッドリスト 植物・菌類(2025)、鳥類・爬虫類・両生類(2026) の PDF
  環境省 レッドリスト2020 別添資料3 (哺乳類・汽水淡水魚・昆虫・貝・その他無脊椎) の PDF
  長野県版レッドリスト 植物編2014・動物編2015 の xlsx
使い方:  python3 tools/build_redlist.py <ダウンロードdir> [出力data dir]
  <dir>/env/*.pdf, <dir>/nag/*.xlsx （pdftotext と openpyxl が必要）
出力: data/rare_env.json, rare_nag.json, rare_both.json
  {メッシュid: [[学名, 和名, 記録数, 区分, 分類群], ...]}  区分: I(絶滅危惧Ⅰ類)/VU/NT/DD  分類群: a動物 p植物 f菌類
注意: 亜種・変種は GBIF では種に統合されることが多く、取り違えを避けるため対象外にしている。
"""
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'data')
S = 0.05
UA = {'User-Agent': 'shinsyu_b-redlist-builder'}
LAT = re.compile(r'^[A-Z][a-z]+ [a-z][a-z\-]+')


def get(url, tries=8):
    err = ''
    for t in range(tries):
        try:
            time.sleep(0.12)
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60))
        except Exception as e:
            err = str(e); time.sleep(4 * (t + 1) if '429' in err else 1.5 * (t + 1))
    raise SystemExit('fail ' + url[:100] + ' ' + err)


# ---------- 環境省 ----------
ENV_CAT = [('EX', None), ('EW', None), ('ⅠA', 'I'), ('IA', 'I'), ('ⅠB', 'I'), ('IB', 'I'), ('I類', 'I'), ('Ⅰ類', 'I'),
           ('Ⅱ類', 'VU'), ('II類', 'VU'), ('VU', 'VU'), ('NT', 'NT'), ('DD', 'DD'), ('地域個体群', None), ('LP', None)]


def env_cat(s):
    s = s.replace('Ａ', 'A').replace('Ｂ', 'B')
    for k, v in ENV_CAT:
        if k in s: return v
    return None


def parse_env():
    out = []
    # 第5次（植物・菌類・鳥類・爬虫両生類）: 行頭に 掲載No. カテゴリー 和名 学名
    grp = {'vascularplant': 'p', 'bryophytes': 'p', 'algae': 'p', 'lichens': 'f', 'fungi': 'f', 'birds': 'a', 'reptiles_amphibians': 'a'}
    for fn in sorted(os.listdir(os.path.join(SRC, 'env'))):
        if not fn.endswith('.pdf') or fn.startswith('113628'): continue
        g = next(v for k, v in grp.items() if k in fn)
        txt = subprocess.run(['pdftotext', '-layout', os.path.join(SRC, 'env', fn), '-'], capture_output=True, text=True).stdout
        for ln in txt.splitlines():
            m = re.match(r'^\s*([A-Z]{2}\d{4})\s+(\S+)\s+(\S+)\s+([A-Z].+?)\s*$', ln)
            if m and env_cat(m.group(2)): out.append((m.group(4), m.group(3), env_cat(m.group(2)), g, '環境省' + ('2025' if g != 'a' or 'birds' not in fn else '2026')))
    # 2020（哺乳類ほか）
    txt = subprocess.run(['pdftotext', '-layout', os.path.join(SRC, 'env', '113628.pdf'), '-'], capture_output=True, text=True).stdout
    taxon = cat = None
    use = {'哺乳類', '汽水・淡水魚類', '昆虫類', '貝類', 'その他無脊椎動物'}
    for ln in txt.splitlines():
        m = re.match(r'^\s*【(.+?)】\s*$', ln)
        if m: taxon = m.group(1); continue
        if ln.lstrip().startswith('●'): cat = env_cat(ln); continue
        if taxon not in use or not cat: continue
        m = re.match(r'^\s*(?:\S+目\s+)?(\S.*?)\s{2,}([A-Z][A-Za-z\.\-\(\) ×]+?)\s*$', ln)
        if m: out.append((m.group(2), m.group(1).strip().split()[-1], cat, 'a', '環境省2020'))
    return out


# ---------- 長野県 ----------
def parse_nag():
    import openpyxl
    out = []
    grpf = {'ikansoku': 'p', 'sentairui': 'p', 'souruilist': 'p', 'tiirui': 'f', 'kinrui': 'f', 'sekitsui': 'a', 'musekitsui': 'a'}
    for fn in sorted(os.listdir(os.path.join(SRC, 'nag'))):
        if not fn.endswith('.xlsx'): continue
        g = next(v for k, v in grpf.items() if k in fn)
        ws = openpyxl.load_workbook(os.path.join(SRC, 'nag', fn), read_only=True).worksheets[0]
        cat = None
        for r in ws.iter_rows(values_only=True):
            cells = [str(x).strip() for x in r if x is not None and str(x).strip()]
            a = str(r[0]).replace('\n', '').strip() if r[0] is not None else ''
            head = ' '.join(cells)
            if '●' in head:
                h = head.replace('Ⅰ', 'I').replace('Ⅱ', 'II')
                if '付属' in h or '留意' in h or '地域個体群' in h: cat = None
                elif 'CR+EN+VU' in h: cat = 'VU'
                elif '絶滅危惧' in h and ('II類' in h or '(VU)' in h): cat = 'VU'
                elif '絶滅危惧' in h: cat = 'I'
                elif '準絶滅' in h: cat = 'NT'
                elif '情報不足' in h: cat = 'DD'
                else: cat = None
                continue
            if not cat: continue
            for i, c in enumerate(cells):
                if LAT.match(c) or re.match(r'^[A-Z][a-z]+ ', c):
                    if i and not re.fullmatch(r'[\d○◆◇■↓K-Z\d]+', cells[i - 1]):
                        ja = re.split(r'[\n（(]', cells[i - 1])[0].strip()
                        out.append((c.replace('\n', ' '), ja, cat, g, '長野県' + ('2014' if g != 'a' else '2015')))
                    break
    return out


def clean(sci):
    """学名から著者名を除く。亜種・変種などは None（対象外）"""
    sci = re.sub(r'\s+', ' ', sci.replace('×', ' ')).strip()
    w = sci.split(' ')
    if len(w) < 2 or not re.fullmatch(r'[a-z][a-z\-]+', w[1]): return None
    if re.search(r'\s(var|subsp|ssp|forma|f|cv)\.\s', sci + ' ') or (len(w) > 2 and re.fullmatch(r'[a-z][a-z\-]{3,}', w[2])):
        return None  # 亜種・変種など
    return w[0] + ' ' + w[1]


def main():
    cache_p = os.path.join(SRC, 'match_cache.json')
    cache = json.load(open(cache_p)) if os.path.exists(cache_p) else {}
    lists = {'env': parse_env(), 'nag': parse_nag()}
    for k, v in lists.items(): print(k, '掲載行', len(v), flush=True)
    # 学名 → GBIF speciesKey
    names = sorted({clean(s) for v in lists.values() for s, *_ in v if clean(s)})
    print('学名（種）', len(names), '/ 亜種・変種などで対象外', sum(1 for v in lists.values() for s, *_ in v if not clean(s)), flush=True)

    def match(n):
        if n in cache: return n, cache[n]
        d = get('https://api.gbif.org/v1/species/match?' + urllib.parse.urlencode({'name': n}))
        cache[n] = [d.get('speciesKey') or 0, d.get('rank'), d.get('matchType'), d.get('status'), d.get('canonicalName'), d.get('kingdom')]
        return n, cache[n]
    with ThreadPoolExecutor(4) as ex: list(ex.map(match, names))
    json.dump(cache, open(cache_p, 'w'))

    # 取り違え防止: 学名が完全一致し、GBIFでも「受理名の種」である場合だけ採用する。
    # シノニム（別名）は、GBIFが別種に統合している場合（例: 亜種扱い）に、その種の全記録を拾ってしまうため対象外
    def good(n):
        k, rank, mt, st, cn, kg = cache[n]
        return bool(k) and rank == 'SPECIES' and mt == 'EXACT' and st == 'ACCEPTED' and cn == n and kg in ('Animalia', 'Plantae', 'Fungi', 'Chromista', 'Protozoa')
    cache = {n: (cache[n][0] if good(n) else 0) for n in names}
    print('GBIFと一致', sum(1 for n in names if cache[n]), '/', len(names), flush=True)

    # 種キー → 掲載情報
    info = {'env': {}, 'nag': {}}
    for src, rows in lists.items():
        sev = {'I': 0, 'VU': 1, 'NT': 2, 'DD': 3}
        for sci, ja, cat, g, ed in rows:
            c = clean(sci); k = cache.get(c) if c else 0
            if not k: continue
            e = info[src].get(k)
            if e is None or sev[cat] < sev[e[2]]: info[src][k] = (c, ja, cat, g, ed)
    print('対象種キー 環境省', len(info['env']), '長野県', len(info['nag']), flush=True)

    # メッシュごとに記録数を集計（出現した speciesKey を facet で取得）
    g = json.load(open(os.path.join(OUT, 'grid_nagano.geojson')))
    cells = []
    for f in g['features']:
        c = f['geometry']['coordinates'][0]
        cells.append((f"{round(c[0][1] / S)}_{round(c[0][0] / S)}", round(c[0][1] / S), round(c[0][0] / S)))
    want = set(info['env']) | set(info['nag'])

    fc_p = os.path.join(SRC, 'facets.json')
    fcache = json.load(open(fc_p)) if os.path.exists(fc_p) else {}

    def facet(a):
        cid, la, lo = a
        if cid in fcache: return cid, {int(k): v for k, v in fcache[cid].items() if int(k) in want}
        poly = f"POLYGON(({lo*S:.4f} {la*S:.4f},{(lo+1)*S:.4f} {la*S:.4f},{(lo+1)*S:.4f} {(la+1)*S:.4f},{lo*S:.4f} {(la+1)*S:.4f},{lo*S:.4f} {la*S:.4f}))"
        res, off = {}, 0
        while True:
            q = urllib.parse.urlencode({'country': 'JP', 'geometry': poly, 'hasCoordinate': 'true', 'hasGeospatialIssue': 'false', 'limit': 0,
                                        'facet': 'speciesKey', 'facetLimit': 1500, 'facetOffset': off})
            d = get('https://api.gbif.org/v1/occurrence/search?' + q)
            cs = d['facets'][0]['counts'] if d.get('facets') else []
            for x in cs: res[int(x['name'])] = x['count']
            if len(cs) < 1500: break
            off += 1500
        fcache[cid] = res
        return cid, {k: v for k, v in res.items() if k in want}
    with ThreadPoolExecutor(4) as ex: counts = dict(ex.map(facet, cells))
    json.dump(fcache, open(fc_p, 'w'))
    print('メッシュ集計完了', len(counts), flush=True)

    sevn = {'I': 0, 'VU': 1, 'NT': 2, 'DD': 3}
    out = {'env': {}, 'nag': {}, 'both': {}}
    for cid, res in counts.items():
        for src in ('env', 'nag'):
            lst = [[info[src][k][0], info[src][k][1], n, info[src][k][2], info[src][k][3]] for k, n in res.items() if k in info[src]]
            if lst: out[src][cid] = sorted(lst, key=lambda x: (sevn[x[3]], -x[2]))
        both = {}
        for k, n in res.items():
            cs = [info[s][k] for s in ('env', 'nag') if k in info[s]]
            if cs:
                b = min(cs, key=lambda e: sevn[e[2]])
                both[k] = [b[0], next((e[1] for e in cs if e[1]), ''), n, b[2], b[3]]
        if both: out['both'][cid] = sorted(both.values(), key=lambda x: (sevn[x[3]], -x[2]))
    for k, v in out.items():
        json.dump(v, open(os.path.join(OUT, f'rare_{k}.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
        sp = {x[0] for l in v.values() for x in l}
        print(k, 'メッシュ', len(v), '種', len(sp), 'KB', os.path.getsize(os.path.join(OUT, f'rare_{k}.json')) // 1024, flush=True)
    json.dump({'env': sorted({e[4] for e in info['env'].values()}), 'nag': sorted({e[4] for e in info['nag'].values()})}, open(os.path.join(SRC, 'editions.json'), 'w'), ensure_ascii=False)


if __name__ == '__main__':
    main()
