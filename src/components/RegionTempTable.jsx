const columnValueClassName = (label) => {
  if (label.includes('최저')) {
    return 'text-blue-600';
  }
  if (label.includes('최고')) {
    return 'text-red-600';
  }
  return 'text-slate-900';
};

const diffClassName = (diff) => {
  if (diff > 0) {
    return 'text-red-500';
  }
  if (diff < 0) {
    return 'text-blue-500';
  }
  return 'text-slate-400';
};

const formatDiff = (diff) => {
  if (diff === 0) {
    return '0';
  }

  const rounded = Number.isInteger(diff) ? Math.abs(diff) : Math.abs(diff).toFixed(1);
  return `${diff > 0 ? '+' : '-'}${rounded}`;
};

const RegionTempTable = ({ title, subtitle, columns, rows }) => {
  const gridTemplateColumns = `minmax(0, 0.9fr) repeat(${columns.length}, minmax(0, 1fr))`;

  return (
    <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-50 px-5 py-4 sm:px-6">
        <h2 className="text-lg font-bold tracking-tight text-slate-900">{title}</h2>
        {subtitle ? <div className="mt-1 text-sm text-slate-500">{subtitle}</div> : null}
      </div>

      <div
        className="grid gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-500 sm:px-6"
        style={{ gridTemplateColumns }}
      >
        <div>지역</div>
        {columns.map((label) => (
          <div key={label} className="text-right">
            {label}
          </div>
        ))}
      </div>

      <ul className="divide-y divide-slate-100">
        {rows.map((row) => (
          <li
            key={row.id}
            className="grid items-center gap-2 px-4 py-3 sm:px-6"
            style={{ gridTemplateColumns }}
          >
            <div className="truncate text-[15px] font-semibold text-slate-900">{row.name}</div>
            {row.cells.map((cell, index) => (
              <div key={columns[index]} className="text-right">
                <div
                  className={`text-[15px] font-extrabold ${
                    cell.value === '-' ? 'text-slate-300' : columnValueClassName(columns[index])
                  }`}
                >
                  {cell.value}
                </div>
                {cell.comparisons?.length ? (
                  <div className="mt-0.5 flex flex-col items-end text-[11px] font-semibold leading-4">
                    {cell.comparisons.map(({ label, diff }) => (
                      <span key={label} className={diffClassName(diff)}>
                        {label} {formatDiff(diff)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
};

export default RegionTempTable;
