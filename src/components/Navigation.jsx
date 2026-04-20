import { INITIAL_TABS } from '../data/mockData';

const Navigation = ({ selectedTab, onSelectTab }) => {
  return (
    <nav className="border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto max-w-screen-xl px-4 sm:px-6 lg:px-8">
        <ul className="flex gap-2 overflow-x-auto py-3 scrollbar-hide">
          {INITIAL_TABS.map((tab) => {
            const isActive = selectedTab === tab.id;

            return (
              <li key={tab.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => onSelectTab(tab.id)}
                  className={`rounded-full px-4 py-2.5 text-sm font-semibold transition sm:px-5 ${
                    isActive
                      ? 'bg-[#0033a0] text-white shadow-sm'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
};

export default Navigation;
