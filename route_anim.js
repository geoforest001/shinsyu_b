// 経路をたどるアニメーション（駅伝中継風）
// 地図を傾けてカメラが先頭を追いかけ、線が出発地から目的地へ伸びていく。
// 先頭は進行方向を向いた矢印。出発地・駐車地点・目的地に地名ラベル、右下に区間と距離のパネルを出す。
// 1 周は「出発地へ寄る（INTRO）→ たどる（RUN）→ 全体を見渡して止める（HOLD）」。これをくり返す。
// route.js が道のり（{ kind, coords, sec } の列）を setPath で渡す。kind: off / car / park / foot / steep
const RouteAnim = (() => {
  const INTRO_MS = 1500, HOLD_MS = 4000;
  // 進む速さは車・徒歩とも同じ（地図上で一定の速さ）。駐車地点では少し止まる。
  // 長い経路で時間がかかりすぎるときだけ、RUN_MAX_MS に収まるよう全体を速める
  const SPEED_MPS = 450, PARK_PAUSE_MS = 1200, RUN_MAX_MS = 60000;
  const DIM = 0.25;              // アニメーション中、経路全体（静止表示）を薄くする不透明度
  const PITCH = 60, HOLD_PITCH = 45;
  const ZOOM = 14;     // たどる間のカメラのズーム（一定にして、画面上の速さもそろえる）
  const LOOK_M = 800;    // 進行方向を決めるときに先を見る距離
  const COLOR = { off: '#424242', car: '#1565c0', park: '#ff6f00', foot: '#2e7d32', steep: '#d32f2f' };
  const NAME = { off: '道なし', car: '車', park: '駐車', foot: '徒歩', steep: '急斜面' };
  const STATIC = ['rt-path-off', 'rt-path-steep', 'rt-path-casing', 'rt-path-car', 'rt-path-foot'];
  const LAYERS = ['rt-anim-off', 'rt-anim-steep', 'rt-anim-casing', 'rt-anim-car', 'rt-anim-foot'];
  let map = null, path = null, on = false, paused = false, running = false;
  let frame = 0, t0 = 0, phase = '', lastNow = 0, follow = true, camB = 0, camZ = 13, curKind = '';
  let capped = [];  // アニメーション中に最大ズームを下げたラスタソース [ソース, 元の maxzoom]
  let getPad = () => 60, arrow = null, arrowOn = false, hud = null, marks = [];

  const distM = (a, b) => {
    const k = Math.cos((a[1] + b[1]) / 2 * Math.PI / 180);
    return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320;
  };
  const bearing = (a, b) => Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI;
  const wrap = d => ((d + 540) % 360) - 180;
  const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  const km = m => (m / 1000).toFixed(1);
  const el = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; };

  // ---- 道のり ----
  // 点の列 P と、各点に着くまでの時間 T（ミリ秒）・距離 D。K[i] は P[i]→P[i+1] の種類
  function setPath(pieces, labels) {
    clearMarks();
    if (!pieces) { path = null; update(); return; }
    const P = [pieces[0].coords[0]], K = [], T = [0], D = [0];
    for (const pc of pieces) {
      const cs = pc.coords, seg = [];
      for (let i = 1; i < cs.length; i++) seg.push(distM(cs[i - 1], cs[i]));
      const L = seg.reduce((a, b) => a + b, 0);
      seg.forEach((d, i) => {
        P.push(cs[i + 1]); K.push(pc.kind);
        T.push(T[T.length - 1] + (pc.kind === 'park' ? (L > 0 ? PARK_PAUSE_MS * d / L : PARK_PAUSE_MS / seg.length) : d / SPEED_MPS * 1000));
        D.push(D[D.length - 1] + d);
      });
    }
    const lo = P.map(p => p[0]), la = P.map(p => p[1]);
    const total = T[T.length - 1] || 1;
    path = { P, K, T, D, total, runMs: Math.min(total, RUN_MAX_MS), dist: D[D.length - 1],
      bounds: [[Math.min(...lo), Math.min(...la)], [Math.max(...lo), Math.max(...la)]] };
    (labels || []).forEach(l => l.ll && addMark(el('ra-label ' + (l.cls || ''), l.html), l.ll, -1, 'bottom-left', [12, -14]));
    t0 = performance.now(); phase = '';
    update();
  }
  // 距離（または持ち時間）d の位置：添字 i、区間内の割合 f、座標 p
  function at(v, A) {
    let lo = 0, hi = A.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (A[m] <= v) lo = m; else hi = m - 1; }
    const P = path.P, i = Math.min(lo, P.length - 2);
    const f = A[i + 1] > A[i] ? Math.min(1, Math.max(0, (v - A[i]) / (A[i + 1] - A[i]))) : 1;
    return { i, f, p: lerp(P[i], P[i + 1], f) };
  }

  // ---- 表示部品（ラベル・矢印・パネル）----
  function addMark(node, ll, d, anchor, offset) {
    node.style.display = 'none';
    marks.push({ m: new maplibregl.Marker({ element: node, anchor, offset }).setLngLat(ll).addTo(map), d });
  }
  function clearMarks() { marks.forEach(k => k.m.remove()); marks = []; }
  function showMarks(d) { marks.forEach(k => k.m.getElement().style.display = running && (k.d < 0 || d >= k.d) ? '' : 'none'); }
  function setArrow(p, deg, kind) {
    if (!arrow) {
      const node = el('ra-arrow', '<svg viewBox="-12 -14 24 26" width="34" height="36"><path d="M0,-12 L10,10 L0,4 L-10,10 Z" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg>');
      arrow = new maplibregl.Marker({ element: node, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat(p);
    }
    arrow.setLngLat(p).setRotation(deg);
    arrow.getElement().querySelector('path').setAttribute('fill', COLOR[kind] || COLOR.car);
    if (!arrowOn) { arrow.addTo(map); arrowOn = true; }
  }
  function setHud(kind, d, done) {
    if (!hud) {
      hud = el('ra-hud', '<div class="ra-row"><span class="ra-badge"></span><span class="ra-dist"><b></b><small>km</small><i></i></span></div><div class="ra-bar"><i></i></div>');
      map.getContainer().append(hud);
    }
    hud.hidden = !running;
    if (!running) return;
    hud.querySelector('.ra-badge').textContent = done ? '到着' : NAME[kind];
    hud.querySelector('.ra-badge').style.background = done ? '#c62828' : COLOR[kind];
    hud.querySelector('.ra-dist b').textContent = km(d);
    hud.querySelector('.ra-dist i').textContent = ` / ${km(path.dist)} km`;
    const bar = hud.querySelector('.ra-bar i');
    bar.style.width = (d / path.dist * 100).toFixed(1) + '%'; bar.style.background = done ? '#c62828' : COLOR[kind];
  }

  // ---- 1 コマ ----
  // 持ち時間 t までの線を描き、先頭の位置・向き・区間・距離を返す
  function draw(t) {
    const { P, K, T, D } = path, h = at(t, T), feats = [];
    let cur = null;
    for (let j = 0; j <= h.i; j++) {
      if (!cur || cur.kind !== K[j]) { cur = { kind: K[j], coords: [P[j]] }; feats.push(cur); }
      cur.coords.push(j < h.i ? P[j + 1] : h.p);
    }
    map.getSource('rt-anim').setData({ type: 'FeatureCollection', features: feats.filter(c => c.kind !== 'park' && c.coords.length > 1)
      .map(c => ({ type: 'Feature', properties: { kind: c.kind }, geometry: { type: 'LineString', coordinates: c.coords } })) });
    const kind = K[h.i], d = D[h.i] + (D[h.i + 1] - D[h.i]) * h.f;
    // 矢印の向き：駐車中は直前の向きを保つ。長さ 0 の区間は前後から探す
    let deg = arrow ? arrow.getRotation() : 0;
    for (let j = h.i; j < P.length - 1 && j < h.i + 50; j++) if (distM(P[j], P[j + 1]) > 0.5) { deg = bearing(P[j], P[j + 1]); break; }
    setArrow(h.p, deg, kind);
    return { p: h.p, kind, d };
  }
  // カメラが先頭を追う。向きは少し先の点への方位を、ズームは区間ごとの値を、なめらかに追いかける
  function camera(s, dt) {
    if (!follow) return;
    const ahead = at(Math.min(path.dist, s.d + LOOK_M), path.D).p;
    if (distM(s.p, ahead) > 1) camB += wrap(bearing(s.p, ahead) - camB) * (1 - Math.exp(-dt / 1200));
    camZ += (ZOOM - camZ) * (1 - Math.exp(-dt / 900));
    map.jumpTo({ center: s.p, bearing: camB, zoom: camZ, pitch: PITCH });
  }
  function enter(ph) {
    phase = ph;
    if (ph === 'intro') {
      follow = true;
      const s = draw(0), ahead = at(Math.min(path.dist, LOOK_M), path.D).p;
      camB = distM(s.p, ahead) > 1 ? bearing(s.p, ahead) : 0; camZ = ZOOM;
      map.easeTo({ center: s.p, bearing: camB, zoom: camZ, pitch: PITCH, duration: INTRO_MS * 0.9 });
    } else if (ph === 'hold' && follow) {
      map.fitBounds(path.bounds, { padding: getPad(), pitch: HOLD_PITCH, bearing: 0, duration: 1800 });
    }
  }
  function tick(now) {
    frame = 0;
    if (!running) return;
    const dt = lastNow ? Math.min(100, now - lastNow) : 16; lastNow = now;
    const RUN = path.runMs, ph = (now - t0) % (INTRO_MS + RUN + HOLD_MS);
    const next = ph < INTRO_MS ? 'intro' : ph < INTRO_MS + RUN ? 'run' : 'hold';
    if (next !== phase) enter(next);
    if (next === 'run') {
      const s = draw(path.total * (ph - INTRO_MS) / RUN);
      camera(s, dt); showMarks(s.d); setHud(s.kind, s.d, false);
    } else if (next === 'hold') {
      const s = draw(path.total); showMarks(path.dist); setHud(s.kind, path.dist, true);
    } else { showMarks(0); setHud(path.K[0], 0, false); }
    frame = requestAnimationFrame(tick);
  }

  // ---- 開始・停止 ----
  // 状態（チェックの有無・経路の有無・一時停止）に合わせて始める／止める。止めたら経路全体を真上から見る表示に戻す
  function update(instant) {
    if (!map || !map.getSource('rt-anim')) return;
    const run = on && !paused && !!path;
    STATIC.forEach(l => map.setPaintProperty(l, 'line-opacity', run ? DIM : 1));
    if (run && !running) { running = true; capTiles(true); t0 = performance.now(); phase = ''; lastNow = 0; frame = requestAnimationFrame(tick); }
    if (!run && running) {
      running = false; capTiles(false);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      map.getSource('rt-anim').setData({ type: 'FeatureCollection', features: [] });
      if (arrow) arrow.remove(); arrowOn = false;
      showMarks(0); setHud();
      const t3d = document.getElementById('t3d-on');
      const view = { pitch: t3d && t3d.checked ? map.getPitch() : 0, bearing: 0 };
      map.stop();
      if (path) map.fitBounds(path.bounds, { padding: getPad(), ...view, duration: instant ? 0 : 700 });
      else map.easeTo({ ...view, duration: instant ? 0 : 700 });
    }
  }
  // アニメーション中は、ラスタタイル（背景地図・一般記録・傾斜図）を 1 段粗いズームのものを拡大して使う。
  // たどる間のズーム（ZOOM）で本来使うタイルの 1/4 の枚数で済み、読み込み中のぼやけが減る。
  // 1 周目に読んだタイルは地図が覚えておくので（index.html の maxTileCacheZoomLevels）、2 周目以降は読み直さない。
  // source.maxzoom は MapLibre がタイルを選ぶたびに読む値（4.7.1 で確認）。止めたら元に戻す
  function capTiles(v) {
    if (v) {
      const st = map.getStyle().sources;
      capped = Object.keys(st).filter(id => st[id].type === 'raster').map(id => {
        const s = map.getSource(id), cap = Math.round(ZOOM + Math.log2(512 / (s.tileSize || 512))) - 1;  // 本来使うズームの 1 段下
        if (!(s.maxzoom > cap)) return null;
        const orig = s.maxzoom; s.maxzoom = cap;
        return [s, orig];
      }).filter(Boolean);
    } else { capped.forEach(([s, z]) => s.maxzoom = z); capped = []; }
    map.triggerRepaint();
  }
  const enable = v => { on = v; update(); };
  // PDF の地図画像を撮る間などに一時停止する（すぐに静止表示に戻す）
  const pause = p => { paused = p; update(true); };

  function init(m, pad) {
    map = m; getPad = pad;
    map.addSource('rt-anim', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const ak = k => ['==', ['get', 'kind'], k];
    const before = map.getLayer('rt-pt') ? 'rt-pt' : undefined;
    map.addLayer({ id: 'rt-anim-off', type: 'line', source: 'rt-anim', filter: ak('off'), paint: { 'line-color': COLOR.off, 'line-width': 3, 'line-dasharray': [1, 1.5] } }, before);
    map.addLayer({ id: 'rt-anim-steep', type: 'line', source: 'rt-anim', filter: ak('steep'), layout: { 'line-cap': 'round' }, paint: { 'line-color': COLOR.steep, 'line-width': 6 } }, before);
    map.addLayer({ id: 'rt-anim-casing', type: 'line', source: 'rt-anim', filter: ['in', ['get', 'kind'], ['literal', ['car', 'foot']]], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 9 } }, before);
    map.addLayer({ id: 'rt-anim-car', type: 'line', source: 'rt-anim', filter: ak('car'), layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': COLOR.car, 'line-width': 6 } }, before);
    map.addLayer({ id: 'rt-anim-foot', type: 'line', source: 'rt-anim', filter: ak('foot'), layout: { 'line-join': 'round' }, paint: { 'line-color': COLOR.foot, 'line-width': 6, 'line-dasharray': [1.2, 0.8] } }, before);
    // 人が地図を動かしたら、その周はカメラの追従をやめる（次の周でまた追う）
    ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'].forEach(ev => map.on(ev, e => { if (running && e.originalEvent) follow = false; }));
  }
  return { init, setPath, enable, pause, LAYERS };
})();
