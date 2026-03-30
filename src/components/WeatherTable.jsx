const WeatherTable = ({ title, data }) => {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mt-6 mb-8 animate-fade-in">
      <div className="bg-slate-50 px-6 py-4 border-b border-slate-200">
        <h2 className="text-lg font-bold text-slate-800 tracking-tight flex items-center gap-2">
          {title}
        </h2>
      </div>
      
      <div className="overflow-hidden">
        {/* Desktop Table Header */}
        <div className="hidden md:grid grid-cols-[80px_1fr_120px_2fr] gap-4 px-6 py-3 bg-slate-50 border-b border-slate-200 font-medium text-slate-500 text-sm">
          <div className="text-center font-bold">순위</div>
          <div>지점명</div>
          <div className="text-right">기록</div>
          <div>상세주소</div>
        </div>

        {/* List Items */}
        <ul className="divide-y divide-slate-100">
          {data.map((item, index) => {
            const isTop3 = index < 3;
            // Rank badge styling
            const getRankBadge = (rank) => {
              if (rank === 1) return 'bg-[#0033a0] text-white shadow-sm ring-1 ring-[#0033a0]/20';
              if (rank === 2) return 'bg-blue-600 text-white shadow-sm ring-1 ring-blue-600/20';
              if (rank === 3) return 'bg-blue-500 text-white shadow-sm ring-1 ring-blue-500/20';
              return 'bg-slate-100 text-slate-500 font-semibold';
            };

            return (
              <li key={index} className={`transition-colors hover:bg-slate-50/80 ${isTop3 ? 'bg-blue-50/30' : ''}`}>
                
                {/* Mobile View (Stacked) */}
                <div className="md:hidden flex flex-col px-4 py-3 gap-1">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${getRankBadge(item.rank)}`}>
                        {item.rank}
                      </span>
                      <span className={`font-bold text-[15px] ${isTop3 ? 'text-slate-900' : 'text-slate-700'}`}>
                        {item.name}
                      </span>
                    </div>
                    <span className={`font-extrabold text-[15px] ${isTop3 ? 'text-[#0033a0]' : 'text-slate-900'}`}>
                      {item.record}
                    </span>
                  </div>
                  <div className="pl-9 pr-2 text-xs text-slate-500 line-clamp-1">
                    {item.address}
                  </div>
                </div>

                {/* Desktop View (Grid row) */}
                <div className="hidden md:grid grid-cols-[80px_1fr_120px_2fr] gap-4 px-6 py-4 items-center">
                  <div className="flex justify-center">
                    <span className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${getRankBadge(item.rank)}`}>
                      {item.rank}
                    </span>
                  </div>
                  <div className={`font-semibold text-base ${isTop3 ? 'text-slate-900' : 'text-slate-700'}`}>
                    {item.name}
                  </div>
                  <div className={`text-right font-extrabold text-base tracking-tight ${isTop3 ? 'text-[#0033a0]' : 'text-slate-900'}`}>
                    {item.record}
                  </div>
                  <div className="text-sm text-slate-500 truncate">
                    {item.address}
                  </div>
                </div>
                
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};

export default WeatherTable;
