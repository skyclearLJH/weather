import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_RAIN_GRAPHIC_ID,
  RAIN_GRAPHICS,
} from '../data/rainGraphicData';
import './RainGraphicView.css';

const MAP_WIDTH = 1040;
const MAP_HEIGHT = 1000;
const MAP_BOUNDS = {
  minLon: 124.45,
  maxLon: 131.05,
  minLat: 32.95,
  maxLat: 38.85,
};

const projectCoordinate = ([longitude, latitude]) => {
  const longitudeScale = Math.cos((36 * Math.PI) / 180);
  const geographicWidth = (MAP_BOUNDS.maxLon - MAP_BOUNDS.minLon) * longitudeScale;
  const geographicHeight = MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat;
  const padding = 34;
  const scale = Math.min(
    (MAP_WIDTH - padding * 2) / geographicWidth,
    (MAP_HEIGHT - padding * 2) / geographicHeight,
  );
  const projectedWidth = geographicWidth * scale;
  const projectedHeight = geographicHeight * scale;
  const offsetX = (MAP_WIDTH - projectedWidth) / 2;
  const offsetY = (MAP_HEIGHT - projectedHeight) / 2;

  return [
    offsetX + (longitude - MAP_BOUNDS.minLon) * longitudeScale * scale,
    offsetY + (MAP_BOUNDS.maxLat - latitude) * scale,
  ];
};

const ringToPath = (ring) => {
  if (!ring?.length) return '';

  return ring
    .map((coordinate, index) => {
      const [x, y] = projectCoordinate(coordinate);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ') + ' Z';
};

const geometryToPath = (geometry) => {
  if (!geometry?.coordinates) return '';

  if (geometry.type === 'Polygon') {
    return geometry.coordinates.map(ringToPath).join(' ');
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates
      .flatMap((polygon) => polygon.map(ringToPath))
      .join(' ');
  }

  return '';
};

const matchesSelector = (feature, selector, source) => {
  if (source === 'emd') {
    return selector.emdCodes?.includes(feature.properties.adm_cd) ?? false;
  }

  const { sidonm, sggnm } = feature.properties;
  if (source === 'sido') {
    return selector.provinces?.includes(sidonm) ?? false;
  }

  return (
    selector.cities?.some(
      (group) =>
        group.province === sidonm &&
        group.names.some((name) => sggnm.startsWith(name)),
    ) ?? false
  );
};

const RainLabel = ({ label }) => {
  const [x, y] = projectCoordinate([label.lon, label.lat]);

  return (
    <div
      className="rain-graphic-label-anchor"
      style={{ left: `${(x / MAP_WIDTH) * 100}%`, top: `${(y / MAP_HEIGHT) * 100}%` }}
    >
      {label.note ? <div className="rain-graphic-label-note">{label.note}</div> : null}
      <div
        className={`rain-graphic-label${label.darkText ? ' rain-graphic-label--dark' : ''}`}
        style={{ backgroundColor: label.color }}
      >
        {label.text}
      </div>
    </div>
  );
};

const RainGraphicTitle = ({ period, title }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!context) return;

    const scale = 2;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.scale(scale, scale);
    context.textAlign = 'center';
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#f8fbff';
    context.shadowColor = 'rgba(3, 12, 23, 0.58)';
    context.shadowBlur = 14;
    context.shadowOffsetY = 4;
    context.font = '900 94px Pretendard, "Noto Sans KR", "Malgun Gothic", sans-serif';
    context.fillText(title, 300, 92);

    context.beginPath();
    context.moveTo(170, 132);
    context.lineTo(430, 132);
    context.lineWidth = 4;
    context.strokeStyle = 'rgba(248, 251, 255, 0.92)';
    context.stroke();

    context.font = '650 39px Pretendard, "Noto Sans KR", "Malgun Gothic", sans-serif';
    context.fillText(period, 300, 196);
    context.restore();
  }, [period, title]);

  return (
    <canvas
      ref={canvasRef}
      className="rain-graphic-title-canvas"
      width="1200"
      height="480"
      role="img"
      aria-label={`${title} ${period}`}
    />
  );
};

function RainGraphicView({ graphicId = DEFAULT_RAIN_GRAPHIC_ID }) {
  const graphic = RAIN_GRAPHICS[graphicId] ?? RAIN_GRAPHICS[DEFAULT_RAIN_GRAPHIC_ID];
  const [mapData, setMapData] = useState(null);

  useEffect(() => {
    let active = true;

    Promise.all([
      fetch('/data/map/kr-sgg-20260701.geojson').then((response) => response.json()),
      fetch('/data/map/kr-sido-20260701.geojson').then((response) => response.json()),
      fetch('/data/map/kr-emd-20260701.geojson').then((response) => response.json()),
    ]).then(([sgg, sido, emd]) => {
      if (active) setMapData({ sgg, sido, emd });
    });

    return () => {
      active = false;
    };
  }, []);

  const layerFeatures = useMemo(() => {
    if (!mapData) return [];

    return graphic.layers.map((layer) => ({
      ...layer,
      features: [
        ...mapData.sido.features.filter((feature) =>
          matchesSelector(feature, layer.selector, 'sido'),
        ),
        ...mapData.sgg.features.filter((feature) =>
          matchesSelector(feature, layer.selector, 'sgg'),
        ),
        ...mapData.emd.features.filter((feature) =>
          matchesSelector(feature, layer.selector, 'emd'),
        ),
      ],
    }));
  }, [graphic, mapData]);

  return (
    <main className="rain-graphic-canvas">
      <div className="rain-graphic-photo" />
      <div className="rain-graphic-wash" />
      <div className="rain-graphic-title-panel" />

      <section className="rain-graphic-title-block">
        <RainGraphicTitle title={graphic.title} period={graphic.period} />
      </section>

      <section className="rain-graphic-map" aria-label={`${graphic.period} 예상 강수량 지도`}>
        {mapData ? (
          <>
            <svg
              className="rain-graphic-map-svg"
              viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
              role="img"
              aria-hidden="true"
            >
              <g>
                <g className="rain-graphic-land">
                  {mapData.sido.features.map((feature) => (
                    <path key={`land-${feature.properties.sido}`} d={geometryToPath(feature.geometry)} />
                  ))}
                </g>

                {layerFeatures.map((layer) => (
                  <g
                    key={layer.id}
                    className={layer.emphasis ? 'rain-graphic-region rain-graphic-region--emphasis' : 'rain-graphic-region'}
                    fill={layer.color}
                  >
                    {layer.features.map((feature, index) => (
                      <path
                        key={`${layer.id}-${feature.properties.sgg ?? feature.properties.adm_cd ?? index}`}
                        d={geometryToPath(feature.geometry)}
                        stroke={layer.color}
                        strokeWidth="3.2"
                        strokeLinejoin="round"
                      />
                    ))}
                  </g>
                ))}

                <g className="rain-graphic-province-lines">
                  {mapData.sido.features.map((feature, index) => (
                    <path
                      key={`province-${feature.properties.sido ?? index}`}
                      d={geometryToPath(feature.geometry)}
                    />
                  ))}
                </g>
              </g>
            </svg>

            <div className="rain-graphic-label-layer">
              {graphic.labels.map((label) => (
                <RainLabel key={`${label.text}-${label.lon}-${label.lat}`} label={label} />
              ))}
            </div>
          </>
        ) : (
          <div className="rain-graphic-loading">지도 준비 중</div>
        )}
      </section>
    </main>
  );
}

export default RainGraphicView;
