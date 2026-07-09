const SubMenu = ({ items, groups, selectedId, onSelect }) => {
  if (groups?.length) {
    const activeGroup =
      groups.find((group) => group.items.some((item) => item.id === selectedId)) ?? groups[0];

    return (
      <div className="mb-6 space-y-2">
        <div className="overflow-x-auto scrollbar-hide">
          <div className="flex min-w-full gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
            {groups.map((group) => {
              const isActive = group.id === activeGroup.id;

              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => onSelect(group.items[0].id)}
                  className={`flex-1 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-bold transition ${
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  {group.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="overflow-x-auto scrollbar-hide">
          <div className="flex min-w-full gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-2">
            {activeGroup.items.map((item) => {
              const isActive = selectedId === item.id;

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className={`flex-1 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-semibold transition ${
                    isActive
                      ? 'bg-[#0033a0] text-white shadow-sm'
                      : 'text-slate-600 hover:bg-white hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (!items?.length) {
    return null;
  }

  return (
    <div className="mb-6 overflow-x-auto scrollbar-hide">
      <div className="inline-flex min-w-full gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        {items.map((item) => {
          const isActive = selectedId === item.id;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              className={`shrink-0 rounded-xl px-4 py-2 text-sm font-semibold transition ${
                isActive
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default SubMenu;
