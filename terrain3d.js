// 3D表示（試作）。国土地理院の標高タイル(dem_png)を MapLibre の raster-dem(terrarium)に変換して配信し、
// map.setTerrain で地形を立体にする。重ねたレイヤ（危惧種メッシュ・傾斜区分図など）は地形に沿って貼られる。
// index.html の map（const）を使うため、ページの load 後に初期化する。
const T3D = (() => {
  const N = 256, ZMAX = 14;
  const URL_DEM = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`;
  let cv = null;
  const encode = h => {  // 標高(m) → terrarium の RGB
    const v = Math.round((h + 32768) * 256);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  async function tile(z, x, y) {
    if (!cv) { cv = document.createElement('canvas'); cv.width = cv.height = N; }
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const out = ctx.createImageData(N, N);
    let src = null;
    try {
      const r = await fetch(URL_DEM(z, x, y));
      if (r.ok) src = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    } catch (e) { /* 取得できない所は 0m にする */ }
    let data = null;
    if (src) { ctx.clearRect(0, 0, N, N); ctx.drawImage(src, 0, 0); data = ctx.getImageData(0, 0, N, N).data; }
    const flat = encode(0);
    for (let i = 0; i < N * N; i++) {
      let rgb = flat;
      if (data && data[4 * i + 3] > 0) {
        const q = data[4 * i] * 65536 + data[4 * i + 1] * 256 + data[4 * i + 2];  // 国土地理院: 0.01m 単位、2^23 は無効値
        if (q < 8388608) rgb = encode(q * 0.01); else if (q > 8388608) rgb = encode((q - 16777216) * 0.01);
      }
      out.data[4 * i] = rgb[0]; out.data[4 * i + 1] = rgb[1]; out.data[4 * i + 2] = rgb[2]; out.data[4 * i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    return (await new Promise(r => cv.toBlob(r, 'image/png'))).arrayBuffer();
  }
  maplibregl.addProtocol('gsidem', async params => {
    const m = params.url.match(/^gsidem:\/\/(\d+)\/(\d+)\/(\d+)/);
    return { data: await tile(+m[1], +m[2], +m[3]) };
  });

  let map = null, on = false, saved = null;
  const $ = id => document.getElementById(id);
  function ensureSource() {
    if (map.getSource('dem3d')) return;
    map.addSource('dem3d', { type: 'raster-dem', tiles: ['gsidem://{z}/{x}/{y}'], tileSize: N, maxzoom: ZMAX, encoding: 'terrarium',
      attribution: '標高: 国土地理院' });
    // 陰影（3Dでは地形の凹凸が見えやすくなる）。最背面の地図の上、他のレイヤの下
    const before = map.getLayer('gen') ? 'gen' : (map.getLayer('slope') ? 'slope' : undefined);
    map.addLayer({ id: 'hs3d', type: 'hillshade', source: 'dem3d', layout: { visibility: 'none' },
      paint: { 'hillshade-exaggeration': 0.5, 'hillshade-shadow-color': '#3a3a3a', 'hillshade-highlight-color': '#ffffff', 'hillshade-illumination-direction': 315 } }, before);
  }
  function set(v) {
    on = v; ensureSource();
    if (v) {
      map.setTerrain({ source: 'dem3d', exaggeration: +$('t3d-ex').value });
      map.setLayoutProperty('hs3d', 'visibility', 'visible');
      map.setMaxPitch(80);
      if (map.getPitch() < 30) map.easeTo({ pitch: 60, bearing: -20, duration: 900 });
    } else {
      map.setTerrain(null);
      map.setLayoutProperty('hs3d', 'visibility', 'none');
      map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
    }
    $('t3d-opts').style.display = v ? 'block' : 'none';
  }
  // PDFレポートの地図画像用：地図を真上から見た状態にして、終わったら元に戻す
  function suspend() {
    if (!on) return null;
    saved = { pitch: map.getPitch(), bearing: map.getBearing() };
    map.setTerrain(null); map.setLayoutProperty('hs3d', 'visibility', 'none'); map.jumpTo({ pitch: 0, bearing: 0 });
    return saved;
  }
  function resume(s) {
    if (!s) return;
    map.setTerrain({ source: 'dem3d', exaggeration: +$('t3d-ex').value });
    map.setLayoutProperty('hs3d', 'visibility', 'visible');
    map.jumpTo({ pitch: s.pitch, bearing: s.bearing });
  }
  function init(m) {
    map = m;
    const panel = document.querySelector('#panel .sec');
    if (!panel) return;
    panel.insertAdjacentHTML('afterend', `<div class="sec" style="border-top:0;margin-top:0;padding-top:0">
      <label><input type="checkbox" id="t3d-on"> <b>3D表示</b>（試作）</label>
      <div id="t3d-opts" style="display:none">
        地形の強調：<b id="t3d-exv">1.5</b>倍<br>
        <input type="range" id="t3d-ex" min="1" max="3" step="0.5" value="1.5" style="width:100%"><br>
        <small>右ボタンのドラッグ（Macは Control＋ドラッグ）で傾き・向きを変えられます。ズームすると細かくなります。</small>
      </div>
    </div>`);
    $('t3d-on').onchange = e => set(e.target.checked);
    $('t3d-ex').oninput = e => { $('t3d-exv').textContent = e.target.value; if (on) map.setTerrain({ source: 'dem3d', exaggeration: +e.target.value }); };
  }
  return { init, suspend, resume };
})();
window.addEventListener('load', () => {
  // index.html の読み込み処理がレイヤを足し終わる（mask ができる）のを待つ
  const wait = () => (map.getLayer && map.getLayer('mask')) ? T3D.init(map) : setTimeout(wait, 200);
  wait();
});
