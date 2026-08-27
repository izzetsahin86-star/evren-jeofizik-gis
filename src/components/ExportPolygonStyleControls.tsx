import type { ExportPolygonStyle } from '../types'

const WIDTH_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8]
const OPACITY_OPTIONS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

interface ExportPolygonStyleControlsProps {
  value: ExportPolygonStyle
  onChange: (value: ExportPolygonStyle) => void
}

export default function ExportPolygonStyleControls({ value, onChange }: ExportPolygonStyleControlsProps) {
  return (
    <div className="export-style-control" aria-label="Dışa aktarılacak poligon görünümü">
      <div className="export-style-heading">
        <strong>Aktarılan Poligon Görünümü</strong>
        <small>KML, KMZ ve GeoJSON dosyasına uygulanır</small>
      </div>
      <div className="export-style-row">
        <span className="export-style-row-label">Dış Çizgi</span>
        <label>
          <span>Genişlik</span>
          <select
            aria-label="Dış çizgi genişliği"
            value={value.strokeWidth}
            onChange={(event) => onChange({ ...value, strokeWidth: Number(event.target.value) })}
          >
            {WIDTH_OPTIONS.map((width) => <option key={width} value={width}>{width} piksel</option>)}
          </select>
        </label>
        <label>
          <span>Renk</span>
          <span className="export-color-field">
            <input
              type="color"
              aria-label="Dış çizgi rengi"
              value={value.strokeColor}
              onChange={(event) => onChange({ ...value, strokeColor: event.target.value })}
            />
            <b>{value.strokeColor.toUpperCase()}</b>
          </span>
        </label>
      </div>
      <div className="export-style-row">
        <span className="export-style-row-label">Dolgu</span>
        <label>
          <span>Opaklık</span>
          <select
            aria-label="Dolgu opaklığı"
            value={Math.round(value.fillOpacity * 100)}
            onChange={(event) => onChange({ ...value, fillOpacity: Number(event.target.value) / 100 })}
          >
            {OPACITY_OPTIONS.map((opacity) => <option key={opacity} value={opacity}>%{opacity}</option>)}
          </select>
        </label>
        <label>
          <span>Renk</span>
          <span className="export-color-field">
            <input
              type="color"
              aria-label="Dolgu rengi"
              value={value.fillColor}
              onChange={(event) => onChange({ ...value, fillColor: event.target.value })}
            />
            <b>{value.fillColor.toUpperCase()}</b>
          </span>
        </label>
      </div>
      <p className="export-style-format-note">CSV ve GPX biçimleri görsel poligon stili taşımaz.</p>
    </div>
  )
}
