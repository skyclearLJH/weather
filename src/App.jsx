import { useState, useEffect } from 'react';
import Header from './components/Header';
import Navigation from './components/Navigation';
import WeatherTable from './components/WeatherTable';
import ForecastCard from './components/ForecastCard';
import SubMenu from './components/SubMenu';

import { fetchWeatherCommentary, fetchWeatherDoc, fetchWeatherWarnings, getWarningImageUrl, fetchSnowData } from './api/weatherApi';

import {
  REGIONS,
  SUB_MENUS,
  MOCK_MIN_TEMP_CURRENT, MOCK_MIN_TEMP_TODAY,
  MOCK_MAX_TEMP_CURRENT, MOCK_MAX_TEMP_TODAY,
  MOCK_PRECIPITATION_1H, MOCK_PRECIPITATION_TODAY, MOCK_PRECIPITATION_YESTERDAY,
  MOCK_SNOW_CURRENT, MOCK_SNOW_TODAY,
  MOCK_FORECAST_DOC,
  MOCK_WARNING_CURRENT, MOCK_WARNING_PRELIMINARY
} from './data/mockData';

function App() {
  const [selectedRegion, setSelectedRegion] = useState('all');
  const [selectedTab, setSelectedTab] = useState('minTemp');
  const [selectedSubMenu, setSelectedSubMenu] = useState(SUB_MENUS['minTemp'][0].id);

  // API State
  const [apiData, setApiData] = useState([]); // 날씨해설
  const [docApiData, setDocApiData] = useState([]); // 통보문
  const [warningApiData, setWarningApiData] = useState({ current: [], preliminary: [] }); // 특보 및 예비특보
  const [snowApiData, setSnowApiData] = useState({ tot: [], day: [] }); // 적설 및 신적설
  
  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [testTime, setTestTime] = useState(null); // 테스트용 시각 (2026.03.02 18:00)

  const handleRefresh = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  // When tab changes, reset sub-menu to the first option of the new tab
  useEffect(() => {
    setSelectedSubMenu(SUB_MENUS[selectedTab][0].id);
    setTestTime(null); // 탭 이동 시 테스트 시각 초기화
  }, [selectedTab]);

  // Handle actual API fetching
  useEffect(() => {
    const loadApiData = async () => {
      const isCommentary = selectedTab === 'forecast' && selectedSubMenu === 'commentary';
      const isDoc = selectedTab === 'forecast' && selectedSubMenu === 'doc';
      const isWarning = selectedTab === 'warning';
      const isSnow = selectedTab === 'snow';
      
      if (isCommentary || isDoc || isWarning || isSnow) {
        setIsLoading(true);
        setApiError(null);
        try {
          if (isCommentary) {
            const data = await fetchWeatherCommentary(selectedRegion);
            setApiData(data);
          } else if (isDoc) {
            const data = await fetchWeatherDoc(selectedRegion);
            setDocApiData(data);
          } else if (isWarning) {
            const data = await fetchWeatherWarnings(selectedRegion);
            setWarningApiData(data);
          } else if (isSnow) {
            // 적설과 신적설 모두 페칭 (병렬)
            const [totData, dayData] = await Promise.all([
              fetchSnowData('tot', testTime),
              fetchSnowData('day', testTime)
            ]);
            setSnowApiData({ tot: totData, day: dayData });
          }
        } catch (err) {
          setApiError(err.message);
        } finally {
          setIsLoading(false);
        }
      }
    };
    loadApiData();
  }, [selectedTab, selectedSubMenu, selectedRegion, refreshTrigger, testTime]);


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
      case 'precipitation': {
        const pData = selectedSubMenu === '1h' 
          ? MOCK_PRECIPITATION_1H 
          : selectedSubMenu === 'today' 
            ? MOCK_PRECIPITATION_TODAY 
            : MOCK_PRECIPITATION_YESTERDAY;
        return pData.filter(item => parseFloat(item.record) > 0);
      }
      case 'snow': {
        const sData = selectedSubMenu === 'current' ? snowApiData.tot : snowApiData.day;
        return sData.filter(item => parseFloat(item.record) > 0);
      }
      default:
        return [];
    }
  };

  const getActiveCardData = () => {
    switch (selectedTab) {
      case 'forecast':
        return selectedSubMenu === 'doc' ? docApiData : apiData;
      case 'warning':
        return selectedSubMenu === 'current' ? warningApiData.current : warningApiData.preliminary;
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
          {selectedTab === 'snow' && !testTime && (
            <div className="flex justify-end mb-2">
              <button 
                onClick={() => setTestTime('202603021800')}
                className="text-xs px-3 py-1.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors font-medium flex items-center gap-1.5 shadow-sm"
              >
                <span className="w-2 h-2 bg-amber-400 rounded-full animate-pulse"></span>
                테스트 데이터 불러오기 (2026.03.02)
              </button>
            </div>
          )}
          {selectedTab === 'snow' && testTime && (
            <div className="flex justify-end mb-2">
              <div className="text-xs px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg font-medium shadow-sm">
                현재 테스트 시점: 2026년 3월 2일 18시
              </div>
            </div>
          )}
          <WeatherTable title={`${contentTitle} Top 10`} data={filteredData} />
          {filteredData.length === 0 && (
            <div className="py-12 text-center text-slate-500 bg-white rounded-xl border border-slate-200 shadow-sm">
              {(() => {
                if (selectedTab === 'snow') return '현재 적설이 관측된 지점이 없습니다.';
                if (selectedTab === 'precipitation') return '현재 강수가 관측된 지점이 없습니다.';
                return '해당 지역의 데이터가 없습니다.';
              })()}
            </div>
          )}
        </div>
      );
    } else {
      const isActiveApiCall = (selectedTab === 'forecast' && (selectedSubMenu === 'commentary' || selectedSubMenu === 'doc')) || selectedTab === 'warning';
      const filteredData = isActiveApiCall ? getActiveCardData() : filterByRegion(getActiveCardData());
      
      return (
        <div className="animate-fade-in mt-4 mb-8 h-auto flex flex-col gap-4">
          {selectedTab === 'warning' && (
             <div className="w-full flex justify-center bg-white rounded-xl shadow-sm border border-slate-200 p-4">
               <img 
                 src={getWarningImageUrl(refreshTrigger)} 
                 alt="기상특보 상황도" 
                 className="max-w-full h-auto rounded-lg object-contain" 
                 style={{ maxHeight: '685px' }}
               />
             </div>
          )}
          <ForecastCard 
             data={filteredData} 
             type={selectedTab} 
             isLoading={isActiveApiCall && isLoading}
             error={isActiveApiCall ? apiError : null}
          />
        </div>
      );
    }
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] font-sans selection:bg-blue-200 flex flex-col">
      <Header 
         selectedRegion={selectedRegion} 
         onChangeRegion={setSelectedRegion} 
         onRefresh={handleRefresh} 
      />
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
