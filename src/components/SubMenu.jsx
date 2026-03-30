const SubMenu = ({ items, selectedId, onSelect }) => {
  if (!items || items.length === 0) return null;

  return (
    <div className="flex gap-2.5 overflow-x-auto scrollbar-hide py-4 mb-4">
      {items.map(item => (
        <button
          key={item.id}
          onClick={() => onSelect(item.id)}
          className={`px-5 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-all shadow-sm border
            ${selectedId === item.id 
              ? 'bg-[#0033a0] text-white border-[#0033a0]' 
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:text-[#0033a0]'}
          `}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
};

export default SubMenu;
