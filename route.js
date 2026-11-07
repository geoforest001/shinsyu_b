// 調査ルート案内（試作：諏訪湖周辺）
// 出発地から「車で行ける所まで車 → 駐車 → 徒歩 → 道のない区間は直線」で目的地への経路を探す。
// グラフは tools/build_route_graph.py が作る data/route/suwa_graph.json。
// 画面は左のサイドバーで出発地と目的地を決め、「案内」を押すと経路を描く。
const Route = (() => {
  const URL_GRAPH = 'data/route/suwa_graph.json';
  const AREA = [137.95, 35.93, 138.27, 36.17];  // 西, 南, 東, 北（グラフの bbox と同じ）
  const AREA_NAME = '諏訪湖周辺';
  const PARK_SEC = 120;          // 駐車・身支度の時間（車→徒歩の乗り換えコスト）
  const OFFROAD_KMH = 1.0;       // 道のない区間（藪こぎ・沢沿い）の歩行速度の目安
  const SNAP_MAX_M = 3000;       // 出発地を道路に吸着させる最大距離
  const GOAL_SEARCH_M = 2500;    // 目的地の周りで「道の端」を探す範囲
  const CAR = 0, FOOT = 1;
  const COLOR = { start: '#1565c0', goal: '#c62828' };
  // 左のサイドバーに隠れないよう、地図を合わせるときの左余白を広げる
  const pad = p => { const el = document.getElementById('rt-panel'), w = el && el.offsetWidth && innerWidth > 600 ? el.offsetWidth + 10 : 0;
    return { top: p, bottom: p, right: p, left: p + w }; };
  let map, G = null, loading = null, onMsg = () => {}, onChange = () => {};
  let pickFor = null, routed = false;
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
    const footSec = c => E.len[c] / (d.classes[E.cls[c]][2] / 3.6);
    const carNode = new Uint8Array(nN);
    for (let c = 0; c < E.a.length; c++) {
      const a = E.a[c], b = E.b[c], f = E.fl[c];
      if (f & 1) {
        if (!(f & 8)) arcs.push([a, CAR, b, c, carSec(c)]);
        if (!(f & 4)) arcs.push([b, CAR, a, c, carSec(c)]);
        if (E.cls[c] !== 0) carNode[a] = carNode[b] = 1;  // 高速道路だけに接する点には出発地を吸着させない
      }
      if (f & 2) { arcs.push([a, FOOT, b, c, footSec(c)]); arcs.push([b, FOOT, a, c, footSec(c)]); }
    }
    const nS = nN * 2, off = new Int32Array(nS + 1);
    arcs.forEach(r => off[r[0] * 2 + r[1] + 1]++);
    for (let i = 0; i < nS; i++) off[i + 1] += off[i];
    const to = new Int32Array(arcs.length), edge = new Int32Array(arcs.length), cost = new Float32Array(arcs.length);
    const fill = off.slice(0, nS);
    arcs.forEach(([n, m, t, c, s]) => { const i = fill[n * 2 + m]++; to[i] = t * 2 + m; edge[i] = c; cost[i] = s; });
    return { d, nN, lon, lat, E, gx, gy, off, to, edge, cost, carNode };
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

  // ---- 経路探索 ----
  async function run() {
    if (!pts.start || !pts.goal) { onMsg('出発地と目的地の両方を決めてください。'); return; }
    const start = pts.start.ll, goal = pts.goal.ll;
    if (!inArea(goal)) { onMsg(`目的地が対象範囲（${AREA_NAME}・青い点線の枠）の外です。`); return; }
    onMsg('経路を計算中…');
    try { await load(); } catch (e) { onMsg(e.message); return; }
    const [s0, sd] = nearestCarNode(start);
    if (sd > SNAP_MAX_M) { onMsg(`出発地から ${(sd / 1000).toFixed(1)} km 以内に車で通れる道がありません。対象範囲（${AREA_NAME}）の中で出発地を選んでください。`); return; }
    const { dist, prev, prevEdge } = dijkstra(s0 * 2 + CAR);
    // 目的地の周りの「歩いて行ける点」から、(そこまでの時間 + 道のない区間の時間) が最小のものを選ぶ
    let best = -1, bc = Infinity, boff = 0;
    for (let i = 0; i < G.nN; i++) {
      const t = dist[i * 2 + FOOT];
      if (t === Infinity) continue;
      const od = distM(goal, [G.lon[i], G.lat[i]]);
      if (od > GOAL_SEARCH_M) continue;
      const c = t + od / (OFFROAD_KMH / 3.6);
      if (c < bc) { bc = c; best = i; boff = od; }
    }
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
    const cls = G.d.classes;
    for (const g of segs) {
      const c = g.edge, L = G.E.len[c], sp = cls[G.E.cls[c]][g.mode === CAR ? 1 : 2];
      const pts = edgeCoords(c, g.from), arr = lines[g.mode];
      const last = arr[arr.length - 1];
      if (last && last.end === g.from) last.coords.push(...pts.slice(1));
      else arr.push({ coords: pts });
      arr[arr.length - 1].end = g.from === G.E.a[c] ? G.E.b[c] : G.E.a[c];
      sum[g.mode][0] += L; sum[g.mode][1] += L / (sp / 3.6);
      if (g.mode === CAR && G.E.cls[c] === 7) trackM.v += L;
    }
    const goalNode = [G.lon[best], G.lat[best]];
    const fc = (feats) => ({ type: 'FeatureCollection', features: feats });
    const line = (coords, kind) => ({ type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates: coords } });
    const pt = (c, kind, label) => ({ type: 'Feature', properties: { kind, label }, geometry: { type: 'Point', coordinates: c } });
    const startNode = [G.lon[s0], G.lat[s0]];
    map.getSource('rt-path').setData(fc([
      ...lines[CAR].map(l => line(l.coords, 'car')),
      ...lines[FOOT].map(l => line(l.coords, 'foot')),
      line([start, startNode], 'off'),
      line([goalNode, goal], 'off'),
    ]));
    const parkC = park !== null ? [G.lon[park], G.lat[park]] : null;
    map.getSource('rt-pt').setData(fc(parkC ? [pt(parkC, 'park', 'P')] : []));
    routed = true;
    const all = [start, goal, ...lines[CAR].flatMap(l => l.coords), ...lines[FOOT].flatMap(l => l.coords)];
    const lo = all.map(c => c[0]), la = all.map(c => c[1]);
    map.fitBounds([[Math.min(...lo), Math.min(...la)], [Math.max(...lo), Math.max(...la)]], { padding: pad(80), maxZoom: 15, duration: 700 });
    const km = m => (m / 1000).toFixed(1) + ' km', mins = s => s < 3600 ? Math.round(s / 60) + ' 分' : Math.floor(s / 3600) + ' 時間 ' + Math.round(s % 3600 / 60) + ' 分';
    const offS = boff / (OFFROAD_KMH / 3.6);
    onMsg(`<b>経路の目安</b><table class="rt-sum">
      <tr><td><i style="background:#1565c0"></i>車</td><td>${km(sum[CAR][0])}</td><td>${mins(sum[CAR][1])}</td></tr>
      ${trackM.v ? `<tr><td colspan="3"><small>　うち林道・農道 ${km(trackM.v)}</small></td></tr>` : ''}
      ${sum[FOOT][0] ? `<tr><td><i style="background:#2e7d32"></i>徒歩（道あり）</td><td>${km(sum[FOOT][0])}</td><td>${mins(sum[FOOT][1])}</td></tr>` : ''}
      ${boff >= 1 ? `<tr><td><i style="background:#757575"></i>道なし（直線）</td><td>${Math.round(boff)} m</td><td>${mins(offS)}</td></tr>` : ''}
      <tr><td><b>合計</b></td><td></td><td><b>${mins(sum[CAR][1] + sum[FOOT][1] + offS + (park !== null ? PARK_SEC : 0))}</b></td></tr></table>
      ${parkC ? `<small>駐車地点（P）：北緯 ${parkC[1].toFixed(5)}° 東経 ${parkC[0].toFixed(5)}°</small><br>` : ''}
      <small>出発地から最寄りの道まで ${Math.round(sd)} m は直線で表示しています。</small><br>
      <small style="color:#b71c1c">林道はゲート閉鎖・通行止め・一般車通行禁止のことがあります。入山前に管理者（市町村・森林管理署など）へ通行可否を確認してください。所要時間は平地の速度による目安で、登りや路面状況は考慮していません。</small>`);
  }

  // ---- 出発地・目的地 ----
  const empty = () => ({ type: 'FeatureCollection', features: [] });
  function clearRoute() {
    routed = false;
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
    map.addLayer({ id: 'rt-path-casing', type: 'line', source: 'rt-path', filter: ['!=', ['get', 'kind'], 'off'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8 } });
    map.addLayer({ id: 'rt-path-car', type: 'line', source: 'rt-path', filter: ['==', ['get', 'kind'], 'car'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#1565c0', 'line-width': 5 } });
    map.addLayer({ id: 'rt-path-foot', type: 'line', source: 'rt-path', filter: ['==', ['get', 'kind'], 'foot'], layout: { 'line-join': 'round' }, paint: { 'line-color': '#2e7d32', 'line-width': 5, 'line-dasharray': [1.2, 0.8] } });
    map.addSource('rt-pt', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'rt-pt', type: 'circle', source: 'rt-pt', paint: { 'circle-radius': 9, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
      'circle-color': ['match', ['get', 'kind'], 'start', '#1565c0', 'park', '#ff6f00', '#c62828'] } });
  }
  function setVisible(on) {
    ['rt-area', 'rt-path-off', 'rt-path-casing', 'rt-path-car', 'rt-path-foot', 'rt-pt'].forEach(l => map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none'));
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
  return { init, setVisible, showNetwork, run, clear, swap, locate, search, setPoint, pick, handleClick, zoomArea, inArea,
    has: w => !!pts[w], AREA_NAME };
})();
