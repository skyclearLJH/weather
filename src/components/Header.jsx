import { RefreshCcw, ChevronDown } from 'lucide-react';
import { REGIONS } from '../data/mockData';

const Header = ({ selectedRegion, onChangeRegion }) => {
  return (
    <header className="sticky top-0 z-50 bg-[#0033a0] shadow-md w-full">
      <div className="max-w-screen-xl mx-auto px-4 h-16 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-1">
          <span className="text-white font-extrabold text-xl tracking-tight leading-none bg-blue-700/50 p-1.5 rounded-md">KBS</span>
          <span className="text-white font-semibold text-xl tracking-wide ml-1">weathernow</span>
        </div>

        <div className="flex items-center gap-3 sm:gap-6">
          {/* Region Dropdown */}
          <div className="relative group flex items-center bg-white/10 hover:bg-white/20 rounded-full px-1 transition-colors">
            <select 
              value={selectedRegion} 
              onChange={(e) => onChangeRegion(e.target.value)}
              className="appearance-none bg-transparent text-white text-sm font-medium py-1.5 pl-3 pr-8 w-full outline-none cursor-pointer [&>option]:text-slate-900 [&>option]:bg-white"
            >
              {REGIONS.map((region) => (
                <option key={region.id} value={region.id}>
                  {region.label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="text-white absolute right-3 pointer-events-none" />
          </div>

          {/* Status */}
          <div className="flex items-center gap-2 text-blue-100 text-xs sm:text-sm font-medium">
            <button className="p-1 hover:bg-white/10 rounded-full transition-colors" title="새로고침">
              <RefreshCcw size={16} />
            </button>
            <span className="hidden sm:inline">10:30:05 업데이트됨</span>
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;
