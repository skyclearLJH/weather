const ObservationTimeSelector = ({ value, options, onChange, disabled = false }) => {
  const selectedValue = value || 'latest';
  const isHistorical = selectedValue !== 'latest';

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
      <span className="font-semibold text-slate-500">이전 시간</span>
      <select
        value={selectedValue}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-bold text-slate-900 outline-none transition hover:bg-white focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
        aria-label="AWS 기준 시간 선택"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {isHistorical ? (
        <button
          type="button"
          onClick={() => onChange('latest')}
          disabled={disabled}
          className="rounded-xl bg-slate-900 px-2.5 py-1.5 font-bold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          최신
        </button>
      ) : null}
    </div>
  );
};

export default ObservationTimeSelector;
