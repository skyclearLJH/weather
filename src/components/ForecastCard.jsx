import { AlertTriangle, Info } from 'lucide-react';

const ForecastCard = ({ data, type, isLoading, error }) => {
  const Icon = type === 'warning' ? AlertTriangle : Info;
  const iconColor = type === 'warning' ? 'text-red-500' : 'text-blue-500';
  const bgColor = type === 'warning' ? 'bg-red-50' : 'bg-blue-50';

  // 스켈레톤 UI 렌더링
  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 animate-pulse">
        {[1, 2].map((i) => (
          <div key={i} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-5 sm:p-6 flex gap-4 items-start">
              <div className="w-10 h-10 bg-slate-200 rounded-lg shrink-0"></div>
              <div className="flex-1 space-y-3 py-1">
                <div className="h-4 bg-slate-200 rounded w-1/3"></div>
                <div className="space-y-2">
                  <div className="h-3 bg-slate-200 rounded"></div>
                  <div className="h-3 bg-slate-200 rounded w-5/6"></div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // 에러 메시지 렌더링
  if (error) {
    return (
      <div className="py-12 flex flex-col items-center justify-center text-center bg-white rounded-xl shadow-sm border border-slate-200">
        <AlertTriangle className="text-red-400 mb-2" size={32} />
        <p className="text-slate-600 font-medium">{error}</p>
      </div>
    );
  }

  // 데이터 없을 때
  if (!data || data.length === 0) {
    return (
      <div className="py-12 text-center text-slate-500 bg-white rounded-xl shadow-sm border border-slate-200">
        해당 정보가 없습니다.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {data.map((item) => (
        <div key={item.id} className="overflow-visible rounded-3xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md">
          <div className="p-5 sm:p-6 h-auto">
            <div className="flex items-start gap-3 sm:gap-4 h-auto">
              <div className={`mt-1 p-2 rounded-lg ${bgColor} shrink-0`}>
                <Icon className={iconColor} size={20} />
              </div>
              <div className="flex-1 min-w-0 h-auto">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-3">
                  <h3 className="text-lg font-bold text-slate-900 tracking-tight">
                    {type === 'warning' ? item.type : item.title}
                  </h3>
                  {item.time && (
                    <span className="w-fit whitespace-nowrap rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500 sm:text-sm">
                      {item.time}
                    </span>
                  )}
                </div>
                
                <div
                   className="h-auto overflow-visible whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700 sm:text-base"
                   style={{
                     whiteSpace: 'pre-wrap',
                     wordBreak: 'break-word',
                     lineHeight: '1.6',
                   }}
                >
                  {item.content}
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default ForecastCard;
