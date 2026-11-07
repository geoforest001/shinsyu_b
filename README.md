# shiny_b
長野県 絶滅危惧種 分布マップ（GitHub Pages）

- `index.html` : MapLibre GL JS による地図ページ
- `data/nagano_mask.geojson` : 県外を薄く表示するためのマスク（境界: dataofjapan/land）
- `data/mesh_nagano.geojson` : 約5km(0.05°)メッシュ集計（記録数・種数・カテゴリ別）

## データ
- 出典: GBIF (https://www.gbif.org) 出現記録、IUCNレッドリスト CR/EN/VU、2026-11-07取得
- 希少種保護のため、個別の位置は公開せずメッシュ集計のみ掲載
- 県名が空の記録は、長野県を囲む矩形内であれば含めているため、県境付近で他県の記録が混じる場合があります

一般分布は GBIF の密度タイル(API)を表示しており、データは同梱していません。
