import { Film, MapPinned, MonitorPlay, Pencil, X } from 'lucide-react';

const MODE_ITEMS = [
  { id: 'broadcast', label: '방송모드', icon: MonitorPlay },
  { id: 'record', label: '녹화모드', icon: Film },
  { id: 'edit', label: '편집모드', icon: Pencil },
];

const SECTION_ITEMS = [
  { id: 'rain', label: '강수' },
  { id: 'heat', label: '폭염' },
  { id: 'forecast', label: '예측' },
  { id: 'analysis', label: '분석' },
];

const RAIN_ITEMS = [
  { id: 'radar', label: '레이더' },
  { id: 'kim', label: '강수예상' },
  { id: 'accum', label: '강수량' },
  { id: 'satellite', label: '위성' },
];

const HEAT_ITEMS = [
  { id: 'tropical', label: '열대야' },
  { id: 'heat', label: '폭염' },
  { id: 'change', label: '기온변화' },
];

const FORECAST_ITEMS = [
  { id: 'kim-global', label: 'KIM' },
  { id: 'ifs', label: 'ECMWF' },
  { id: 'gfs', label: 'GFS' },
  { id: 'compare', label: '비교분석' },
];

const ANALYSIS_ITEMS = [
  { id: 'tracking', label: '호우추적' },
  { id: 'terrain', label: '지형호우' },
];

const SECTION_VIEW_ITEMS = {
  rain: RAIN_ITEMS,
  heat: HEAT_ITEMS,
  forecast: FORECAST_ITEMS,
  analysis: ANALYSIS_ITEMS,
};

const SECTION_ACTIVE_CLASSES = {
  rain: 'bg-cyan-400 text-slate-950 shadow-sm',
  heat: 'bg-orange-400 text-slate-950 shadow-sm',
  forecast: 'bg-violet-400 text-slate-950 shadow-sm',
  analysis: 'bg-emerald-400 text-slate-950 shadow-sm',
};

const VIEW_ACTIVE_CLASSES = {
  rain: 'bg-blue-500 text-white shadow-sm',
  heat: 'bg-rose-500 text-white shadow-sm',
  forecast: 'bg-violet-600 text-white shadow-sm',
  analysis: 'bg-emerald-600 text-white shadow-sm',
};

const SECTION_LABELS = {
  rain: '강수 화면',
  heat: '폭염 화면',
  forecast: '예측 모델',
  analysis: '분석 화면',
};

function SegmentedControl({ label, items, value, onChange, activeClassName }) {
  return (
    <div
      className="flex h-10 items-center rounded-lg border border-white/20 bg-slate-950/85 p-1 shadow-xl backdrop-blur-md"
      role="group"
      aria-label={label}
    >
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            aria-pressed={isActive}
            className={`flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-black transition ${
              isActive
                ? activeClassName
                : 'text-white/65 hover:bg-white/10 hover:text-white'
            }`}
          >
            {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function WeatherWorkspaceMenu({
  workspaceMode,
  onWorkspaceModeChange,
  section,
  onSectionChange,
  activeView,
  onViewChange,
  showPlaceLabels,
  onShowPlaceLabelsChange,
  onExit,
}) {
  const viewItems = SECTION_VIEW_ITEMS[section] ?? RAIN_ITEMS;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <SegmentedControl
          label="작업 모드"
          items={MODE_ITEMS}
          value={workspaceMode}
          onChange={onWorkspaceModeChange}
          activeClassName="bg-white text-slate-950 shadow-sm"
        />
        <button
          type="button"
          onClick={onExit}
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/20 bg-slate-950/85 text-white/70 shadow-xl backdrop-blur-md transition hover:bg-slate-800 hover:text-white"
          aria-label="방송 작업 화면 닫기"
          title="닫기"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <SegmentedControl
          label="기상 분야"
          items={SECTION_ITEMS}
          value={section}
          onChange={onSectionChange}
          activeClassName={SECTION_ACTIVE_CLASSES[section]}
        />
        <SegmentedControl
          label={SECTION_LABELS[section]}
          items={viewItems}
          value={activeView}
          onChange={onViewChange}
          activeClassName={VIEW_ACTIVE_CLASSES[section]}
        />
        {/* 지명 표시 토글: 편집·녹화 모드에서 켜고 끌 수 있게 남긴다(방송모드에서는
            이 메뉴 자체가 숨겨짐). 단, 위성 화면은 라벨을 켜면 FD 깜빡임이 생겨
            라벨 자체를 두지 않으므로 이 버튼도 숨긴다. */}
        {activeView !== 'satellite' ? (
          <button
            type="button"
            onClick={() => onShowPlaceLabelsChange(!showPlaceLabels)}
            aria-pressed={showPlaceLabels}
            className={`flex h-10 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-black shadow-xl backdrop-blur-md transition ${
              showPlaceLabels
                ? 'border-emerald-300/60 bg-emerald-400 text-slate-950'
                : 'border-white/20 bg-slate-950/85 text-white/65 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <MapPinned className="h-4 w-4" aria-hidden="true" />
            지명 표시
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default WeatherWorkspaceMenu;
