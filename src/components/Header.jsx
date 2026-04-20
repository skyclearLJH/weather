import { RefreshCcw, ChevronDown, Clock3 } from 'lucide-react';
import { REGIONS } from '../data/mockData';

const formatUpdatedAt = (value) => {
  if (!value) {
    return '업데이트 시각 없음';
  }

  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value);
};

const Header = ({ selectedRegion, onChangeRegion, onRefresh, lastUpdatedAt, isRefreshing }) => {
  return (
    <header className="border-b border-slate-200 bg-white/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-screen-xl flex-col gap-3 px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-[#0033a0] px-3 py-2 text-sm font-extrabold tracking-[0.24em] text-white shadow-sm">
              KBS
            </div>
            <div>
              <p className="text-lg font-bold tracking-tight text-slate-900 sm:text-xl">
                weathernow
              </p>
              <p className="text-xs text-slate-500 sm:text-sm">
                KBS 재난미디어센터 기상 정보 포털
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <label className="relative flex min-w-[180px] items-center rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm shadow-sm">
              <span className="mr-2 shrink-0 text-slate-500">지역</span>
              <select
                value={selectedRegion}
                onChange={(event) => onChangeRegion(event.target.value)}
                className="w-full appearance-none bg-transparent pr-7 font-semibold text-slate-800 outline-none"
              >
                {REGIONS.map((region) => (
                  <option key={region.id} value={region.id}>
                    {region.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} className="pointer-events-none absolute right-4 text-slate-500" />
            </label>

            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[#0033a0] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-[#00257a] disabled:cursor-not-allowed disabled:opacity-70"
              disabled={isRefreshing}
            >
              <RefreshCcw size={16} className={isRefreshing ? 'animate-spin' : ''} />
              새로고침
            </button>

            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 shadow-sm">
              <Clock3 size={16} className="text-[#0033a0]" />
              <span className="font-medium">업데이트 시각</span>
              <span className="font-semibold text-slate-900">{formatUpdatedAt(lastUpdatedAt)}</span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;
