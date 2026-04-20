const SubMenu = ({ items, selectedId, onSelect }) => {
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
