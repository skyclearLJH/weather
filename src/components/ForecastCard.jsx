import { AlertTriangle, Info } from 'lucide-react';

const ForecastCard = ({ data, type }) => {
  const Icon = type === 'warning' ? AlertTriangle : Info;
  const iconColor = type === 'warning' ? 'text-red-500' : 'text-blue-500';
  const bgColor = type === 'warning' ? 'bg-red-50' : 'bg-blue-50';

  return (
    <div className="flex flex-col gap-4">
      {data.map((item) => (
        <div key={item.id} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-shadow">
          <div className="p-5 sm:p-6">
            <div className="flex items-start gap-3 sm:gap-4 mb-3">
              <div className={`mt-1 p-2 rounded-lg ${bgColor}`}>
                <Icon className={iconColor} size={20} />
              </div>
              <div className="flex-1">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-2">
                  <h3 className="text-lg font-bold text-slate-900 tracking-tight">
                    {type === 'warning' ? item.type : item.title}
                  </h3>
                  <span className="text-xs sm:text-sm font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-md w-fit">
                    {item.time}
                  </span>
                </div>
                <p className="text-sm sm:text-base text-slate-700 leading-relaxed">
                  {type === 'warning' ? <span className="font-semibold text-slate-800 tracking-tight">{item.region}</span> : item.content}
                </p>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default ForecastCard;
