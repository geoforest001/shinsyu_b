// 傾斜図（ブラウザ内計算）
// 国土地理院の標高タイル（z≤14: dem_png = DEM10m 相当、z15: dem5a_png / dem5b_png = DEM5m）を読み、
// Horn 法（3×3）で傾斜角を求めて色を付ける。MapLibre の addProtocol で「slope://z/x/y」として配信する。
// 標高・傾斜の点読み（elevAt / slopeAt）はルート案内からも使う。
const Slope = (() => {
  const DEM_URL = {
    dem: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`,
    dem5a: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/${z}/${x}/${y}.png`,
    dem5b: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem5b_png/${z}/${x}/${y}.png`,
  };
  const MAX_DEM_Z = 15, R = 6378137;
  const N = 256, NA = 1 << 23;

  // ---- 色の付け方（傾斜 0.1°刻みの色表）----
  // stops: [上限の角度, 色, 名前]。色が null の区分は透明
  const MODES = {
    std: { name: '標準（7区分）', stops: [
      [3, '#f7fcb9', '0–3°（平坦）'], [8, '#d9f0a3', '3–8°'], [15, '#addd8e', '8–15°'], [20, '#78c679', '15–20°'],
      [30, '#fdae61', '20–30°'], [40, '#f46d43', '30–40°'], [91, '#a50026', '40°以上（急傾斜）']] },
    walk: { name: '歩きやすさ', stops: [
      [15, '#66bb6a', '0–15° 歩きやすい'], [30, '#ffca28', '15–30° 注意（足場に気をつける）'],
      [40, '#ef6c00', '30–40° 危険（滑落のおそれ）'], [91, '#6a1b9a', '40°以上 立ち入らない']] },
    over: { name: '指定した角度以上を強調', stops: null },
  };
  let mode = 'std', overDeg = 30, lut = null, version = 0;
  const hex = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const stops = () => mode === 'over'
    ? [[overDeg, null, `${overDeg}°未満`], [overDeg + 10, '#ef6c00', `${overDeg}–${overDeg + 10}°`], [91, '#b71c1c', `${overDeg + 10}°以上`]]
    : MODES[mode].stops;
  function buildLut() {
    lut = new Uint8ClampedArray(901 * 4);
    const st = stops();
    for (let i = 0; i <= 900; i++) {
      const deg = i / 10, s = st.find(t => deg < t[0]) || st[st.length - 1];
      if (s[1]) { const [r, g, b] = hex(s[1]); lut.set([r, g, b, 255], i * 4); }
    }
  }
  buildLut();

  // ---- 標高タイルの取得・デコード（Float32Array、欠測は NaN）----
  const cache = new Map();  // key -> Promise<Float32Array|null>
  const CACHE_MAX = 400;
  const remember = (k, p) => {
    cache.set(k, p);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return p;
  };
  let cv = null;
  async function fetchPng(url) {
    const r = await fetch(url);
    if (!r.ok) return null;  // 404 = 海などデータのない所
    const bmp = await createImageBitmap(await r.blob());
    if (!cv) { cv = document.createElement('canvas'); cv.width = cv.height = N; }
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, N, N); ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, N, N).data, h = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const x = (px[4 * i] << 16) | (px[4 * i + 1] << 8) | px[4 * i + 2];
      h[i] = x === NA ? NaN : (x < NA ? x : x - (1 << 24)) * 0.01;
    }
    return h;
  }
  // z15 は 5m（航空レーザ dem5a → 写真測量 dem5b）を使い、欠けている画素は z14 を拡大して埋める
  function dem(z, x, y) {
    const k = `${z}/${x}/${y}`;
    if (cache.has(k)) { const p = cache.get(k); cache.delete(k); cache.set(k, p); return p; }
    const n = 2 ** z;
    if (y < 0 || y >= n) return Promise.resolve(null);
    x = ((x % n) + n) % n;
    if (z <= 14) return remember(k, fetchPng(DEM_URL.dem(z, x, y)).catch(() => null));
    return remember(k, (async () => {
      const parent = await dem(14, x >> 1, y >> 1);
      let h = null;
      if (parent) {
        h = new Float32Array(N * N);
        const ox = (x & 1) * 128, oy = (y & 1) * 128;
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          const fx = Math.min(254.999, Math.max(0, ox + (i + 0.5) / 2 - 0.5)), fy = Math.min(254.999, Math.max(0, oy + (j + 0.5) / 2 - 0.5));
          const X = fx | 0, Y = fy | 0, tx = fx - X, ty = fy - Y, b = Y * N + X;
          h[j * N + i] = (parent[b] * (1 - tx) + parent[b + 1] * tx) * (1 - ty) + (parent[b + N] * (1 - tx) + parent[b + N + 1] * tx) * ty;
        }
      }
      // 優先順位: dem5a > dem5b > z14 の拡大
      const done = new Uint8Array(N * N);
      for (const src of ['dem5a', 'dem5b']) {
        const f = await fetchPng(DEM_URL[src](z, x, y)).catch(() => null);
        if (!f) continue;
        if (!h) h = new Float32Array(N * N).fill(NaN);
        let left = 0;
        for (let i = 0; i < N * N; i++) {
          if (!done[i] && !isNaN(f[i])) { h[i] = f[i]; done[i] = 1; }
          if (!done[i]) left++;
        }
        if (!left) break;  // 5m で全部埋まったら dem5b は不要
      }
      return h;
    })());
  }

  // ---- 傾斜の計算（Horn 法）----
  // h(i, j): タイル内外の画素の標高。周りの8タイルを使い、端の画素も正しく計算する
  const mpp = (z, y, j) => {  // 画素の地上距離（m）
    const n = Math.PI - 2 * Math.PI * (y * N + j + 0.5) / (N * 2 ** z);
    return 2 * Math.PI * R * Math.cos(Math.atan(Math.sinh(n))) / (N * 2 ** z);
  };
  function computeSlope(z, y, nb) {
    const c = nb[4], out = new Float32Array(N * N);
    const h = (i, j) => {
      const tx = i < 0 ? 0 : i >= N ? 2 : 1, ty = j < 0 ? 0 : j >= N ? 2 : 1;
      let t = nb[ty * 3 + tx];
      if (!t) t = c, i = Math.min(N - 1, Math.max(0, i)), j = Math.min(N - 1, Math.max(0, j));
      else i = (i + N) % N, j = (j + N) % N;
      const v = t[j * N + i];
      return isNaN(v) ? c[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))] : v;
    };
    for (let j = 0; j < N; j++) {
      const d = mpp(z, y, j) * 8;
      for (let i = 0; i < N; i++) {
        if (isNaN(c[j * N + i])) { out[j * N + i] = NaN; continue; }
        const a = h(i - 1, j - 1), b = h(i, j - 1), cc = h(i + 1, j - 1);
        const dd = h(i - 1, j), f = h(i + 1, j);
        const g = h(i - 1, j + 1), hh = h(i, j + 1), k = h(i + 1, j + 1);
        const dx = ((cc + 2 * f + k) - (a + 2 * dd + g)) / d, dy = ((g + 2 * hh + k) - (a + 2 * b + cc)) / d;
        out[j * N + i] = Math.atan(Math.hypot(dx, dy)) * 180 / Math.PI;
      }
    }
    return out;
  }
  const slopeCache = new Map();
  async function slopeTile(z, x, y) {
    const k = `${z}/${x}/${y}`;
    if (slopeCache.has(k)) return slopeCache.get(k);
    const nb = await Promise.all([-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx => dem(z, x + dx, y + dy))));
    const s = nb[4] ? computeSlope(z, y, nb) : null;
    slopeCache.set(k, s);
    if (slopeCache.size > 120) slopeCache.delete(slopeCache.keys().next().value);
    return s;
  }
  let outCv = null;
  async function render(z, x, y) {
    const s = await slopeTile(z, x, y);
    if (!outCv) { outCv = document.createElement('canvas'); outCv.width = outCv.height = N; }
    const ctx = outCv.getContext('2d'), img = ctx.createImageData(N, N);
    if (s) for (let i = 0; i < N * N; i++) {
      if (isNaN(s[i])) continue;
      const q = Math.min(900, Math.round(s[i] * 10)) * 4;
      img.data[4 * i] = lut[q]; img.data[4 * i + 1] = lut[q + 1]; img.data[4 * i + 2] = lut[q + 2]; img.data[4 * i + 3] = lut[q + 3];
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise(r => outCv.toBlob(r, 'image/png'));
    return blob.arrayBuffer();
  }
  maplibregl.addProtocol('slope', async params => {
    const m = params.url.match(/^slope:\/\/(\d+)\/(\d+)\/(\d+)/);
    return { data: await render(+m[1], +m[2], +m[3]) };
  });

  // ---- 点読み（z14 = DEM10m）----
  const Z = 14;
  const gpx = (ll, z = Z) => {
    const n = N * 2 ** z, s = Math.sin(ll[1] * Math.PI / 180);
    return [(ll[0] + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  };
  const ready = new Map();  // 読み込み済みの z14 タイル（同期で読むため）
  // 線や範囲を通るタイルを先読みする。以後 elevAt / slopeAt が同期で使える
  async function prefetch(bounds) {  // [[西, 南], [東, 北]]
    const [x0, y0] = gpx([bounds[0][0], bounds[1][1]]).map(v => Math.floor(v / N) - 1);
    const [x1, y1] = gpx([bounds[1][0], bounds[0][1]]).map(v => Math.floor(v / N) + 1);
    const jobs = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = `${x}/${y}`;
      if (!ready.has(k)) jobs.push(dem(Z, x, y).then(t => ready.set(k, t)));
    }
    await Promise.all(jobs);
  }
  const px = (X, Y) => { const t = ready.get(`${X >> 8}/${Y >> 8}`); return t ? t[(Y & 255) * N + (X & 255)] : NaN; };
  function elevAt(ll) {
    let [fx, fy] = gpx(ll); fx -= 0.5; fy -= 0.5;
    const X = Math.floor(fx), Y = Math.floor(fy), tx = fx - X, ty = fy - Y;
    const v = [px(X, Y), px(X + 1, Y), px(X, Y + 1), px(X + 1, Y + 1)];
    if (v.some(isNaN)) { const ok = v.filter(h => !isNaN(h)); return ok.length ? ok.reduce((a, b) => a + b) / ok.length : NaN; }
    return (v[0] * (1 - tx) + v[1] * tx) * (1 - ty) + (v[2] * (1 - tx) + v[3] * tx) * ty;
  }
  function slopeAt(ll) {
    const [fx, fy] = gpx(ll), X = Math.floor(fx), Y = Math.floor(fy);
    const h = (i, j) => { const v = px(X + i, Y + j); return isNaN(v) ? px(X, Y) : v; };
    const d = mpp(Z, 0, Y) * 8;
    const dx = ((h(1, -1) + 2 * h(1, 0) + h(1, 1)) - (h(-1, -1) + 2 * h(-1, 0) + h(-1, 1))) / d;
    const dy = ((h(-1, 1) + 2 * h(0, 1) + h(1, 1)) - (h(-1, -1) + 2 * h(0, -1) + h(1, -1))) / d;
    return Math.atan(Math.hypot(dx, dy)) * 180 / Math.PI;
  }
  // 1点だけ読む（ポップアップ用）
  async function pointInfo(ll) {
    await prefetch([ll, ll]);
    const e = elevAt(ll);
    return isNaN(e) ? null : { elev: e, slope: slopeAt(ll) };
  }

  // ---- 設定 ----
  const setMode = (m, deg) => { mode = m; if (deg != null) overDeg = deg; buildLut(); version++; };
  const legendHtml = () => `<b>傾斜（${MODES[mode].name}）</b>` +
    stops().map(s => `<div><i style="background:${s[1] || 'transparent'};${s[1] ? '' : 'border:1px solid #bbb;box-sizing:border-box'}"></i>${s[2]}</div>`).join('');
  return {
    MODES, MAX_DEM_Z, setMode, legendHtml, prefetch, elevAt, slopeAt, pointInfo,
    tileUrl: () => `slope://{z}/{x}/{y}?v=${version}`,
    get mode() { return mode; },
  };
})();
