import { INITIAL_TABS } from '../data/mockData';

const Navigation = ({ selectedTab, onSelectTab }) => {
  return (
    <nav className="w-full bg-white border-b border-gray-200">
      <div className="max-w-screen-xl mx-auto px-4 relative">
        <ul className="flex space-x-6 sm:space-x-12 overflow-x-auto scrollbar-hide snap-x relative h-14">
          {INITIAL_TABS.map((tab) => (
            <li key={tab.id} className="snap-start shrink-0 flex items-center justify-center">
              <button
                onClick={() => onSelectTab(tab.id)}
                className={`text-sm sm:text-base font-medium py-4 px-2 whitespace-nowrap transition-all duration-200 relative
                  ${selectedTab === tab.id ? 'text-[#0033a0] font-bold' : 'text-slate-600 hover:text-slate-900'}
                `}
              >
                {tab.label}
                {selectedTab === tab.id && (
                  <span className="absolute bottom-0 left-0 w-full h-[3px] bg-[#0033a0] rounded-t-sm animate-fade-in-up" />
                )}
              </button>
            </li>
          ))}
        </ul>
        {/* Fading edge for scroll hint on mobile */}
        <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-white to-transparent pointer-events-none md:hidden" />
      </div>
    </nav>
  );
};

export default Navigation;
