const columnValueClassName = (label) => {
  if (label.includes('최저')) {
    return 'text-blue-600';
  }
  if (label.includes('최고')) {
    return 'text-red-600';
  }
  return 'text-slate-900';
};

const RegionTempTable = ({ title, subtitle, columns, rows }) => {
  const gridTemplateColumns = `minmax(0, 1.4fr) repeat(${columns.length}, minmax(0, 1fr))`;

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
            {row.values.map((value, index) => (
              <div
                key={columns[index]}
                className={`text-right text-[15px] font-extrabold ${
                  value === '-' ? 'text-slate-300' : columnValueClassName(columns[index])
                }`}
              >
                {value}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
};

export default RegionTempTable;
