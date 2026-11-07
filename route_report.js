// 調査ルート案内の PDF レポート
// Route.result()（route.js が直近の経路を保存したもの）から印刷用の HTML を新しいタブに作り、印刷ダイアログを開く。
// 地図画像は、地図を経路全体に合わせて canvas を写し、出発地・目的地・縮尺・方位・クレジットを描き足す。
// map（index.html）と T3D（terrain3d.js）はグローバル。
const RouteReport = (() => {
  const esc = t => String(t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const km = m => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
  const mins = s => s < 3600 ? Math.round(s / 60) + ' 分' : Math.floor(s / 3600) + ' 時間 ' + Math.round(s % 3600 / 60) + ' 分';
  const llText = ll => `北緯 ${ll[1].toFixed(5)}° 東経 ${ll[0].toFixed(5)}°`;
  const visible = id => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none';
  const distM = (a, b) => {
    const k = Math.cos((a[1] + b[1]) / 2 * Math.PI / 180);
    return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320;
  };

  // ---- 地図画像 ----
  function pin(ctx, x, y, color, text, s) {
    ctx.beginPath(); ctx.arc(x, y, 11 * s, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 2.5 * s; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${12 * s}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5 * s);
  }
  function scaleBar(ctx, s, h) {
    // 地図の中央で 1 CSS ピクセルあたりの距離を測り、120px 前後のきりのよい長さにする
    const c = map.getCanvas(), cx = c.clientWidth / 2, cy = c.clientHeight / 2;
    const a = map.unproject([cx - 50, cy]), b = map.unproject([cx + 50, cy]);
    const mpp = distM([a.lng, a.lat], [b.lng, b.lat]) / 100;
    const raw = mpp * 120, p10 = Math.pow(10, Math.floor(Math.log10(raw)));
    const len = [1, 2, 5, 10].map(k => k * p10).filter(v => v <= raw).pop();
    const w = len / mpp * s, x = 14 * s, y = h - 18 * s;
    ctx.fillStyle = '#ffffffd0'; ctx.fillRect(x - 6 * s, y - 20 * s, w + 12 * s, 28 * s);
    ctx.strokeStyle = '#222'; ctx.lineWidth = 2 * s;
    ctx.beginPath(); ctx.moveTo(x, y - 5 * s); ctx.lineTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y - 5 * s); ctx.stroke();
    ctx.fillStyle = '#222'; ctx.font = `${11 * s}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(len >= 1000 ? len / 1000 + ' km' : len + ' m', x, y - 8 * s);
  }
  function north(ctx, s, w) {
    const x = w - 24 * s, y = 34 * s;
    ctx.fillStyle = '#ffffffd0'; ctx.beginPath(); ctx.arc(x, y - 4 * s, 17 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#222'; ctx.beginPath(); ctx.moveTo(x, y - 18 * s); ctx.lineTo(x + 7 * s, y + 2 * s); ctx.lineTo(x, y - 3 * s); ctx.lineTo(x - 7 * s, y + 2 * s); ctx.closePath(); ctx.fill();
    ctx.font = `bold ${10 * s}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText('N', x, y + 12 * s);
  }
  // 撮影中だけ隠すレイヤ（絶滅危惧種のメッシュ・条件に合うメッシュ・選択中のメッシュ）。経路を見やすくするため
  const HIDE = ['mesh', 'ov-fill', 'ov-line', 'sel-line'];
  async function capture(r) {
    const prev = { c: map.getCenter(), z: map.getZoom() };
    const t3 = T3D.suspend();
    Route.pauseAnim(true);  // 撮影中はアニメーションを止め、経路全体を表示する
    const hidden = HIDE.filter(visible);
    hidden.forEach(id => map.setLayoutProperty(id, 'visibility', 'none'));
    document.querySelectorAll('.maplibregl-popup').forEach(x => x.remove());
    map.fitBounds(r.bounds, { padding: 60, maxZoom: 16, duration: 0 });
    await new Promise(ok => { map.once('idle', ok); setTimeout(ok, 10000); map.triggerRepaint(); });
    let img = '';
    try {
      const cv = map.getCanvas(), s = cv.width / cv.clientWidth;
      const o = document.createElement('canvas'); o.width = cv.width; o.height = cv.height;
      const ctx = o.getContext('2d');
      ctx.drawImage(cv, 0, 0);
      // 出発地・目的地のピンは HTML のマーカーで canvas に写らないので描き足す。駐車地点には P の字を重ねる
      const at = ll => { const p = map.project(ll); return [p.x * s, p.y * s]; };
      if (r.park) pin(ctx, ...at(r.park), '#ff6f00', 'P', s);
      pin(ctx, ...at(r.start.ll), '#1565c0', 'S', s);
      pin(ctx, ...at(r.goal.ll), '#c62828', 'G', s);
      scaleBar(ctx, s, o.height);
      north(ctx, s, o.width);
      const credit = '経路: © OpenStreetMap contributors' + (document.getElementById('base').value === 'white' ? '' : ' ／ 背景: 地理院タイル');
      ctx.font = `${10 * s}px sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      const tw = ctx.measureText(credit).width;
      ctx.fillStyle = '#ffffffd0'; ctx.fillRect(o.width - tw - 10 * s, o.height - 17 * s, tw + 10 * s, 17 * s);
      ctx.fillStyle = '#333'; ctx.fillText(credit, o.width - 5 * s, o.height - 5 * s);
      img = o.toDataURL('image/jpeg', 0.88);
    } catch (e) { img = ''; }
    hidden.forEach(id => map.setLayoutProperty(id, 'visibility', 'visible'));
    Route.pauseAnim(false);
    T3D.resume(t3);
    map.jumpTo({ center: prev.c, zoom: prev.z });
    return img;
  }

  // ---- 行程表 ----
  function steps(r) {
    const rows = [];
    let t = 0;
    const add = (no, name, mode, dist, sec, note, count = true) => {
      if (count) t += sec;
      rows.push(`<tr><td>${no}</td><td class="l">${name}</td><td>${mode}</td><td>${dist}</td><td>${count ? mins(sec) : '—'}</td><td>${mins(t)}</td><td class="l">${note}</td></tr>`);
    };
    let n = 1;
    rows.push(`<tr class="pt"><td>S</td><td class="l">出発地</td><td colspan="4"></td><td class="l">${esc(r.start.label)}<br><small>${llText(r.start.ll)}</small></td></tr>`);
    if (r.snapM >= 1) add(n++, '出発地 → 最寄りの道', '直線表示', km(r.snapM), 0, '所要時間に含めていません', false);
    add(n++, '車で移動', '車', km(r.car.m), r.car.sec, r.car.trackM ? `うち林道・農道 ${km(r.car.trackM)}` : '');
    if (r.park) add(n++, '駐車・身支度', '—', '', r.parkSec, `駐車地点（P）：${llText(r.park)}`);
    if (r.foot.m >= 1) add(n++, '道を歩く', '徒歩', km(r.foot.m), r.foot.sec, '登山道・林道・小道など');
    if (r.off.m >= 1) add(n++, '道のない区間を歩く', '道なし', km(r.off.m), r.off.sec,
      `時速 ${r.offKmh} km を基準に勾配・斜面で補正` + (r.off.steepM >= 1 ? `<br><b class="warn">${r.steepDeg}°以上の急斜面 ${km(r.off.steepM)}（最大 ${Math.round(r.off.maxDeg)}°）</b>` : ''));
    rows.push(`<tr class="pt"><td>G</td><td class="l">目的地 到着</td><td colspan="3"></td><td><b>${mins(t)}</b></td><td class="l">${esc(r.goal.label)}<br><small>${llText(r.goal.ll)}${isNaN(r.goal.elev) ? '' : `・標高 約 ${Math.round(r.goal.elev)} m`}</small></td></tr>`);
    return rows.join('');
  }

  // ---- 注意事項（この経路に当てはまるもの → 一般的なもの）----
  function notes(r) {
    const route = [];
    if (r.car.trackM) route.push(`経路に林道・農道が ${km(r.car.trackM)} 含まれます。ゲート閉鎖・通行止め・一般車通行禁止のことがあるため、事前に管理者（市町村・森林管理署など）へ通行できるか確認してください。路肩の崩落や落石にも注意してください。`);
    if (r.park) route.push('駐車地点（P）は道路データ上の点です。実際に駐車できる場所とは限りません。通行や作業の妨げにならない場所に停めてください。');
    if (r.off.m >= 1) route.push(`目的地の手前 ${km(r.off.m)} は道がなく、地図上では直線で示しています。実際には沢・崖・藪を避けて歩く必要があり、直線どおりには進めないことがあります。`);
    if (r.off.steepM >= 1) route.push(`<b class="warn">道のない区間に ${r.steepDeg}° 以上の急斜面が ${km(r.off.steepM)} あります（最大 ${Math.round(r.off.maxDeg)}°、地図の赤い線）。</b>滑落・落石のおそれがあります。迂回できないか現地で判断し、無理な場合は引き返してください。`);
    if (r.snapM >= 50) route.push(`出発地から最寄りの道まで ${km(r.snapM)} 離れています。この区間は直線で表示しており、所要時間に含めていません。`);
    if (!r.hasTob) route.push('この道路データには登り下りの情報がないため、道のある徒歩区間は平地として計算しています。');
    const general = [
      '所要時間は目安です。休憩・調査の時間は含みません。路面状況・積雪・藪の濃さ・渋滞も考慮していません。日没までに戻れる計画を立ててください。',
      '道路・登山道のデータ（OpenStreetMap）は有志が作成したもので、現地の状況と異なることや、廃道・通行できない道が含まれることがあります。最新の地形図や現地の案内で確認してください。',
      '私有地・立入禁止区域・自然公園の特別保護地区などに入る場合は、所有者や管理者の許可が必要です。',
      '希少種の生育・生息地では、踏み荒らしや採取をしないでください。位置情報の扱いにも注意してください。',
      '山間部では携帯電話がつながらないことがあります。単独行動を避け、行き先と帰着予定を家族や所属先に伝えてください（必要に応じて登山届を出してください）。',
      'クマ・ハチ・マダニなどへの対策、天候の急変への備え（雨具・防寒着・ライト）をしてください。',
    ];
    return { route, general };
  }

  // ---- 凡例 ----
  function legend() {
    const line = (style, label) => `<span><svg width="34" height="10"><line x1="2" y1="5" x2="32" y2="5" ${style}/></svg>${label}</span>`;
    const dot = (c, t, label) => `<span><b class="dot" style="background:${c}">${t}</b>${label}</span>`;
    let h = `<div class="legend">
      ${line('stroke="#1565c0" stroke-width="5" stroke-linecap="round"', '車')}
      ${line('stroke="#2e7d32" stroke-width="5" stroke-dasharray="6 4"', '徒歩（道あり）')}
      ${line('stroke="#616161" stroke-width="2.5" stroke-dasharray="2.5 3.5"', '道なし（直線）')}
      ${line('stroke="#d32f2f" stroke-width="5" stroke-linecap="round"', `急斜面（${Route.result().steepDeg}°以上）`)}
      ${dot('#1565c0', 'S', '出発地')} ${dot('#c62828', 'G', '目的地')} ${dot('#ff6f00', 'P', '駐車地点')}
      ${line('stroke="#1565c0" stroke-width="1.5" stroke-dasharray="4 2"', `対象範囲（${Route.AREA_NAME}）`)}
    </div>`;
    if (visible('rt-net')) h += `<div class="legend"><small>道路網：</small>
      ${line('stroke="#ef6c00" stroke-width="2"', '国道')} ${line('stroke="#f9a825" stroke-width="2"', '県道など')}
      ${line('stroke="#9e9e9e" stroke-width="2"', '一般道')} ${line('stroke="#795548" stroke-width="1.6"', '林道・農道')}
      ${line('stroke="#2e7d32" stroke-width="1.3" stroke-dasharray="4 3"', '登山道・歩道')}</div>`;
    if (visible('slope') || visible('slope-live')) h += `<div class="legend slope">${Slope.legendHtml()}</div>`;
    h += '<div class="legend"><small>縮尺は地図の中央付近の値です。地図の上が北です。</small></div>';
    return h;
  }

  // ---- クレジット・出典 ----
  function credits(r) {
    const items = [
      `道路・林道・登山道（経路計算と地図の経路線）：<b>© OpenStreetMap contributors</b>。データは <a href="https://opendatacommons.org/licenses/odbl/">Open Database License（ODbL）</a> で提供されています（<a href="https://www.openstreetmap.org/copyright">https://www.openstreetmap.org/copyright</a>）。${(r.osm.match(/\d{4}-\d{2}-\d{2}/) || [''])[0].replace(/^(.+)$/, 'データ取得日 $1')}`,
      `標高・傾斜：国土地理院 標高タイル（DEM10m）を加工して作成`,
    ];
    if (document.getElementById('base').value !== 'white') items.push('背景地図：国土地理院 地理院タイル（淡色地図）<a href="https://maps.gsi.go.jp/development/ichiran.html">https://maps.gsi.go.jp/development/ichiran.html</a>');
    items.push('地名検索：国土地理院 地名検索API');
    items.push('危惧種・一般種の出現記録：GBIF（<a href="https://www.gbif.org">https://www.gbif.org</a>）。危惧種の区分は IUCN レッドリスト（CR/EN/VU）');
    items.push('経路と所要時間は本ツールが計算したものです（徒歩の登り下りは Tobler の歩行関数による）。データ提供者は経路の内容に責任を負いません。');
    return items.map(t => `<li>${t}</li>`).join('');
  }

  // ---- ルート沿い・目的地周辺の危惧種など（MeshInfo：mesh_info.js）----
  const strip = h => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent.replace(/\s+/g, ' ').trim(); };
  async function speciesData(r) {
    if (!r.path || typeof MeshInfo === 'undefined' || !MeshInfo.ready()) return null;
    const along = MeshInfo.forPath(r.path), goalId = MeshInfo.idAt(r.goal.ll), goal = MeshInfo.forId(goalId);
    const general = goal ? await MeshInfo.generalTop(goalId, '', 10) : null;
    return { along, goal, general };
  }
  const spN = x => (x.ja ? `${esc(x.ja)}<br>` : '') + `<i style="color:#555;font-size:10px">${esc(x.sci)}</i>`;
  function speciesHtml(sp, n) {
    if (!sp) return '';
    const near = sp.along.map(m => `<tr><td class="l">${esc(m.city)}</td><td>${m.n}</td><td>${m.sp}</td><td class="l" style="font-size:10px">${esc(m.species.slice(0, 6).map(x => x[1] || x[0]).join('、') || '—')}</td><td>${m.gen}</td></tr>`).join('');
    let h = `<h2>${n}. ルート沿い・目的地周辺の危惧種など</h2>`;
    if (sp.along.length) h += `<b>ルートが通る5kmメッシュの危惧種（通る順）</b><table><thead><tr><th>市町村（メッシュ）</th><th>危惧種 記録</th><th>種数</th><th>主な危惧種</th><th>一般記録</th></tr></thead><tbody>${near}</tbody></table>`;
    if (sp.goal) {
      h += `<p style="margin:8px 0 2px"><b>目的地のメッシュ（${esc(sp.goal.city)}）</b>　危惧種 記録 ${sp.goal.n}・種数 ${sp.goal.sp}／一般記録 ${sp.goal.gen}</p>`;
      h += `<table style="width:49%;float:left"><thead><tr><th>危惧種（CR/EN/VU）</th><th>区分</th><th>記録</th></tr></thead><tbody>${sp.goal.species.slice(0, 12).map(x => `<tr><td class="l">${spN({ ja: x[1], sci: x[0] })}</td><td style="text-align:center">${x[3]}</td><td>${x[2]}</td></tr>`).join('') || '<tr><td colspan="3" class="l">該当なし</td></tr>'}</tbody></table>`;
      h += `<table style="width:49%;float:right"><thead><tr><th>一般（記録の多い上位10種）</th><th>記録</th></tr></thead><tbody>${sp.general && sp.general.length ? sp.general.map(x => `<tr><td class="l">${spN(x)}</td><td>${x.n}</td></tr>`).join('') : '<tr><td colspan="2" class="l">GBIF から取得できませんでした</td></tr>'}</tbody></table><div style="clear:both"></div>`;
    }
    return h + '<small>経路が通る約5kmメッシュの集計で、経路上の位置を示すものではありません。記録数は調査の多さを反映します。区分はGBIFが照合したIUCNの区分で、栽培・外来の記録や名前の対応の違いで、野生の希少種とは限らない種が混じることがあります。希少種の生育・生息地では、踏み荒らしや採取をしないでください。</small>';
  }
  // 行程表をテキストの表にする（PowerPoint 用）
  function stepData(r) {
    const rows = []; let t = 0, n = 1;
    const add = (name, mode, dist, sec, note, count = true) => { if (count) t += sec; rows.push([n++, name, mode, dist, count ? mins(sec) : '—', mins(t), note]); };
    rows.push(['S', '出発地', '', '', '', '', r.start.label]);
    if (r.snapM >= 1) add('出発地 → 最寄りの道', '直線表示', km(r.snapM), 0, '所要時間に含めていません', false);
    add('車で移動', '車', km(r.car.m), r.car.sec, r.car.trackM ? `うち林道・農道 ${km(r.car.trackM)}` : '');
    if (r.park) add('駐車・身支度', '—', '', r.parkSec, '駐車地点（P）');
    if (r.foot.m >= 1) add('道を歩く', '徒歩', km(r.foot.m), r.foot.sec, '登山道・林道・小道など');
    if (r.off.m >= 1) add('道のない区間を歩く', '道なし', km(r.off.m), r.off.sec, r.off.steepM >= 1 ? `${r.steepDeg}°以上の急斜面 ${km(r.off.steepM)}（最大 ${Math.round(r.off.maxDeg)}°）` : '');
    rows.push(['G', '目的地 到着', '', '', mins(t), '', r.goal.label]);
    return rows;
  }
  async function pptx() {
    const r = Route.result();
    if (!r) return;
    if (typeof PptxGenJS === 'undefined') { alert('PowerPoint の作成に必要な部品を読み込めませんでした。通信状況を確認して、ページを開き直してください。'); return; }
    const busy = document.getElementById('busy'); busy.style.display = 'block';
    try {
      const img = await capture(r), sp = await speciesData(r), nt = notes(r);
      const d = r.at, ds = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      const cm = r.course ? r.course.match(/<svg[\s\S]*?<\/svg>/) : null, cn = r.course ? r.course.match(/<\/svg><small>([\s\S]*?)<\/small>/) : null;
      await ReportPptx.route({ ds, r, img, steps: stepData(r), course: cm ? cm[0] : '', courseNote: cn ? strip(cn[1]) : '', species: sp,
        labels: { start: r.start.label, goal: r.goal.label }, total: mins(r.total),
        carText: `${km(r.car.m)}・${mins(r.car.sec)}`, footText: r.foot.m >= 1 ? `${km(r.foot.m)}・${mins(r.foot.sec)}` : '—', offText: r.off.m >= 1 ? `${km(r.off.m)}・${mins(r.off.sec)}` : '—',
        notes: { route: nt.route.map(strip), general: nt.general.map(strip) }, credits: credits(r).match(/<li>[\s\S]*?<\/li>/g).map(strip) });
    } catch (e) { alert('PowerPoint の作成に失敗しました：' + e.message); }
    busy.style.display = 'none';
  }

  async function open() {
    const r = Route.result();
    if (!r) return;
    const w = window.open('', '_blank');
    if (!w) { alert('ポップアップがブロックされました。許可してからもう一度お試しください。'); return; }
    w.document.write('<p style="font:14px sans-serif">レポートを作成中…</p>');
    const img = await capture(r);
    const sp = await speciesData(r);
    const d = r.at, ds = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    const nt = notes(r);
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>調査ルート案内</title><style>
      @page { size: A4; margin: 14mm; }
      body { font: 12px/1.6 'Hiragino Sans','Yu Gothic',sans-serif; color: #111; }
      h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 14px; border-bottom: 2px solid #1565c0; margin: 16px 0 6px; padding-bottom: 2px; page-break-after: avoid; }
      table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #bbb; padding: 3px 6px; font-size: 11px; text-align: right; vertical-align: top; }
      th { background: #eee; text-align: center; } td.l { text-align: left; } tr { page-break-inside: avoid; } tr.pt td { background: #f5f8fc; }
      .sum td:first-child { text-align: left; width: 22%; background: #f7f7f7; } .sum td { text-align: left; }
      img.map { display: block; margin: 0 auto; max-width: 100%; max-height: 150mm; border: 1px solid #bbb; }
      .legend { margin: 4px 0; font-size: 11px; } .legend span { display: inline-block; margin-right: 12px; white-space: nowrap; } .legend svg { vertical-align: middle; margin-right: 3px; }
      .dot { display: inline-block; width: 15px; height: 15px; border-radius: 50%; color: #fff; font-size: 9px; text-align: center; line-height: 15px; margin-right: 3px; vertical-align: middle; }
      .slope div { display: inline-block; margin-right: 10px; } .slope i { display: inline-block; width: 14px; height: 10px; margin-right: 3px; vertical-align: middle; }
      .prof { max-width: 110mm; margin-top: 8px; page-break-inside: avoid; }
      .course { max-width: 150mm; margin-top: 8px; page-break-inside: avoid; }
      ul { margin: 2px 0; padding-left: 1.4em; } li { margin: 2px 0; } .warn { color: #b71c1c; } .credit li { font-size: 11px; color: #333; }
      small { color: #555; } a { color: #1565c0; } .noprint { margin: 8px 0; } @media print { .noprint { display: none; } }
    </style></head><body>
    <div class="noprint"><button onclick="print()">印刷 / PDFに保存</button></div>
    <h1>調査ルート案内</h1>
    <small>作成日時：${ds} ／ 対象範囲：${esc(r.area)}</small>
    <h2>概要</h2>
    <table class="sum">
      <tr><td>出発地</td><td>${esc(r.start.label)}　<small>${llText(r.start.ll)}</small></td></tr>
      <tr><td>目的地</td><td>${esc(r.goal.label)}　<small>${llText(r.goal.ll)}${isNaN(r.goal.elev) ? '' : `・標高 約 ${Math.round(r.goal.elev)} m`}</small></td></tr>
      <tr><td>所要時間の目安</td><td><b>${mins(r.total)}</b>　<small>車 ${km(r.car.m)}${r.foot.m >= 1 ? `・徒歩 ${km(r.foot.m)}` : ''}${r.off.m >= 1 ? `・道なし ${km(r.off.m)}` : ''}</small></td></tr>
    </table>
    ${img ? `<h2>1. 経路図</h2><img class="map" src="${img}">` : ''}
    <h2>${img ? 2 : 1}. 凡例</h2>${legend()}
    <h2>${img ? 3 : 2}. ルート案内</h2>
    <table><tr><th>No</th><th>区間</th><th>手段</th><th>距離</th><th>所要時間</th><th>累計</th><th>備考</th></tr>${steps(r)}</table>
    ${r.course ? `<div class="course">${r.course}</div>` : ''}
    ${r.profile ? `<div class="prof">${r.profile}</div>` : ''}
    ${speciesHtml(sp, img ? 4 : 3)}
    <h2>${(img ? 4 : 3) + (sp ? 1 : 0)}. ルート上の注意事項</h2>
    ${nt.route.length ? `<b>この経路について</b><ul class="route-notes">${nt.route.map(t => `<li>${t}</li>`).join('')}</ul>` : ''}
    <b>入山・調査の前に</b><ul>${nt.general.map(t => `<li>${t}</li>`).join('')}</ul>
    <h2>${(img ? 5 : 4) + (sp ? 1 : 0)}. クレジット・出典</h2>
    <ul class="credit">${credits(r)}</ul>
    </body></html>`;
    w.document.open(); w.document.write(html); w.document.close();
    setTimeout(() => w.print(), 700);
  }
  return { open, pptx };
})();
