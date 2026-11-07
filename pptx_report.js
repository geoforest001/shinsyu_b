// PowerPoint（.pptx）のレポート出力。PptxGenJS（index.html で CDN から読み込む）をブラウザ内で使い、
// 絞り込み結果（filter）とルート案内（route）のスライドを作ってダウンロードさせる。
// データは呼び出し側（index.html / route_report.js）が組み立てて渡す。
const ReportPptx = (() => {
  const FONT = 'Yu Gothic', W = 13.33, H = 7.5;
  const GREEN = '2E7D32', BLUE = '1565C0';
  const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o.length ? o : [[]]; };
  const natural = src => new Promise(ok => { const i = new Image(); i.onload = () => ok([i.naturalWidth, i.naturalHeight]); i.onerror = () => ok([4, 3]); i.src = src; });
  // SVG の文字列を PNG の data URL にする（断面図用）
  async function svgToPng(svgText, scale = 3) {
    const m = svgText.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/); if (!m) return null;
    const w = +m[1], h = +m[2];
    // 画面用の width="100%" と style（枠線など）を外して、画像にするための幅・高さを付ける
    const open = svgText.match(/<svg[^>]*>/)[0].replace(/\swidth="[^"]*"/, '').replace(/\sstyle="[^"]*"/, '');
    const svg = svgText.replace(/<svg[^>]*>/, open.replace('<svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"`));
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const img = await new Promise((ok, ng) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ng; i.src = url; });
      const cv = document.createElement('canvas'); cv.width = w * scale; cv.height = h * scale;
      const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/png');
    } catch (e) { return null; } finally { URL.revokeObjectURL(url); }
  }
  const deck = title => { const p = new PptxGenJS(); p.layout = 'LAYOUT_WIDE'; p.title = title; p.author = 'shinsyu_b'; return p; };
  function slide(p, title, color) {
    const s = p.addSlide();
    s.addShape(p.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.85, fill: { color }, line: { color } });
    s.addText(title, { x: 0.4, y: 0.1, w: W - 0.8, h: 0.65, fontFace: FONT, fontSize: 24, bold: true, color: 'FFFFFF', valign: 'middle' });
    return s;
  }
  const note = (s, text, y = H - 0.55) => s.addText(text, { x: 0.4, y, w: W - 0.8, h: 0.4, fontFace: FONT, fontSize: 10, color: '555555', valign: 'top' });
  async function fitImage(s, src, box) {
    const [bw, bh] = await natural(src), r = Math.min(box.w / bw, box.h / bh), w = bw * r, h = bh * r;
    s.addImage({ data: src, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h });
  }
  const C = (t, o = {}) => ({ text: String(t == null ? '' : t), options: { fontFace: FONT, fontSize: o.fs || 11, bold: !!o.bold, color: o.color || '222222', align: o.align || 'left', valign: 'middle',
    fill: o.fill ? { color: o.fill } : undefined } });
  const head = (cols, fs) => cols.map((t, i) => C(t, { bold: true, fill: 'EEEEEE', align: i === 0 ? 'left' : 'center', fs }));
  const table = (s, rows, o) => s.addTable(rows, { x: o.x ?? 0.4, y: o.y ?? 1.1, w: o.w ?? W - 0.8, colW: o.colW, rowH: o.rowH ?? 0.36, border: { type: 'solid', pt: 0.5, color: 'BBBBBB' }, fontFace: FONT, fontSize: o.fs || 11 });
  const spName = x => (x.ja ? x.ja + '（' + x.sci + '）' : x.sci);
  const save = (p, name) => p.writeFile({ fileName: name });
  const dateTag = () => { const d = new Date(); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); };

  // ---- 絞り込み結果 ----
  // rep: { ds, rows(features), conds[[ラベル,値]], img, byCity[[名前,{m,n,g,s}]], agg[], brk, use:{map,city,list,sp}, topNames(id,n) }
  async function filter(rep) {
    const p = deck('長野県 絶滅危惧種 分布レポート');
    const b = rep.brk;
    let s = p.addSlide();
    s.background = { color: 'F4F8F4' };
    s.addText('長野県 絶滅危惧種 分布レポート', { x: 0.6, y: 1.3, w: W - 1.2, h: 1, fontFace: FONT, fontSize: 38, bold: true, color: GREEN });
    s.addText(`作成日：${rep.ds}　／　該当 ${rep.rows.length} メッシュ（5km）`, { x: 0.6, y: 2.4, w: W - 1.2, h: 0.5, fontFace: FONT, fontSize: 18, color: '333333' });
    table(s, [head(['危惧種の記録（合計）', 'CR', 'EN', 'VU', '動物', '植物', '菌類', '一般記録（参考）']), [C(b.n, { align: 'center', fs: 16, bold: true }), ...[b.CR, b.EN, b.VU, b.animal, b.plant, b.fungus, b.gen].map(v => C(v, { align: 'center', fs: 16 }))]],
      { x: 0.6, y: 3.4, w: W - 1.2, rowH: 0.55, fs: 13, colW: [2.6, 1.2, 1.2, 1.2, 1.4, 1.4, 1.4, 2.13] });
    s.addText('出典：GBIF（gbif.org）、IUCNレッドリスト、国土地理院。希少種保護のため、位置は約5kmメッシュ単位までです。', { x: 0.6, y: 6.6, w: W - 1.2, h: 0.4, fontFace: FONT, fontSize: 11, color: '555555' });

    s = slide(p, '1. 抽出条件', GREEN);
    table(s, [head(['条件', '値']), ...rep.conds.map(([l, v]) => [C(l), C(v, { align: 'center' })])], { colW: [7.5, 5.03], rowH: 0.45, fs: 14 });

    if (rep.use.map && rep.img) {
      s = slide(p, '2. 該当メッシュの分布', GREEN);
      await fitImage(s, rep.img, { x: 0.4, y: 1.0, w: W - 0.8, h: H - 1.9 });
      note(s, '紫の枠＝条件に合うメッシュ。黄〜赤＝危惧種の記録数（1–4 / 5–19 / 20–59 / 60以上）。緑＝一般記録の密度（GBIF）。県外は白く表示。');
    }
    if (rep.use.city) chunk(rep.byCity, 12).forEach((part, i, all) => {
      s = slide(p, `3. 市町村別集計${all.length > 1 ? `（${i + 1}/${all.length}）` : ''}`, GREEN);
      table(s, [head(['市町村', 'メッシュ数', '危惧種 記録数', '一般記録数', '平均傾斜']), ...part.map(([n, c]) => [C(n), C(c.m, { align: 'right' }), C(c.n, { align: 'right' }), C(c.g, { align: 'right' }), C((c.s / c.m).toFixed(1) + '°', { align: 'right' })])],
        { colW: [4.2, 2, 2.4, 2, 1.93], rowH: 0.4, fs: 13 });
    });
    if (rep.use.sp && rep.agg.length) chunk(rep.agg, 11).slice(0, 4).forEach((part, i, all) => {
      s = slide(p, `4. 危惧種の種別集計${all.length > 1 ? `（${i + 1}/${all.length}）` : ''}`, GREEN);
      table(s, [head(['種名（和名・学名）', '区分', '出現メッシュ数', '記録数']), ...part.map(x => [C(spName(x), { fs: 12 }), C(x.cat, { align: 'center' }), C(x.meshes, { align: 'right' }), C(x.n, { align: 'right' })])],
        { colW: [7.2, 1.3, 2.2, 1.83], rowH: 0.42, fs: 12 });
      if (i === all.length - 1 && rep.agg.length > 44) note(s, `記録数の多い上位44種を表示（全 ${rep.agg.length} 種）。`);
      else note(s, '区分はGBIFが照合したIUCNの区分です。栽培・外来の記録や名前の対応の違いで、野生の希少種とは限らない種が混じることがあります。');
    });
    if (rep.use.list) chunk(rep.rows, 10).forEach((part, i, all) => {
      s = slide(p, `5. 該当メッシュ一覧（${i + 1}/${all.length}）`, GREEN);
      table(s, [head(['市町村', '緯度', '経度', '危惧種', '種数', '一般記録', '平均傾斜', '主な危惧種']), ...part.map(f => { const q = f.properties, c = f.geometry.coordinates[0];
        return [C(q.city, { fs: 11 }), C(((c[0][1] + c[2][1]) / 2).toFixed(3), { align: 'right', fs: 10 }), C(((c[0][0] + c[2][0]) / 2).toFixed(3), { align: 'right', fs: 10 }), C(q.n, { align: 'right', fs: 11 }), C(q.sp, { align: 'right', fs: 11 }),
          C(q.gen, { align: 'right', fs: 11 }), C(q.slope + '°', { align: 'right', fs: 11 }), C(rep.topNames(q.id, 5), { fs: 9 })]; })],
        { colW: [1.5, 0.95, 0.95, 0.85, 0.7, 1.0, 1.0, 5.58], rowH: 0.5, fs: 11 });
    });
    s = slide(p, '注意事項・出典', GREEN);
    s.addText([
      '・危惧種は IUCN レッドリスト CR/EN/VU の出現記録（GBIF）を約5kmメッシュに集計しています。希少種保護のため、個別の位置は掲載していません。',
      '・記録数は調査の多さを反映します。記録の多い場所が、必ずしも生き物の多い場所とは限りません。',
      '・一般記録数には危惧種の記録も含まれます。緯度経度はメッシュの中心、市町村は中心点の所在地です。',
      '・傾斜は国土地理院DEM10mから集計しました。',
      '・出典：GBIF（gbif.org）、国土地理院。',
    ].join('\n'), { x: 0.6, y: 1.2, w: W - 1.2, h: 5, fontFace: FONT, fontSize: 16, color: '222222', valign: 'top', paraSpaceAfter: 10 });
    await save(p, `分布レポート_${dateTag()}.pptx`);
  }

  // ---- ルート案内 ----
  // d: { ds, r(Route.result()), img, steps[[No,区間,手段,距離,時間,累計,備考]], notes{route[],general[]}, credits[], course(SVG文字列), species{along[],goal,general[]}|null, labels }
  async function route(d) {
    const r = d.r, p = deck('調査ルート案内');
    let s = p.addSlide();
    s.background = { color: 'F3F7FC' };
    s.addText('調査ルート案内', { x: 0.6, y: 1.2, w: W - 1.2, h: 1, fontFace: FONT, fontSize: 40, bold: true, color: BLUE });
    s.addText(`${d.labels.start} → ${d.labels.goal}`, { x: 0.6, y: 2.3, w: W - 1.2, h: 0.7, fontFace: FONT, fontSize: 24, color: '222222' });
    s.addText(`作成日時：${d.ds}　／　対象範囲：${r.area}`, { x: 0.6, y: 3.1, w: W - 1.2, h: 0.4, fontFace: FONT, fontSize: 14, color: '555555' });
    table(s, [head(['所要時間の目安', '車', '徒歩（道あり）', '道なし']), [C(d.total, { align: 'center', fs: 20, bold: true }), C(d.carText, { align: 'center', fs: 14 }), C(d.footText, { align: 'center', fs: 14 }), C(d.offText, { align: 'center', fs: 14 })]],
      { x: 0.6, y: 4.0, w: W - 1.2, rowH: 0.7, fs: 13, colW: [3.5, 2.9, 2.9, 2.93] });
    s.addText('経路と所要時間は本ツールが計算した目安です。林道は通行止めの場合があるため、入山前に管理者へ確認してください。', { x: 0.6, y: 6.5, w: W - 1.2, h: 0.5, fontFace: FONT, fontSize: 12, color: 'B71C1C' });

    if (d.img) { s = slide(p, '1. 経路図', BLUE); await fitImage(s, d.img, { x: 0.4, y: 1.0, w: W - 0.8, h: H - 1.4 }); }
    chunk(d.steps, 8).forEach((part, i, all) => {
      s = slide(p, `2. 行程表${all.length > 1 ? `（${i + 1}/${all.length}）` : ''}`, BLUE);
      table(s, [head(['No', '区間', '手段', '距離', '所要時間', '累計', '備考']), ...part.map(r2 => r2.map((t, k) => C(t, { fs: 11, align: k === 1 || k === 6 ? 'left' : 'center' })))],
        { colW: [0.6, 2.9, 1.2, 1.2, 1.4, 1.4, 3.83], rowH: 0.6, fs: 11 });
    });
    if (d.course) {
      const png = await svgToPng(d.course);
      if (png) { s = slide(p, '3. コース全体の断面図', BLUE); await fitImage(s, png, { x: 0.8, y: 1.0, w: W - 1.6, h: H - 2.0 }); note(s, d.courseNote || '標高は国土地理院DEM（橋・トンネルは地表の高さ）。'); }
    }
    if (d.species) {
      const sp = d.species;
      if (sp.along.length) chunk(sp.along, 9).forEach((part, i, all) => {
        s = slide(p, `4. ルート沿いの危惧種${all.length > 1 ? `（${i + 1}/${all.length}）` : ''}`, BLUE);
        table(s, [head(['市町村（メッシュ）', '危惧種 記録', '種数', '主な危惧種', '一般記録']), ...part.map(m => [C(m.city, { fs: 11 }), C(m.n, { align: 'right', fs: 11 }), C(m.sp, { align: 'right', fs: 11 }),
          C(m.species.slice(0, 6).map(x => x[1] || x[0]).join('、') || '—', { fs: 10 }), C(m.gen, { align: 'right', fs: 11 })])],
          { colW: [2.2, 1.3, 0.9, 6.5, 1.63], rowH: 0.52, fs: 11 });
        note(s, '経路が通る約5kmメッシュの集計です。経路上の位置を示すものではありません。希少種の生育・生息地では、踏み荒らしや採取をしないでください。');
      });
      if (sp.goal) {
        s = slide(p, '5. 目的地周辺（5kmメッシュ）の生き物', BLUE);
        s.addText(`${sp.goal.city}　危惧種 記録 ${sp.goal.n}・種数 ${sp.goal.sp}　／　一般記録 ${sp.goal.gen}`, { x: 0.4, y: 1.0, w: W - 0.8, h: 0.4, fontFace: FONT, fontSize: 14, bold: true, color: '222222' });
        s.addText('危惧種（CR/EN/VU）', { x: 0.4, y: 1.5, w: 6, h: 0.35, fontFace: FONT, fontSize: 13, bold: true, color: 'B71C1C' });
        table(s, [head(['種名', '区分', '記録']), ...sp.goal.species.slice(0, 10).map(x => [C(x[1] ? x[1] + '（' + x[0] + '）' : x[0], { fs: 9 }), C(x[3], { align: 'center', fs: 10 }), C(x[2], { align: 'right', fs: 10 })])],
          { x: 0.4, y: 1.9, w: 6.2, colW: [4.4, 0.8, 1.0], rowH: 0.38, fs: 10 });
        s.addText('一般（記録の多い上位10種）', { x: 6.9, y: 1.5, w: 6, h: 0.35, fontFace: FONT, fontSize: 13, bold: true, color: '1B5E20' });
        if (sp.general && sp.general.length) table(s, [head(['種名', '記録']), ...sp.general.map(x => [C(x.ja ? x.ja + '（' + x.sci + '）' : x.sci, { fs: 9 }), C(x.n, { align: 'right', fs: 10 })])],
          { x: 6.9, y: 1.9, w: 6.03, colW: [4.9, 1.13], rowH: 0.38, fs: 10 });
        else s.addText('（GBIF から取得できませんでした）', { x: 6.9, y: 1.9, w: 6, h: 0.4, fontFace: FONT, fontSize: 11, color: '777777' });
        note(s, '記録数は調査の多さを反映します。区分はGBIFが照合したIUCNの区分で、野生の希少種とは限らない種が混じることがあります。');
      }
    }
    s = slide(p, '注意事項', BLUE);
    s.addText([...d.notes.route.map(t => '【この経路】' + t), ...d.notes.general.map(t => '・' + t)].join('\n'),
      { x: 0.5, y: 1.1, w: W - 1, h: H - 1.4, fontFace: FONT, fontSize: 12, color: '222222', valign: 'top', paraSpaceAfter: 6, fit: 'shrink' });
    s = slide(p, 'クレジット・出典', BLUE);
    s.addText(d.credits.map(t => '・' + t).join('\n'), { x: 0.5, y: 1.1, w: W - 1, h: H - 1.4, fontFace: FONT, fontSize: 12, color: '222222', valign: 'top', paraSpaceAfter: 6, fit: 'shrink' });
    await save(p, `調査ルート案内_${dateTag()}.pptx`);
  }
  return { filter, route };
})();
