import { useState, useEffect } from 'react';
import Header from './components/Header';
import Navigation from './components/Navigation';
import WeatherTable from './components/WeatherTable';
import ForecastCard from './components/ForecastCard';
import SubMenu from './components/SubMenu';

import {
  REGIONS,
  SUB_MENUS,
  MOCK_MIN_TEMP_CURRENT, MOCK_MIN_TEMP_TODAY,
  MOCK_MAX_TEMP_CURRENT, MOCK_MAX_TEMP_TODAY,
  MOCK_PRECIPITATION_1H, MOCK_PRECIPITATION_TODAY, MOCK_PRECIPITATION_YESTERDAY,
  MOCK_SNOW_CURRENT, MOCK_SNOW_TODAY,
  MOCK_FORECAST_DOC, MOCK_FORECAST_COMMENTARY,
  MOCK_WARNING_CURRENT, MOCK_WARNING_PRELIMINARY
} from './data/mockData';

function App() {
  const [selectedRegion, setSelectedRegion] = useState('all');
  const [selectedTab, setSelectedTab] = useState('minTemp');
  const [selectedSubMenu, setSelectedSubMenu] = useState(SUB_MENUS['minTemp'][0].id);

  // When tab changes, reset sub-menu to the first option of the new tab
  useEffect(() => {
    setSelectedSubMenu(SUB_MENUS[selectedTab][0].id);
  }, [selectedTab]);

  const filterByRegion = (dataArray) => {
    if (selectedRegion === 'all' || !dataArray) return dataArray;
    
    const targetRegionObj = REGIONS.find(r => r.id === selectedRegion);
    if (!targetRegionObj || targetRegionObj.keywords.length === 0) return dataArray;
    
    const filtered = dataArray.filter(item => {
      const searchStr = item.address || item.region || '';
      return targetRegionObj.keywords.some(keyword => searchStr.includes(keyword));
    });

    // Re-assign ranks for tables
    if (filtered.length > 0 && filtered[0].rank !== undefined) {
      return filtered.map((item, idx) => ({ ...item, rank: idx + 1 }));
    }
    return filtered;
  };

  const getActiveTableData = () => {
    switch (selectedTab) {
      case 'minTemp':
        return selectedSubMenu === 'current' ? MOCK_MIN_TEMP_CURRENT : MOCK_MIN_TEMP_TODAY;
      case 'maxTemp':
        return selectedSubMenu === 'current' ? MOCK_MAX_TEMP_CURRENT : MOCK_MAX_TEMP_TODAY;
      case 'precipitation':
        if (selectedSubMenu === '1h') return MOCK_PRECIPITATION_1H;
        if (selectedSubMenu === 'today') return MOCK_PRECIPITATION_TODAY;
        return MOCK_PRECIPITATION_YESTERDAY;
      case 'snow':
        return selectedSubMenu === 'current' ? MOCK_SNOW_CURRENT : MOCK_SNOW_TODAY;
      default:
        return [];
    }
  };

  const getActiveCardData = () => {
    switch (selectedTab) {
      case 'forecast':
        return selectedSubMenu === 'doc' ? MOCK_FORECAST_DOC : MOCK_FORECAST_COMMENTARY;
      case 'warning':
        return selectedSubMenu === 'current' ? MOCK_WARNING_CURRENT : MOCK_WARNING_PRELIMINARY;
      default:
        return [];
    }
  };

  const renderContent = () => {
    const isTableView = ['minTemp', 'maxTemp', 'precipitation', 'snow'].includes(selectedTab);
    const subMenuDef = SUB_MENUS[selectedTab].find(s => s.id === selectedSubMenu);
    const contentTitle = subMenuDef ? subMenuDef.label : selectedTab;

    if (isTableView) {
      const filteredData = filterByRegion(getActiveTableData()).slice(0, 10);
      return (
        <div className="animate-fade-in space-y-4">
          <WeatherTable title={`${contentTitle} Top 10`} data={filteredData} />
          {filteredData.length === 0 && (
            <div className="py-12 text-center text-slate-500 bg-white rounded-xl border border-slate-200">
              해당 지역의 데이터가 없습니다.
            </div>
          )}
        </div>
      );
    } else {
      const filteredData = filterByRegion(getActiveCardData());
      return (
        <div className="animate-fade-in mt-4 mb-8">
          <ForecastCard data={filteredData} type={selectedTab} />
          {filteredData.length === 0 && (
            <div className="py-12 text-center text-slate-500 bg-white rounded-xl border border-slate-200">
              해당 지역의 발효 정보가 없습니다.
            </div>
          )}
        </div>
      );
    }
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] font-sans selection:bg-blue-200 flex flex-col">
      <Header selectedRegion={selectedRegion} onChangeRegion={setSelectedRegion} />
      <Navigation selectedTab={selectedTab} onSelectTab={setSelectedTab} />
      
      <main className="max-w-screen-xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-2 flex-grow">
        <SubMenu 
          items={SUB_MENUS[selectedTab]} 
          selectedId={selectedSubMenu} 
          onSelect={setSelectedSubMenu} 
        />
        <div className="flex-1 min-w-0">
          {renderContent()}
        </div>
      </main>
      
      <footer className="bg-white border-t border-slate-200 py-8 text-center text-slate-500 text-sm mt-auto">
        <p>&copy; {new Date().getFullYear()} KBS Disaster Media Center. All rights reserved.</p>
      </footer>
    </div>
  );
}

export default App;
