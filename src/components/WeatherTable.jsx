const rankBadgeClassName = (rank) => {
  if (rank === 1) return 'bg-[#0033a0] text-white';
  if (rank === 2) return 'bg-blue-600 text-white';
  if (rank === 3) return 'bg-sky-500 text-white';
  return 'bg-slate-100 text-slate-700';
};

const WeatherTable = ({ title, subtitle, data }) => {
  return (
    <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-5 py-4 sm:px-6">
        <h2 className="text-lg font-bold tracking-tight text-slate-900">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
      </div>

      <div className="hidden grid-cols-[88px_minmax(0,1fr)_88px_minmax(0,2.2fr)] gap-3 border-b border-slate-200 bg-slate-50 px-6 py-3 text-sm font-semibold text-slate-500 md:grid">
        <div className="text-center">순위</div>
        <div>지점명</div>
        <div className="text-right">기록</div>
        <div>상세주소</div>
      </div>

      <ul className="divide-y divide-slate-100">
        {data.map((item) => {
          const isTopThree = item.rank <= 3;

          return (
            <li key={`${item.rank}-${item.name}-${item.record}`} className={isTopThree ? 'bg-blue-50/30' : ''}>
              <div className="flex items-start gap-3 px-4 py-4 md:hidden">
                <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${rankBadgeClassName(item.rank)}`}>
                  {item.rank}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <span className="truncate text-[15px] font-bold text-slate-900">{item.name}</span>
                    <span className="shrink-0 text-[15px] font-extrabold text-slate-900">{item.record}</span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{item.address}</p>
                </div>
              </div>

              <div className="hidden grid-cols-[88px_minmax(0,1fr)_88px_minmax(0,2.2fr)] items-center gap-3 px-6 py-4 md:grid">
                <div className="flex justify-center">
                  <span className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${rankBadgeClassName(item.rank)}`}>
                    {item.rank}
                  </span>
                </div>
                <div className="font-semibold text-slate-900">{item.name}</div>
                <div className="text-right font-extrabold text-slate-900">{item.record}</div>
                <div className="text-sm leading-6 whitespace-nowrap text-slate-500">{item.address}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default WeatherTable;
