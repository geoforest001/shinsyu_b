// 調査ルート案内（試作：諏訪湖周辺）
// 出発地から「車で行ける所まで車 → 駐車 → 徒歩 → 道のない区間は直線」で目的地への経路を探す。
// グラフは tools/build_route_graph.py が作る data/route/suwa_graph.json。
// 画面は左のサイドバーで出発地と目的地を決め、「案内」を押すと経路を描く。
// 徒歩の時間は登り下りを考慮する（Tobler の歩行関数）。道ごとの係数は tools/add_route_elevation.py がグラフに書き足す。
// 道のない区間は slope.js で標高・傾斜を読み、急斜面を避けるアプローチ点を選ぶ。
const Route = (() => {
  const URL_GRAPH = 'data/route/suwa_graph.json';
  const AREA = [137.95, 35.93, 138.27, 36.17];  // 西, 南, 東, 北（グラフの bbox と同じ）
  const AREA_NAME = '諏訪湖周辺';
  const PARK_SEC = 120;          // 駐車・身支度の時間（車→徒歩の乗り換えコスト）
  const OFFROAD_KMH = 1.0;       // 道のない区間（藪こぎ・沢沿い）の歩行速度の目安
  const SNAP_MAX_M = 3000;       // 出発地を道路に吸着させる最大距離
  const GOAL_SEARCH_M = 2500;    // 目的地の周りで「道の端」を探す範囲
  const CAR = 0, FOOT = 1;
  const STEEP_DEG = 30;          // 道のない区間で「急斜面」として警告する傾斜
  const OFF_STEP_M = 25;         // 道のない区間で標高を読む間隔
  // 道のない区間で、横切る斜面の傾斜に応じて時間を増やす（藪こぎ＋斜面のトラバース）
  const slopePenalty = deg => deg >= 45 ? 10 : deg >= 40 ? 4 : deg >= 35 ? 2 : deg >= STEEP_DEG ? 1.4 : 1;
  const tobler = sgrad => 6 * Math.exp(-3.5 * Math.abs(sgrad + 0.05));
  const TOB0 = tobler(0), TOB_MIN = TOB0 / 6;  // 係数の下限（最も速い下り坂）
  const COLOR = { start: '#1565c0', goal: '#c62828' };
  // 左のサイドバーに隠れないよう、地図を合わせるときの左余白を広げる
  const pad = p => { const el = document.getElementById('rt-panel'), w = el && el.offsetWidth && innerWidth > 600 ? el.offsetWidth + 10 : 0;
    return { top: p, bottom: p, right: p, left: p + w }; };
  let map, G = null, loading = null, onMsg = () => {}, onChange = () => {};
  let pickFor = null, routed = false;
  let last = null;               // 直近の経路の結果（PDFレポート用。route_report.js が読む）
  let lastRoute = null;          // 直近の経路の結果（GPX書き出し用）
  const pts = { start: null, goal: null };     // { ll, label }
  const markers = {};

  // ---- グラフの読み込みと展開 ----
  function decode(d) {
    const nN = d.nodes.length / 2, lon = new Float64Array(nN), lat = new Float64Array(nN);
    let x = 0, y = 0;
    for (let i = 0; i < nN; i++) {
      x += d.nodes[2 * i]; y += d.nodes[2 * i + 1];
      lon[i] = d.origin[0] + x / d.scale; lat[i] = d.origin[1] + y / d.scale;
    }
    const E = { a: [], b: [], cls: [], fl: [], len: [], g0: [], gn: [] }, gx = [], gy = [];
    const ev = d.edges;
    for (let p = 0; p < ev.length;) {
      const a = ev[p], b = ev[p + 1], k = ev[p + 5];
      E.a.push(a); E.b.push(b); E.cls.push(ev[p + 2]); E.fl.push(ev[p + 3]); E.len.push(ev[p + 4]);
      E.g0.push(gx.length); E.gn.push(k);
      let cx = Math.round((lon[a] - d.origin[0]) * d.scale), cy = Math.round((lat[a] - d.origin[1]) * d.scale);
      for (let j = 0; j < k; j++) {
        cx += ev[p + 6 + 2 * j]; cy += ev[p + 7 + 2 * j];
        gx.push(d.origin[0] + cx / d.scale); gy.push(d.origin[1] + cy / d.scale);
      }
      p += 6 + 2 * k;
    }
    // 有向の弧（状態 = ノード×移動手段）を CSR 形式で持つ
    const arcs = [];
    const carSec = c => E.len[c] / (d.classes[E.cls[c]][1] / 3.6);
    // 登り下りの係数（a→b, b→a。100 = 平地と同じ）。古いグラフにはないので 1 とする
    const tob = d.tob ? Float32Array.from(d.tob, v => v / 100) : new Float32Array(E.a.length * 2).fill(1);
    const footSec = (c, rev) => E.len[c] / (d.classes[E.cls[c]][2] / 3.6) * tob[2 * c + (rev ? 1 : 0)];
    const carNode = new Uint8Array(nN);
    for (let c = 0; c < E.a.length; c++) {
      const a = E.a[c], b = E.b[c], f = E.fl[c];
      if (f & 1) {
        if (!(f & 8)) arcs.push([a, CAR, b, c, carSec(c)]);
        if (!(f & 4)) arcs.push([b, CAR, a, c, carSec(c)]);
        if (E.cls[c] !== 0) carNode[a] = carNode[b] = 1;  // 高速道路だけに接する点には出発地を吸着させない
      }
      if (f & 2) { arcs.push([a, FOOT, b, c, footSec(c, false)]); arcs.push([b, FOOT, a, c, footSec(c, true)]); }
    }
    const nS = nN * 2, off = new Int32Array(nS + 1);
    arcs.forEach(r => off[r[0] * 2 + r[1] + 1]++);
    for (let i = 0; i < nS; i++) off[i + 1] += off[i];
    const to = new Int32Array(arcs.length), edge = new Int32Array(arcs.length), cost = new Float32Array(arcs.length);
    const fill = off.slice(0, nS);
    arcs.forEach(([n, m, t, c, s]) => { const i = fill[n * 2 + m]++; to[i] = t * 2 + m; edge[i] = c; cost[i] = s; });
    return { d, nN, lon, lat, E, gx, gy, off, to, edge, cost, carNode, footSec, hasTob: !!d.tob };
  }
  const load = () => loading || (loading = fetch(URL_GRAPH).then(r => {
    if (!r.ok) throw new Error('道路データを読み込めませんでした');
    return r.json();
  }).then(d => (G = decode(d))));

  // ---- 幾何 ----
  const distM = (a, b) => {
    const k = Math.cos((a[1] + b[1]) / 2 * Math.PI / 180);
    return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320;
  };
  const inArea = ll => { const b = AREA;
    return ll[0] >= b[0] && ll[0] <= b[2] && ll[1] >= b[1] && ll[1] <= b[3]; };
  function nearestCarNode(ll) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < G.nN; i++) {
      if (!G.carNode[i]) continue;
      const dd = distM(ll, [G.lon[i], G.lat[i]]);
      if (dd < bd) { bd = dd; best = i; }
    }
    return [best, bd];
  }
  function edgeCoords(c, fromNode) {
    const E = G.E, pts = [[G.lon[E.a[c]], G.lat[E.a[c]]]];
    for (let j = 0; j < E.gn[c]; j++) pts.push([G.gx[E.g0[c] + j], G.gy[E.g0[c] + j]]);
    pts.push([G.lon[E.b[c]], G.lat[E.b[c]]]);
    return fromNode === E.a[c] ? pts : pts.reverse();
  }

  // ---- 道のない区間（直線）の評価 ----
  // a→b を OFF_STEP_M ごとに区切り、各区間の勾配（Tobler）と横切る斜面の傾斜（slopePenalty）から時間を出す。
  // 標高を読めないとき（タイル未取得・海など）は平地として扱う
  let demOk = false;
  function offroad(a, b, withSamples) {
    const L = distM(a, b), n = Math.max(1, Math.round(L / OFF_STEP_M)), d = L / n, v = OFFROAD_KMH / 3.6;
    if (!demOk || L < 1) return { sec: L / v, steepM: 0, maxDeg: 0, samples: [] };
    let sec = 0, steepM = 0, maxDeg = 0, h0 = Slope.elevAt(a);
    const samples = withSamples ? [{ ll: a, h: h0, deg: Slope.slopeAt(a) }] : null;
    for (let k = 1; k <= n; k++) {
      const t = k / n, ll = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const h1 = Slope.elevAt(ll), deg = Slope.slopeAt(ll);
      const g = isNaN(h0) || isNaN(h1) ? 0 : Math.max(-1, Math.min(1, (h1 - h0) / d));
      const dg = isNaN(deg) ? 0 : deg;
      sec += d / v * (TOB0 / tobler(g)) * slopePenalty(dg);
      if (dg >= STEEP_DEG) steepM += d;
      maxDeg = Math.max(maxDeg, dg);
      if (samples) samples.push({ ll, h: h1, deg: dg });
      h0 = h1;
    }
    return { sec, steepM, maxDeg, samples };
  }

  // ---- ダイクストラ（二分ヒープ）----
  function dijkstra(src) {
    const nS = G.nN * 2, dist = new Float64Array(nS).fill(Infinity);
    const prev = new Int32Array(nS).fill(-1), prevEdge = new Int32Array(nS).fill(-1);
    const hk = [], hv = [];
    const push = (k, v) => { let i = hk.length; hk.push(k); hv.push(v);
      while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; } hk[i] = k; hv[i] = v; };
    const pop = () => { const v = hv[0], k = hk.pop(), x = hv.pop(); const n = hk.length;
      if (n) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && hk[c + 1] < hk[c]) c++; if (hk[c] >= k) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c; } hk[i] = k; hv[i] = x; }
      return v; };
    dist[src] = 0; push(0, src);
    while (hk.length) {
      const k0 = hk[0], s = pop();
      if (k0 > dist[s]) continue;
      const relax = (t, c, e) => { const nd = dist[s] + c; if (nd < dist[t]) { dist[t] = nd; prev[t] = s; prevEdge[t] = e; push(nd, t); } };
      for (let i = G.off[s]; i < G.off[s + 1]; i++) relax(G.to[i], G.cost[i], G.edge[i]);
      if ((s & 1) === CAR) relax(s + 1, PARK_SEC, -1);  // 駐車して歩き出す
    }
    return { dist, prev, prevEdge };
  }

  const bboxOf = cs => [[Math.min(...cs.map(c => c[0])), Math.min(...cs.map(c => c[1]))], [Math.max(...cs.map(c => c[0])), Math.max(...cs.map(c => c[1]))]];
  // 徒歩区間（道あり → 道なし）の標高断面図。SVG と登り・下りの合計を返す
  function profile(walk, offSamples) {
    const P = [];  // [累積距離m, 標高m, 道なしか, 傾斜°]
    // 道あり区間は折れ線に沿って 20m ごとに読む
    let acc = 0;
    for (let i = 0; i < walk.length; i++) {
      if (i === 0) { P.push([0, Slope.elevAt(walk[0]), false, 0]); continue; }
      const a = walk[i - 1], b = walk[i], L = distM(a, b), n = Math.max(1, Math.round(L / 20));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        P.push([acc + L * t, Slope.elevAt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]), false, 0]);
      }
      acc += L;
    }
    // 道なし区間（offroad() が読んだ点をそのまま使う。先頭はアプローチ点＝道あり区間の終点）
    for (let k = 1; k < offSamples.length; k++) {
      acc += distM(offSamples[k - 1].ll, offSamples[k].ll);
      P.push([acc, offSamples[k].h, true, offSamples[k].deg]);
    }
    if (!walk.length && offSamples.length) P.unshift([0, offSamples[0].h, false, 0]);
    const pts = P.filter(p => !isNaN(p[1]));
    if (pts.length < 2) return '';
    let up = 0, down = 0;
    for (let i = 1; i < pts.length; i++) { const dh = pts[i][1] - pts[i - 1][1]; if (dh > 0) up += dh; else down -= dh; }
    const W = 270, H = 90, ml = 34, mb = 16, D = pts[pts.length - 1][0] || 1;
    const hs = pts.map(p => p[1]), lo = Math.min(...hs), hi = Math.max(...hs), span = Math.max(20, hi - lo);
    const X = d => ml + d / D * (W - ml - 4), Y = h => 4 + (1 - (h - lo) / span) * (H - mb - 4);
    const path = (arr) => arr.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    const onRoad = pts.filter(p => !p[2]), offPts = pts.filter((p, i) => p[2] || (pts[i + 1] && pts[i + 1][2]));
    let steepSvg = '';
    for (let i = 1; i < pts.length; i++) if (pts[i][2] && pts[i][3] >= STEEP_DEG)
      steepSvg += `<path d="M${X(pts[i - 1][0]).toFixed(1)},${Y(pts[i - 1][1]).toFixed(1)}L${X(pts[i][0]).toFixed(1)},${Y(pts[i][1]).toFixed(1)}" stroke="#d32f2f" stroke-width="3.5" fill="none"/>`;
    const km = D >= 1000 ? (D / 1000).toFixed(1) + ' km' : Math.round(D) + ' m';
    return `<div style="margin-top:6px"><b>徒歩区間の標高断面</b> <small>登り ${Math.round(up)} m・下り ${Math.round(down)} m</small>
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;background:#fafafa;border:1px solid #ddd;border-radius:4px" role="img" aria-label="徒歩区間の標高断面図">
        <text x="${ml - 3}" y="${Y(hi) + 4}" font-size="9" text-anchor="end" fill="#555">${Math.round(hi)}m</text>
        <text x="${ml - 3}" y="${Y(lo) + 3}" font-size="9" text-anchor="end" fill="#555">${Math.round(lo)}m</text>
        <line x1="${ml}" y1="${H - mb}" x2="${W - 4}" y2="${H - mb}" stroke="#bbb"/>
        <text x="${ml}" y="${H - 4}" font-size="9" fill="#555">0</text><text x="${W - 4}" y="${H - 4}" font-size="9" text-anchor="end" fill="#555">${km}</text>
        ${onRoad.length > 1 ? `<path d="${path(onRoad)}" stroke="#2e7d32" stroke-width="2" fill="none"/>` : ''}
        ${offPts.length > 1 ? `<path d="${path(offPts)}" stroke="#757575" stroke-width="2" stroke-dasharray="3 2" fill="none"/>` : ''}
        ${steepSvg}
      </svg><small>緑＝道あり、灰＝道なし、赤＝${STEEP_DEG}°以上の急斜面。目的地の標高 ${Math.round(pts[pts.length - 1][1])} m</small></div>`;
  }

  // ---- コース全体の標高断面図（箱根駅伝のコース紹介のような面グラフ）----
  // 出発地から目的地まで（車・徒歩・道なし）の標高を1本の面グラフにし、出発地・駐車地点・最高点・目的地と、
  // 途中の地名（国土地理院の逆ジオコーダ）を縦書きの ▼ ラベルで示す。標高は国土地理院 DEM（橋・トンネルは地表の高さ）。
  const MODE_COL = ['#1565c0', '#2e7d32', '#757575'];  // 0=車 1=徒歩 2=道なし
  const shortLabel = (t, fallback) => { t = String(t || '').trim(); return !t || /^(北緯|地図|現在地)/.test(t) ? fallback : (t.length > 6 ? t.slice(0, 6) : t); };
  async function townName(ll) {
    try {
      const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 4000);
      const r = await (await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${ll[1].toFixed(5)}&lon=${ll[0].toFixed(5)}`, { signal: ac.signal })).json();
      clearTimeout(tm);
      const n = (r.results && r.results.lv01Nm || '').replace(/^(大字|字)/, '').replace(/[0-9０-９一二三四五六七八九十丁目]+$/, '');
      return n.length >= 2 ? n.slice(0, 6) : '';
    } catch (e) { return ''; }
  }
  const niceStep = (span, maxTicks, steps) => steps.find(st => span / st <= maxTicks) || steps[steps.length - 1];
  async function courseProfile(R) {
    const seq = [];  // [経度, 緯度, 手段]
    const push = (ll, m) => { const q = seq[seq.length - 1]; if (!q || q[0] !== ll[0] || q[1] !== ll[1]) seq.push([ll[0], ll[1], m]); };
    push(R.start, 2); push(R.startNode, 2);
    R.lines[CAR].forEach(l => l.coords.forEach(c => push(c, 0)));
    R.lines[FOOT].forEach(l => l.coords.forEach(c => push(c, 1)));
    (R.offLL.length ? R.offLL : [R.goalNode]).forEach(c => push(c, 2)); push(R.goal, 2);
    if (seq.length < 2) return '';
    const cum = [0]; for (let i = 1; i < seq.length; i++) cum.push(cum[i - 1] + distM(seq[i - 1], seq[i]));
    const D = cum[cum.length - 1]; if (D < 30) return '';
    // 等間隔に並べ直す（最大およそ320点）
    const step = Math.max(25, D / 320), S = [];
    for (let d = 0, k = 1; d <= D + 1e-6; d += step) {
      while (k < seq.length - 1 && cum[k] < d) k++;
      const a = seq[k - 1], b = seq[k], t = cum[k] > cum[k - 1] ? Math.min(1, (d - cum[k - 1]) / (cum[k] - cum[k - 1])) : 0;
      S.push({ d, ll: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], m: b[2] });
    }
    if (S[S.length - 1].d < D - 1) S.push({ d: D, ll: seq[seq.length - 1].slice(0, 2), m: seq[seq.length - 1][2] });
    // 標高タイルを経路に沿って読む（約600mおき）
    const stops = S.filter((_, i) => i % Math.max(1, Math.round(600 / step)) === 0).map(s => s.ll);
    for (let i = 0; i < stops.length; i += 8) await Promise.all(stops.slice(i, i + 8).map(ll => Slope.prefetch([ll, ll]).catch(() => {})));
    S.forEach(s => { s.h = Slope.elevAt(s.ll); });
    const ok = S.filter(s => !isNaN(s.h)); if (ok.length < 2) return '';
    S.forEach((s, i) => { if (isNaN(s.h)) { let a = i - 1, b = i + 1; while (a >= 0 && isNaN(S[a].h)) a--; while (b < S.length && isNaN(S[b].h)) b++;
      s.h = a < 0 ? S[b].h : b >= S.length ? S[a].h : S[a].h + (S[b].h - S[a].h) * (s.d - S[a].d) / (S[b].d - S[a].d); } });
    let up = 0, down = 0; for (let i = 1; i < S.length; i++) { const dh = S[i].h - S[i - 1].h; if (Math.abs(dh) > 0.5) (dh > 0 ? up += dh : down -= dh); }
    // ラベル：出発地・駐車地点・最高点・目的地 ＋ 途中の地名
    const hi = S.reduce((m, s) => s.h > m.h ? s : m, S[0]);
    const marks = [{ d: 0, name: shortLabel(R.labels.start, '出発地') }, { d: D, name: shortLabel(R.labels.goal, '目的地') }];
    if (R.park) { const pd = S.reduce((m, s) => distM(s.ll, R.park) < distM(m.ll, R.park) ? s : m, S[0]); marks.push({ d: pd.d, name: 'P駐車地点' }); }
    if (hi.d > D * 0.08 && hi.d < D * 0.92) marks.push({ d: hi.d, name: '最高点' });
    const cand = [0.25, 0.5, 0.75].map(f => S.reduce((m, s) => Math.abs(s.d - D * f) < Math.abs(m.d - D * f) ? s : m, S[0]))
      .filter(c => marks.every(m => Math.abs(m.d - c.d) > D * 0.13));
    const towns = await Promise.all(cand.map(c => townName(c.ll)));
    cand.forEach((c, i) => { if (towns[i] && marks.every(m => m.name !== towns[i])) marks.push({ d: c.d, name: towns[i] }); });
    marks.sort((a, b) => a.d - b.d);
    // 描画
    const W = 360, H = 262, ml = 42, mr = 14, mt = 92, mb = 46;
    const hs = S.map(s => s.h), mn = Math.min(...hs), mx = Math.max(...hs), sp0 = Math.max(20, mx - mn);
    const ys = niceStep(sp0 * 1.15, 4, [10, 20, 50, 100, 200, 500, 1000]);
    const lo = Math.floor((mn - sp0 * 0.08) / ys) * ys, top = Math.ceil((mx + sp0 * 0.04) / ys) * ys;
    const X = d => ml + d / D * (W - ml - mr), Y = h => mt + (1 - (h - lo) / (top - lo)) * (H - mt - mb), yb = H - mb;
    const xs = niceStep(D / 1000, 6, [0.5, 1, 2, 5, 10, 20]);
    let grid = '', xt = '';
    for (let h = lo; h <= top + 1e-6; h += ys) grid += `<line x1="${ml}" y1="${Y(h).toFixed(1)}" x2="${W - mr}" y2="${Y(h).toFixed(1)}" stroke="#ccc" stroke-width="0.7"/><text x="${ml - 5}" y="${(Y(h) + 4).toFixed(1)}" font-size="12" text-anchor="end" fill="#222">${h}</text>`;
    for (let k = 0; k * xs * 1000 <= D + 1e-6; k++) { const x = X(k * xs * 1000).toFixed(1);
      xt += `<line x1="${x}" y1="${yb}" x2="${x}" y2="${yb + 4}" stroke="#222"/><text x="${x}" y="${yb + 16}" font-size="11" text-anchor="middle" fill="#222">${+(k * xs).toFixed(1)}</text>`; }
    const area = `M${X(0).toFixed(1)},${yb}` + S.map(s => `L${X(s.d).toFixed(1)},${Y(s.h).toFixed(1)}`).join('') + `L${X(D).toFixed(1)},${yb}Z`;
    let strip = '';
    for (let i = 1; i < S.length; i++) strip += `<rect x="${X(S[i - 1].d).toFixed(1)}" y="${yb + 20}" width="${(X(S[i].d) - X(S[i - 1].d) + 0.6).toFixed(1)}" height="4" fill="${MODE_COL[S[i].m]}"/>`;
    // ラベルが重ならないよう、右から順に最低15pxあけて左へずらす（▼は元の位置のまま）
    const mx0 = marks.map(m => Math.min(W - mr - 6, Math.max(ml + 6, X(m.d)))), lx = mx0.slice();
    for (let i = lx.length - 2; i >= 0; i--) lx[i] = Math.min(lx[i], lx[i + 1] - 15);
    const markSvg = marks.map((m, i) => { const s = S.reduce((q, r) => Math.abs(r.d - m.d) < Math.abs(q.d - m.d) ? r : q, S[0]);
      const x = mx0[i], tx = lx[i], ty = Y(s.h) - 4, n = [...m.name].length, len = n * 13 + 2, y0 = Math.max(4, ty - 12 - len);
      return `<polygon points="${(x - 5).toFixed(1)},${(ty - 9).toFixed(1)} ${(x + 5).toFixed(1)},${(ty - 9).toFixed(1)} ${x.toFixed(1)},${ty.toFixed(1)}" fill="#222"/>
        <text x="${tx.toFixed(1)}" y="${y0.toFixed(1)}" font-size="12" font-weight="bold" fill="#111" style="writing-mode:vertical-rl;text-orientation:upright">${xml(m.name)}</text>`; }).join('');
    const arrow = `<line x1="${ml + 4}" y1="${H - 6}" x2="${W - mr - 4}" y2="${H - 6}" stroke="#e9a29a" stroke-width="3"/><polygon points="${W - mr - 4},${H - 11} ${W - mr + 4},${H - 6} ${W - mr - 4},${H - 1}" fill="#e9a29a"/>`;
    const km = D >= 1000 ? (D / 1000).toFixed(1) + ' km' : Math.round(D) + ' m';
    return `<div class="course" style="margin-top:6px"><b>コース全体の断面図</b> <small>全長 ${km}・登り ${Math.round(up)} m・下り ${Math.round(down)} m</small>
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;background:#fff;border:1px solid #ddd;border-radius:4px" role="img" aria-label="コース全体の標高断面図">
        <text x="6" y="${mt - 8}" font-size="12" fill="#222">(m)</text>${grid}
        <path d="${area}" fill="#d9534f" fill-opacity="0.9" stroke="#b83a30" stroke-width="1"/>
        <line x1="${ml}" y1="${yb}" x2="${W - mr}" y2="${yb}" stroke="#222"/>${xt}
        ${strip}${markSvg}${arrow}
      </svg><small><span style="color:#1565c0">■</span>車 <span style="color:#2e7d32">■</span>徒歩 <span style="color:#757575">■</span>道なし ／ 横軸は距離（km）。出発地 ${Math.round(S[0].h)} m → 最高点 ${Math.round(hi.h)} m → 目的地 ${Math.round(S[S.length - 1].h)} m。標高は国土地理院DEM（橋・トンネルは地表の高さ）。</small></div>`;
  }

  // ---- 経路探索 ----
  async function run() {
    if (!pts.start || !pts.goal) { onMsg('出発地と目的地の両方を決めてください。'); return; }
    const start = pts.start.ll, goal = pts.goal.ll;
    last = null;
    if (!inArea(goal)) { onMsg(`目的地が対象範囲（${AREA_NAME}・青い点線の枠）の外です。`); return; }
    lastRoute = null;
    onMsg('経路を計算中…');
    try { await load(); } catch (e) { onMsg(e.message); return; }
    const [s0, sd] = nearestCarNode(start);
    if (sd > SNAP_MAX_M) { onMsg(`出発地から ${(sd / 1000).toFixed(1)} km 以内に車で通れる道がありません。対象範囲（${AREA_NAME}）の中で出発地を選んでください。`); return; }
    const { dist, prev, prevEdge } = dijkstra(s0 * 2 + CAR);
    // 目的地の周りの標高タイルを先に読む（道のない区間の評価に使う）
    const r = GOAL_SEARCH_M / 111320, rk = r / Math.cos(goal[1] * Math.PI / 180);
    try { await Slope.prefetch([[goal[0] - rk, goal[1] - r], [goal[0] + rk, goal[1] + r]]); demOk = true; } catch (e) { demOk = false; }
    // 目的地の周りの「歩いて行ける点」から、(そこまでの時間 + 道のない区間の時間) が最小のものを選ぶ。
    // 地形を読む計算は重いので、平地で最も速い場合の下限で並べ、下限が最良値を超えたら打ち切る
    const cand = [];
    for (let i = 0; i < G.nN; i++) {
      const t = dist[i * 2 + FOOT];
      if (t === Infinity) continue;
      const od = distM(goal, [G.lon[i], G.lat[i]]);
      if (od > GOAL_SEARCH_M) continue;
      cand.push([t + od / (OFFROAD_KMH / 3.6) * (demOk ? TOB_MIN : 1), i, t]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    let best = -1, bc = Infinity, boff = 0;
    for (const [lb, i, t] of cand) {
      if (lb >= bc) break;
      const c = t + offroad([G.lon[i], G.lat[i]], goal).sec;
      if (c < bc) { bc = c; best = i; }
    }
    if (best >= 0) boff = distM(goal, [G.lon[best], G.lat[best]]);
    if (best < 0) { onMsg('目的地の近く（2.5 km 以内）に、たどり着ける道が見つかりませんでした。'); return; }
    // 経路を逆にたどる
    const segs = [];  // { mode, edge, from }
    let park = null;
    for (let s = best * 2 + FOOT; prev[s] >= 0; s = prev[s]) {
      const p = prev[s];
      if (prevEdge[s] < 0) park = s >> 1;
      else segs.push({ mode: s & 1, edge: prevEdge[s], from: p >> 1 });
    }
    segs.reverse();
    const lines = { [CAR]: [], [FOOT]: [] }, sum = { [CAR]: [0, 0], [FOOT]: [0, 0] }, trackM = { v: 0 };
    const cls = G.d.classes, walk = [];  // walk: 徒歩区間の座標（断面図用）
    const chain = [];  // アニメーション用：始点から順に { kind, coords, sec }
    for (const g of segs) {
      const c = g.edge, L = G.E.len[c];
      const sec = g.mode === CAR ? L / (cls[G.E.cls[c]][1] / 3.6) : G.footSec(c, g.from !== G.E.a[c]);
      const pts = edgeCoords(c, g.from), arr = lines[g.mode];
      chain.push({ kind: g.mode === CAR ? 'car' : 'foot', coords: pts.slice(), sec });  // pts は下で lines 側に書き足されるので複製する
      if (g.mode === FOOT) walk.push(...(walk.length ? pts.slice(1) : pts));
      const last = arr[arr.length - 1];
      if (last && last.end === g.from) last.coords.push(...pts.slice(1));
      else arr.push({ coords: pts });
      arr[arr.length - 1].end = g.from === G.E.a[c] ? G.E.b[c] : G.E.a[c];
      sum[g.mode][0] += L; sum[g.mode][1] += sec;
      if (g.mode === CAR && G.E.cls[c] === 7) trackM.v += L;
    }
    const goalNode = [G.lon[best], G.lat[best]];
    const off = offroad(goalNode, goal, true);
    // 道のない区間で急斜面（STEEP_DEG 以上）を通る部分
    const steepLines = [];
    for (let k = 1; k < off.samples.length; k++) {
      const a = off.samples[k - 1], b = off.samples[k];
      if (Math.max(a.deg, b.deg) < STEEP_DEG) continue;
      const last = steepLines[steepLines.length - 1];
      if (last && last.k === k - 1) { last.coords.push(b.ll); last.k = k; } else steepLines.push({ coords: [a.ll, b.ll], k });
    }
    const fc = (feats) => ({ type: 'FeatureCollection', features: feats });
    const line = (coords, kind) => ({ type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: coords } });
    const pt = (c, kind, label) => ({ type: 'Feature', properties: { kind, label }, geometry: { type: 'Point', coordinates: c } });
    const startNode = [G.lon[s0], G.lat[s0]];
    map.getSource('rt-path').setData(fc([
      ...lines[CAR].map(l => line(l.coords, 'car')),
      ...lines[FOOT].map(l => line(l.coords, 'foot')),
      line([start, startNode], 'off'),
      line([goalNode, goal], 'off'),
      ...steepLines.map(l => line(l.coords, 'steep')),
    ]));
    const parkC = park !== null ? [G.lon[park], G.lat[park]] : null;
    // アニメーションの道のり：出発地→最寄りの道（直線）→車→駐車（その場で止まる）→徒歩→道なし（急斜面は赤）
    if (parkC) { const i = chain.findIndex(p => p.kind === 'foot'); chain.splice(i < 0 ? chain.length : i, 0, { kind: 'park', coords: [parkC, parkC], sec: PARK_SEC }); }
    const offPieces = off.samples.length > 1
      ? off.samples.slice(1).map((b, k) => { const a = off.samples[k];
          return { kind: Math.max(a.deg, b.deg) >= STEEP_DEG ? 'steep' : 'off', coords: [a.ll, b.ll], sec: off.sec / (off.samples.length - 1) }; })
      : [{ kind: 'off', coords: [goalNode, goal], sec: off.sec }];
    const goalElev = Slope.elevAt(goal), escH = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    RouteAnim.setPath([{ kind: 'off', coords: [start, startNode], sec: 0 }, ...chain, ...offPieces], [
      { ll: start, html: escH(pts.start.label), cls: 'start' },
      { ll: parkC, html: '駐車地点', cls: 'park' },
      { ll: goal, html: escH(pts.goal.label) + (isNaN(goalElev) ? '' : `<small>標高 ${Math.round(goalElev)}m</small>`), cls: 'goal' },
    ]);
    map.getSource('rt-pt').setData(fc(parkC ? [pt(parkC, 'park', 'P')] : []));
    routed = true;
    const all = [start, goal, ...lines[CAR].flatMap(l => l.coords), ...lines[FOOT].flatMap(l => l.coords)];
    const lo = all.map(c => c[0]), la = all.map(c => c[1]);
    map.fitBounds([[Math.min(...lo), Math.min(...la)], [Math.max(...lo), Math.max(...la)]], { padding: pad(80), maxZoom: 15, duration: 700 });
    const km = m => (m / 1000).toFixed(1) + ' km', mins = s => s < 3600 ? Math.round(s / 60) + ' 分' : Math.floor(s / 3600) + ' 時間 ' + Math.round(s % 3600 / 60) + ' 分';
    const offS = off.sec;
    lastRoute = { start, goal, startNode, goalNode, park: parkC, lines, offSamples: off.samples, boff, sd,
      carM: sum[CAR][0], footM: sum[FOOT][0], offS, totalS: sum[CAR][1] + sum[FOOT][1] + offS + (park !== null ? PARK_SEC : 0),
      labels: { start: pts.start.label, goal: pts.goal.label } };
    if (walk.length) await Slope.prefetch(bboxOf(walk)).catch(() => {});
    const prof = profile(walk, off.samples);
    const parkSec = park !== null ? PARK_SEC : 0;
    last = {
      start: { ll: start, label: pts.start.label }, goal: { ll: goal, label: pts.goal.label, elev: Slope.elevAt(goal) },
      snapM: sd, car: { m: sum[CAR][0], sec: sum[CAR][1], trackM: trackM.v },
      park: parkC, parkSec, foot: { m: sum[FOOT][0], sec: sum[FOOT][1] },
      off: { m: boff, sec: offS, steepM: off.steepM, maxDeg: off.maxDeg },
      total: sum[CAR][1] + sum[FOOT][1] + offS + parkSec,
      bounds: bboxOf([...all, goalNode]), profile: prof, hasTob: G.hasTob,
      steepDeg: STEEP_DEG, offKmh: OFFROAD_KMH, area: AREA_NAME,
      osm: G.d.source, dem: G.d.dem, at: new Date(),
    };
    onMsg(`<b>経路の目安</b><table class="rt-sum">
      <tr><td><i style="background:#1565c0"></i>車</td><td>${km(sum[CAR][0])}</td><td>${mins(sum[CAR][1])}</td></tr>
      ${trackM.v ? `<tr><td colspan="3"><small>　うち林道・農道 ${km(trackM.v)}</small></td></tr>` : ''}
      ${sum[FOOT][0] ? `<tr><td><i style="background:#2e7d32"></i>徒歩（道あり）</td><td>${km(sum[FOOT][0])}</td><td>${mins(sum[FOOT][1])}</td></tr>` : ''}
      ${boff >= 1 ? `<tr><td><i style="background:#757575"></i>道なし（直線）</td><td>${Math.round(boff)} m</td><td>${mins(offS)}</td></tr>` : ''}
      ${off.steepM >= 1 ? `<tr><td colspan="3"><small style="color:#b71c1c">　うち${STEEP_DEG}°以上の急斜面 ${Math.round(off.steepM)} m（最大 ${Math.round(off.maxDeg)}°・赤い線）</small></td></tr>` : ''}
      <tr><td><b>合計</b></td><td></td><td><b>${mins(sum[CAR][1] + sum[FOOT][1] + offS + (park !== null ? PARK_SEC : 0))}</b></td></tr></table>
      <div id="rt-course"><small>コース全体の断面図を作成中…</small></div>
      ${prof}
      ${parkC ? `<small>駐車地点（P）：北緯 ${parkC[1].toFixed(5)}° 東経 ${parkC[0].toFixed(5)}°</small><br>` : ''}
      <small>出発地から最寄りの道まで ${Math.round(sd)} m は直線で表示しています。</small><br>
      <div class="rt-note" style="color:#b71c1c"><b>林道の注意</b><ul>
        <li>ゲート閉鎖・通行止め・一般車通行禁止のことがあります。</li>
        <li>入山前に管理者（市町村・森林管理署など）へ通行できるか確認してください。</li></ul></div>
      <div class="rt-note"><b>所要時間の目安について</b><ul>
        <li>考慮している：徒歩区間の登り下り（Tobler の歩行関数、国土地理院の標高10m）、道のない区間の斜面の傾斜</li>
        <li>考慮していない：路面状況・積雪・藪の濃さ</li>
        ${G.hasTob ? '' : '<li>このグラフには登り下りの係数がないため、道のある区間は平地として計算しています。</li>'}</ul></div>`);
    // コース全体の断面図は、標高と地名を読むので、表示のあとで差し込む
    const snap = last;
    courseProfile({ start, startNode, goal, goalNode, park: parkC, lines, offLL: off.samples.map(q => q.ll), labels: { start: pts.start.label, goal: pts.goal.label } })
      .then(h => { if (last !== snap) return; snap.course = h; const el = document.getElementById('rt-course'); if (el) el.innerHTML = h; })
      .catch(() => { const el = document.getElementById('rt-course'); if (el && last === snap) el.innerHTML = ''; });
  }

  // ---- GPX の書き出し ----
  // 車・徒歩（道あり）・道なし（直線）を別々の軌跡にし、出発地・駐車地点・目的地をウェイポイントにする。
  // 標高は、標高タイルを読み込み済みの徒歩・道なし区間だけ付ける（車の区間は付けない）。
  const xml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function gpx() {
    const R = lastRoute; if (!R) return null;
    const foot = R.lines[FOOT].flatMap(l => l.coords), offLL = R.offSamples.length ? R.offSamples.map(s => s.ll) : [R.goalNode, R.goal];
    try { await Slope.prefetch(bboxOf([...foot, ...offLL])); } catch (e) { /* 標高なしで書き出す */ }
    const ele = ll => { const e = Slope.elevAt(ll); return isNaN(e) ? '' : `<ele>${e.toFixed(1)}</ele>`; };
    const trkpt = (ll, withEle) => `<trkpt lat="${ll[1].toFixed(6)}" lon="${ll[0].toFixed(6)}">${withEle ? ele(ll) : ''}</trkpt>`;
    const seg = (coords, withEle) => `<trkseg>${coords.map(c => trkpt(c, withEle)).join('')}</trkseg>`;
    const wpt = (ll, name, desc, sym) => `<wpt lat="${ll[1].toFixed(6)}" lon="${ll[0].toFixed(6)}">${ele(ll)}<name>${xml(name)}</name><desc>${xml(desc)}</desc><sym>${sym}</sym></wpt>`;
    const km = m => (m / 1000).toFixed(1) + ' km', mins = s => Math.round(s / 60) + ' 分';
    const d0 = new Date(), today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
    const desc = `車 ${km(R.carM)} ／ 徒歩（道あり）${km(R.footM)} ／ 道なし ${Math.round(R.boff)} m ／ 合計の目安 ${mins(R.totalS)}。` +
      '計画上の目安のルートです。路面・積雪・藪・通行止めは考慮していません。林道は入山前に管理者へ確認してください。道路データ © OpenStreetMap contributors (ODbL)、標高 国土地理院。';
    const trk = (name, segs) => segs.length ? `<trk><name>${name}</name>${segs.join('')}</trk>` : '';
    const offSegs = [];
    if (distM(R.start, R.startNode) >= 1) offSegs.push(seg([R.start, R.startNode], false));
    if (R.boff >= 1 || R.offSamples.length) offSegs.push(seg(offLL, true));
    const parts = [
      wpt(R.start, '出発地', R.labels.start, 'Flag, Blue'),
      R.park ? wpt(R.park, '駐車地点（P）', '車はここまで。以降は徒歩', 'Parking Area') : '',
      R.boff >= 1 ? wpt(R.goalNode, '道の端', 'ここから道なし（直線）', 'Trail Head') : '',
      wpt(R.goal, '目的地', R.labels.goal, 'Flag, Red'),
      trk('車', R.lines[CAR].map(l => seg(l.coords, false))),
      trk('徒歩（道あり）', R.lines[FOOT].map(l => seg(l.coords, true))),
      trk('道なし（直線）', offSegs),
    ].filter(Boolean).join('\n  ');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="shinsyu_b 調査ルート案内（試作）" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>調査ルート ${today}</name><desc>${xml(desc)}</desc></metadata>
  ${parts}
</gpx>
`;
  }

  // ---- 出発地・目的地 ----
  const empty = () => ({ type: 'FeatureCollection', features: [] });
  function clearRoute() {
    routed = false; last = null; lastRoute = null; RouteAnim.setPath(null);
    map.getSource('rt-path').setData(empty()); map.getSource('rt-pt').setData(empty());
  }
  function setPoint(which, ll, label) {
    pts[which] = { ll, label };
    if (!markers[which]) {
      const m = new maplibregl.Marker({ color: COLOR[which], draggable: true }).setLngLat(ll).addTo(map);
      m.on('dragend', () => { const p = m.getLngLat(); setPoint(which, [p.lng, p.lat], '地図上の地点'); });
      markers[which] = m;
    } else markers[which].setLngLat(ll).addTo(map);
    onChange(which, pts[which], inArea(ll));
    if (routed) run();             // 案内中にピンを動かしたら引き直す
    else clearRoute(), onMsg(pts.start && pts.goal ? '「案内」を押すと経路を表示します。' : pts.start ? '目的地を決めてください。' : '出発地を決めてください。');
  }
  function clear() {
    ['start', 'goal'].forEach(w => { pts[w] = null; if (markers[w]) markers[w].remove(); onChange(w, null, true); });
    clearRoute(); onMsg('出発地を決めてください。');
  }
  function swap() {
    const s0 = pts.start, g0 = pts.goal;
    pts.start = pts.goal = null;
    ['start', 'goal'].forEach(w => { if (markers[w]) markers[w].remove(); onChange(w, null, true); });
    const r = routed; routed = false;
    if (g0) setPoint('start', g0.ll, g0.label);
    if (s0) setPoint('goal', s0.ll, s0.label);
    if (r && s0 && g0) run();
  }
  function locate() {
    if (!navigator.geolocation) { onMsg('このブラウザでは現在地を取得できません。'); return; }
    onMsg('現在地を取得中…');
    navigator.geolocation.getCurrentPosition(
      p => setPoint('start', [p.coords.longitude, p.coords.latitude], `現在地（精度 約${Math.round(p.coords.accuracy)} m）`),
      e => onMsg('現在地を取得できませんでした（' + e.message + '）。地名で探すか「地図で選ぶ」を使ってください。'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }
  // 地名・住所の検索（国土地理院の地名検索API）。「緯度,経度」の入力も受け付ける
  async function search(text) {
    const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,、 ]\s*(-?\d+(?:\.\d+)?)$/);
    if (m) { let a = +m[1], b = +m[2]; if (a > 90) [a, b] = [b, a]; return [{ ll: [b, a], label: `北緯 ${a}° 東経 ${b}°` }]; }
    const r = await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(text.trim()));
    if (!r.ok) throw new Error('地名を検索できませんでした');
    const near = ll => ll[0] > AREA[0] - 0.1 && ll[0] < AREA[2] + 0.1 && ll[1] > AREA[1] - 0.1 && ll[1] < AREA[3] + 0.1;
    return (await r.json()).map(f => ({ ll: f.geometry.coordinates, label: f.properties.title })).filter(f => near(f.ll)).slice(0, 8);
  }

  // ---- 地図レイヤ ----
  const NET_COLOR = ['match', ['get', 'cls'], 0, '#e65100', 1, '#ef6c00', 2, '#f9a825', 3, '#f9a825', 7, '#795548', 8, '#2e7d32', 9, '#66bb6a', 10, '#66bb6a', '#9e9e9e'];
  async function showNetwork(on) {
    if (!on) { if (map.getLayer('rt-net')) ['rt-net', 'rt-net-foot'].forEach(l => map.setLayoutProperty(l, 'visibility', 'none')); return; }
    await load();
    if (!map.getSource('rt-net')) {
      const feats = G.E.a.map((_, c) => ({ type: 'Feature', properties: { cls: G.E.cls[c] }, geometry: { type: 'LineString', coordinates: edgeCoords(c, G.E.a[c]) } }));
      map.addSource('rt-net', { type: 'geojson', data: { type: 'FeatureCollection', features: feats }, attribution: G.d.source });
      const FOOT_CLS = ['in', ['get', 'cls'], ['literal', [8, 9, 10]]];
      map.addLayer({ id: 'rt-net', type: 'line', source: 'rt-net', minzoom: 10, filter: ['!', FOOT_CLS],
        paint: { 'line-color': NET_COLOR, 'line-width': ['match', ['get', 'cls'], [0, 1, 2, 3], 2, 7, 1.6, 1] } }, 'rt-path-off');
      map.addLayer({ id: 'rt-net-foot', type: 'line', source: 'rt-net', minzoom: 11, filter: FOOT_CLS,
        paint: { 'line-color': NET_COLOR, 'line-width': 1.3, 'line-dasharray': [2, 1.5] } }, 'rt-path-off');
    }
    ['rt-net', 'rt-net-foot'].forEach(l => map.setLayoutProperty(l, 'visibility', 'visible'));
  }
  function init(m, msg, change) {
    map = m; onMsg = msg; onChange = change;
    const b = AREA;
    map.addSource('rt-area', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] } } });
    map.addLayer({ id: 'rt-area', type: 'line', source: 'rt-area', paint: { 'line-color': '#1565c0', 'line-width': 1.5, 'line-dasharray': [4, 2] }, layout: { visibility: 'none' } });
    map.addSource('rt-path', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'rt-path-off', type: 'line', source: 'rt-path', filter: ['==', ['get', 'kind'], 'off'], paint: { 'line-color': '#616161', 'line-width': 2.5, 'line-dasharray': [1, 1.5] } });
    map.addLayer({ id: 'rt-path-steep', type: 'line', source: 'rt-path', filter: ['==', ['get', 'kind'], 'steep'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#d32f2f', 'line-width': 5 } });
    map.addLayer({ id: 'rt-path-casing', type: 'line', source: 'rt-path', filter: ['in', ['get', 'kind'], ['literal', ['car', 'foot']]], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8 } });
    map.addLayer({ id: 'rt-path-car', type: 'line', source: 'rt-path', filter: ['==', ['get', 'kind'], 'car'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#1565c0', 'line-width': 5 } });
    map.addLayer({ id: 'rt-path-foot', type: 'line', source: 'rt-path', filter: ['==', ['get', 'kind'], 'foot'], layout: { 'line-join': 'round' }, paint: { 'line-color': '#2e7d32', 'line-width': 5, 'line-dasharray': [1.2, 0.8] } });
    map.addSource('rt-pt', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'rt-pt', type: 'circle', source: 'rt-pt', paint: { 'circle-radius': 9, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
      'circle-color': ['match', ['get', 'kind'], 'start', '#1565c0', 'park', '#ff6f00', '#c62828'] } });
    RouteAnim.init(map, () => pad(80));
  }

  // ---- 経路をたどるアニメーション（route_anim.js）----
  const STATIC = ['rt-path-off', 'rt-path-steep', 'rt-path-casing', 'rt-path-car', 'rt-path-foot'];
  const animate = on => RouteAnim.enable(on);
  const pauseAnim = p => RouteAnim.pause(p);  // PDF の地図画像を撮る間などに一時停止する
  function setVisible(on) {
    ['rt-area', ...STATIC, ...RouteAnim.LAYERS, 'rt-pt'].forEach(l => map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none'));
    pauseAnim(!on);  // パネルを閉じている間は止める
    Object.values(markers).forEach(mk => mk.getElement().style.display = on ? '' : 'none');
    if (!on) { showNetwork(false); cancelPick(); }
  }
  // 地図クリックを横取りする（地点を選ぶモード）。横取りしたら true
  function handleClick(ll) {
    if (!pickFor) return false;
    const w = pickFor; cancelPick();
    setPoint(w, ll, '地図で選んだ地点');
    return true;
  }
  function cancelPick() { pickFor = null; if (map) map.getCanvas().style.cursor = ''; }
  const pick = which => { pickFor = which; map.getCanvas().style.cursor = 'crosshair'; onMsg(`地図をクリックして${which === 'start' ? '出発地' : '目的地'}を選んでください。`); };
  const zoomArea = () => map.fitBounds([[AREA[0], AREA[1]], [AREA[2], AREA[3]]], { padding: pad(40), duration: 700 });
  return { init, setVisible, gpx, hasRoute: () => !!lastRoute, showNetwork, run, clear, swap, locate, search, setPoint, pick, handleClick, zoomArea, inArea,
    animate, pauseAnim, has: w => !!pts[w], result: () => last, AREA_NAME };
})();
