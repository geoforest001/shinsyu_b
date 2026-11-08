// メッシュの情報（絶滅危惧種の種名、経路が通るメッシュ、危惧種の内訳、一般種の取得）。
// index.html が grid（data/grid_nagano.geojson）と rare（data/rare_species.json）を set() で渡す。
// PDF・PowerPoint のレポート（絞り込み結果／ルート案内）が使う。
const MeshInfo = (() => {
  const S = 0.05;
  let grid = null, rare = {}, byId = new Map(), label = '環境省・長野県のレッドリスト';
  const set = o => {
    if (o.grid) { grid = o.grid; byId = new Map(grid.features.map(f => [f.properties.id, f])); }
    if (o.rare) rare = o.rare;
    if (o.label) label = o.label;
  };
  const ready = () => !!grid;
  const idAt = ll => `${Math.floor(ll[1] / S + 1e-9)}_${Math.floor(ll[0] / S + 1e-9)}`;
  const distM = (a, b) => Math.hypot((a[0] - b[0]) * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180), a[1] - b[1]) * 111320;
  const SEV = { I: 0, VU: 1, NT: 2, DD: 3 };

  // メッシュ1つぶんの情報（危惧種の種名つき）
  const info = f => { const p = f.properties; return { id: p.id, city: p.city, n: p.n, sp: p.sp, gen: p.gen, slope: p.slope, steep: p.steep, I: p.I, VU: p.VU, NT: p.NT, DD: p.DD,
    animal: p['動物'], plant: p['植物'], fungus: p['菌類'], species: rare[p.id] || [] }; };
  const forId = id => { const f = byId.get(id); return f ? info(f) : null; };

  // 経路（座標の並び）が通るメッシュを、通る順に返す。長い辺で飛ばさないよう約400mごとに点を補う
  function forPath(lls) {
    const seen = new Set(), out = [];
    const add = ll => { const id = idAt(ll); if (seen.has(id)) return; seen.add(id); const m = forId(id); if (m) out.push(m); };
    lls.forEach((q, i) => {
      if (i) { const p = lls[i - 1], L = distM(p, q), n = Math.max(1, Math.ceil(L / 400));
        for (let k = 1; k < n; k++) add([p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n]); }
      add(q);
    });
    return out;
  }

  // 複数メッシュの危惧種を、種ごとに集計する（出現メッシュ数・記録数、区分は最も重いもの）
  function agg(features) {
    const m = new Map();
    features.forEach(f => (rare[f.properties.id] || []).forEach(([sci, ja, n, cat]) => {
      const e = m.get(sci) || { sci, ja, cat, meshes: 0, n: 0 };
      e.meshes++; e.n += n; if (SEV[cat] < SEV[e.cat]) e.cat = cat; m.set(sci, e);
    }));
    return [...m.values()].sort((a, b) => b.n - a.n);
  }
  // 区分別（Ⅰ類/Ⅱ類/NT/DD）・分類群別（動物/植物/菌類）の記録数の合計
  function breakdown(features) {
    const b = { I: 0, VU: 0, NT: 0, DD: 0, animal: 0, plant: 0, fungus: 0, n: 0, gen: 0 };
    features.forEach(f => { const p = f.properties; b.I += p.I; b.VU += p.VU; b.NT += p.NT; b.DD += p.DD;
      b.animal += p['動物']; b.plant += p['植物']; b.fungus += p['菌類']; b.n += p.n; b.gen += p.gen; });
    return b;
  }

  // ---- 一般の種（GBIF からその場で取得）----
  const JPRE = /[ぁ-んァ-ヶ一-龥]/, cache = new Map();
  function speciesName(key) {
    if (cache.has(key)) return cache.get(key);
    const pr = (async () => {
      try {
        const d = await (await fetch(`https://api.gbif.org/v1/species/${key}`)).json();
        let ja = '';
        try {
          const v = await (await fetch(`https://api.gbif.org/v1/species/${key}/vernacularNames?limit=200`)).json();
          const c = v.results.filter(x => x.language === 'jpn' && JPRE.test(x.vernacularName)).map(x => x.vernacularName);
          ja = c.find(x => /^[ァ-ヶー・]+$/.test(x)) || c[0] || '';
        } catch (e) { /* 和名なし */ }
        return [d.canonicalName || d.scientificName || String(key), ja];
      } catch (e) { return [String(key), '']; }
    })();
    cache.set(key, pr); return pr;
  }
  const poly = id => { const [a, b] = id.split('_').map(Number), x0 = b * S, y0 = a * S, x1 = x0 + S, y1 = y0 + S, f = v => v.toFixed(4);
    return `POLYGON((${f(x0)} ${f(y0)},${f(x1)} ${f(y0)},${f(x1)} ${f(y1)},${f(x0)} ${f(y1)},${f(x0)} ${f(y0)}))`; };
  // メッシュの記録が多い順の上位 n 種。[{ sci, ja, n }]。取得できなければ null
  async function generalTop(id, taxonKey, n = 10) {
    try {
      const q = new URLSearchParams({ country: 'JP', geometry: poly(id), hasCoordinate: 'true', hasGeospatialIssue: 'false', limit: 0, facet: 'speciesKey', facetLimit: n });
      if (taxonKey) q.set('taxonKey', taxonKey);
      const d = await (await fetch('https://api.gbif.org/v1/occurrence/search?' + q)).json();
      const cs = d.facets && d.facets[0] ? d.facets[0].counts : [];
      const nm = await Promise.all(cs.map(c => speciesName(c.name)));
      return cs.map((c, i) => ({ sci: nm[i][0], ja: nm[i][1], n: c.count }));
    } catch (e) { return null; }
  }
  const catName = c => ({ I: 'Ⅰ類', VU: 'Ⅱ類', NT: 'NT', DD: 'DD' }[c] || c);
  return { set, catName, label: () => label, ready, idAt, forId, forPath, agg, breakdown, generalTop };
})();
