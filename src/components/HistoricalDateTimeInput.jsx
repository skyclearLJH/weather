const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
const MINUTES = Array.from({ length: 6 }, (_, index) => String(index * 10).padStart(2, '0'));

const clampValue = (value, min, max) => {
  if (min && value < min) return min;
  if (max && value > max) return max;
  return value;
};

const HistoricalDateTimeInput = ({
  value,
  min,
  max,
  onChange,
  dark = false,
  ariaLabel = '과거 조회 시각',
}) => {
  const date = value.slice(0, 10);
  const hour = value.slice(11, 13);
  const minute = value.slice(14, 16);
  const dateMin = min?.slice(0, 10);
  const dateMax = max?.slice(0, 10);
  const fieldClass = dark
    ? 'bg-slate-800/90 text-white [color-scheme:dark]'
    : 'border border-slate-200 bg-slate-50 text-slate-700';

  const buildValue = (nextDate, nextHour, nextMinute) =>
    `${nextDate}T${nextHour}:${nextMinute}`;
  const isAllowed = (candidate) =>
    (!min || candidate >= min) && (!max || candidate <= max);
  const updatePart = (nextDate, nextHour, nextMinute) => {
    onChange(clampValue(buildValue(nextDate, nextHour, nextMinute), min, max));
  };

  return (
    <div className="flex items-center gap-1">
      <input
        type="date"
        value={date}
        min={dateMin}
        max={dateMax}
        onChange={(event) => updatePart(event.target.value, hour, minute)}
        className={`h-7 w-[8.4rem] rounded px-1.5 text-xs outline-none ${fieldClass}`}
        aria-label={`${ariaLabel} 날짜`}
      />
      <select
        value={hour}
        onChange={(event) => updatePart(date, event.target.value, minute)}
        className={`h-7 w-[3.8rem] rounded px-1 text-xs outline-none ${fieldClass}`}
        aria-label={`${ariaLabel} 시`}
      >
        {HOURS.map((option) => {
          const hasAvailableMinute = MINUTES.some((candidateMinute) =>
            isAllowed(buildValue(date, option, candidateMinute)),
          );
          return (
            <option key={option} value={option} disabled={!hasAvailableMinute}>
              {option}시
            </option>
          );
        })}
      </select>
      <select
        value={minute}
        onChange={(event) => updatePart(date, hour, event.target.value)}
        className={`h-7 w-[3.8rem] rounded px-1 text-xs outline-none ${fieldClass}`}
        aria-label={`${ariaLabel} 분`}
      >
        {MINUTES.map((option) => (
          <option
            key={option}
            value={option}
            disabled={!isAllowed(buildValue(date, hour, option))}
          >
            {option}분
          </option>
        ))}
      </select>
    </div>
  );
};

export default HistoricalDateTimeInput;
