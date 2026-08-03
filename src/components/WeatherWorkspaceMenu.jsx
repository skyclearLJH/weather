import { Film, MapPinned, MonitorPlay, Pencil, X } from 'lucide-react';

const MODE_ITEMS = [
  { id: 'broadcast', label: '방송모드', icon: MonitorPlay },
  { id: 'record', label: '녹화모드', icon: Film },
  { id: 'edit', label: '편집모드', icon: Pencil },
];

const SECTION_ITEMS = [
  { id: 'rain', label: '강수' },
  { id: 'heat', label: '폭염' },
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
  const viewItems = section === 'rain' ? RAIN_ITEMS : HEAT_ITEMS;

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
          activeClassName={section === 'rain' ? 'bg-cyan-400 text-slate-950 shadow-sm' : 'bg-orange-400 text-slate-950 shadow-sm'}
        />
        <SegmentedControl
          label={section === 'rain' ? '강수 화면' : '폭염 화면'}
          items={viewItems}
          value={activeView}
          onChange={onViewChange}
          activeClassName={section === 'rain' ? 'bg-blue-500 text-white shadow-sm' : 'bg-rose-500 text-white shadow-sm'}
        />
        {/* 지명 표시 토글: 편집모드뿐 아니라 녹화모드에서도 켜고 끌 수 있게 남긴다.
            (방송모드에서는 이 메뉴 자체가 숨겨진다.) */}
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
      </div>
    </div>
  );
}

export default WeatherWorkspaceMenu;
