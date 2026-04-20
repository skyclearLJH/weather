import { useEffect, useMemo, useState } from 'react';
import Header from './components/Header';
import Navigation from './components/Navigation';
import WeatherTable from './components/WeatherTable';
import ForecastCard from './components/ForecastCard';
import SubMenu from './components/SubMenu';
import {
  fetchWeatherCommentary,
  fetchWeatherDoc,
  fetchWeatherWarnings,
  getWarningImageUrl,
  fetchSnowData,
} from './api/weatherApi';
import {
  REGIONS,
  SUB_MENUS,
  MOCK_MIN_TEMP_CURRENT,
  MOCK_MIN_TEMP_TODAY,
  MOCK_MAX_TEMP_CURRENT,
  MOCK_MAX_TEMP_TODAY,
  MOCK_PRECIPITATION_1H,
  MOCK_PRECIPITATION_TODAY,
  MOCK_PRECIPITATION_YESTERDAY,
} from './data/mockData';

const DEFAULT_UPDATED_AT = new Date();

const EMPTY_STATE_MESSAGE = {
  precipitation: '현재 강수 기록이 있는 지점이 없습니다.',
  snow: '현재 적설 기록이 있는 지점이 없습니다.',
  default: '해당 조건의 데이터가 없습니다.',
};

const SHOW_SUBMENU_TABS = new Set(['forecast', 'warning', 'precipitation', 'snow']);

function App() {
  const [selectedRegion, setSelectedRegion] = useState('all');
  const [selectedTab, setSelectedTab] = useState('forecast');
  const [selectedSubMenu, setSelectedSubMenu] = useState(SUB_MENUS.forecast[0].id);
  const [apiData, setApiData] = useState([]);
  const [docApiData, setDocApiData] = useState([]);
  const [warningApiData, setWarningApiData] = useState({ current: [], preliminary: [] });
  const [snowApiData, setSnowApiData] = useState({ tot: [], day: [] });
  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [testTime, setTestTime] = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(DEFAULT_UPDATED_AT);

  const handleRefresh = () => {
    setRefreshTrigger((previous) => previous + 1);
    setLastUpdatedAt(new Date());
  };

  useEffect(() => {
    if (SHOW_SUBMENU_TABS.has(selectedTab)) {
      setSelectedSubMenu(SUB_MENUS[selectedTab][0].id);
    }

    if (selectedTab !== 'snow') {
      setTestTime(null);
    }
  }, [selectedTab]);

  useEffect(() => {
    const loadApiData = async () => {
      const isCommentary = selectedTab === 'forecast' && selectedSubMenu === 'commentary';
      const isDoc = selectedTab === 'forecast' && selectedSubMenu === 'doc';
      const isWarning = selectedTab === 'warning';
      const isSnow = selectedTab === 'snow';

      if (!isCommentary && !isDoc && !isWarning && !isSnow) {
        return;
      }

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
          const [totData, dayData] = await Promise.all([
            fetchSnowData('tot', testTime),
            fetchSnowData('day', testTime),
          ]);
          setSnowApiData({ tot: totData, day: dayData });
        }

        setLastUpdatedAt(new Date());
      } catch (error) {
        setApiError(error.message);
      } finally {
        setIsLoading(false);
      }
    };

    loadApiData();
  }, [refreshTrigger, selectedRegion, selectedSubMenu, selectedTab, testTime]);

  const filterByRegion = (dataArray = []) => {
    if (selectedRegion === 'all') {
      return dataArray;
    }

    const targetRegion = REGIONS.find((region) => region.id === selectedRegion);
    if (!targetRegion?.keywords?.length) {
      return dataArray;
    }

    const filtered = dataArray.filter((item) => {
      const searchText = `${item.address ?? ''} ${item.region ?? ''}`.trim();
      return targetRegion.keywords.some((keyword) => searchText.includes(keyword));
    });

    if (filtered.length > 0 && filtered[0].rank !== undefined) {
      return filtered.map((item, index) => ({ ...item, rank: index + 1 }));
    }

    return filtered;
  };

  const precipitationData = useMemo(() => {
    if (selectedSubMenu === '1h') return MOCK_PRECIPITATION_1H;
    if (selectedSubMenu === 'today') return MOCK_PRECIPITATION_TODAY;
    return MOCK_PRECIPITATION_YESTERDAY;
  }, [selectedSubMenu]);

  const snowData = selectedSubMenu === 'current' ? snowApiData.tot : snowApiData.day;

  const renderEmptyState = (message) => (
    <div className="rounded-3xl border border-slate-200 bg-white px-6 py-12 text-center text-slate-500 shadow-sm">
      {message}
    </div>
  );

  const renderDualTables = (title, description, currentData, todayData) => {
    const currentTopTen = filterByRegion(currentData).slice(0, 10);
    const todayTopTen = filterByRegion(todayData).slice(0, 10);

    return (
      <section className="space-y-5">
        <div className="rounded-3xl border border-slate-200 bg-white px-5 py-5 shadow-sm sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#0033a0]">{title}</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{description}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            각 메뉴에서 현재와 오늘 기준 Top 10을 한 번에 비교할 수 있도록 구성했습니다.
          </p>
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          {currentTopTen.length > 0 ? (
            <WeatherTable title="현재 Top 10" subtitle="실시간 관측 기준" data={currentTopTen} />
          ) : (
            renderEmptyState(EMPTY_STATE_MESSAGE.default)
          )}
          {todayTopTen.length > 0 ? (
            <WeatherTable title="오늘 Top 10" subtitle="금일 누적 기준" data={todayTopTen} />
          ) : (
            renderEmptyState(EMPTY_STATE_MESSAGE.default)
          )}
        </div>
      </section>
    );
  };

  const renderContent = () => {
    if (selectedTab === 'minTemp') {
      return renderDualTables('최저기온', '최저기온 현황', MOCK_MIN_TEMP_CURRENT, MOCK_MIN_TEMP_TODAY);
    }

    if (selectedTab === 'maxTemp') {
      return renderDualTables('최고기온', '최고기온 현황', MOCK_MAX_TEMP_CURRENT, MOCK_MAX_TEMP_TODAY);
    }

    if (selectedTab === 'precipitation') {
      const filteredData = filterByRegion(precipitationData).slice(0, 10);

      return filteredData.length > 0 ? (
        <WeatherTable
          title="강수량 Top 10"
          subtitle="선택한 기준으로 가장 높은 강수 기록을 보여줍니다."
          data={filteredData}
        />
      ) : (
        renderEmptyState(EMPTY_STATE_MESSAGE.precipitation)
      );
    }

    if (selectedTab === 'snow') {
      const filteredData = filterByRegion(snowData).slice(0, 10);

      return (
        <section className="space-y-4">
          {!testTime ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setTestTime('202603021800')}
                className="rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-100"
              >
                테스트 데이터 불러오기 (2026.03.02 18:00)
              </button>
            </div>
          ) : (
            <div className="flex justify-end">
              <div className="rounded-full border border-blue-200 bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-700">
                현재 테스트 시점: 2026년 3월 2일 18시
              </div>
            </div>
          )}

          {isLoading ? (
            renderEmptyState('적설 데이터를 불러오는 중입니다.')
          ) : filteredData.length > 0 ? (
            <WeatherTable
              title="적설량 Top 10"
              subtitle="현재 적설량과 오늘 신적설량을 탭으로 전환해 확인할 수 있습니다."
              data={filteredData}
            />
          ) : (
            renderEmptyState(EMPTY_STATE_MESSAGE.snow)
          )}
        </section>
      );
    }

    const isActiveApiCall =
      (selectedTab === 'forecast' && ['commentary', 'doc'].includes(selectedSubMenu)) ||
      selectedTab === 'warning';
    const cardData =
      selectedTab === 'forecast'
        ? selectedSubMenu === 'doc'
          ? docApiData
          : apiData
        : selectedSubMenu === 'current'
          ? warningApiData.current
          : warningApiData.preliminary;

    return (
      <section className="space-y-4">
        {selectedTab === 'warning' ? (
          <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <img
              src={getWarningImageUrl(refreshTrigger)}
              alt="기상특보 상황도"
              className="mx-auto h-auto max-w-full rounded-2xl object-contain"
              style={{ maxHeight: '685px' }}
            />
          </div>
        ) : null}

        <ForecastCard
          data={cardData}
          type={selectedTab}
          isLoading={isActiveApiCall && isLoading}
          error={isActiveApiCall ? apiError : null}
        />
      </section>
    );
  };

  return (
    <div className="min-h-screen text-slate-900">
      <div className="sticky top-0 z-50">
        <Header
          selectedRegion={selectedRegion}
          onChangeRegion={setSelectedRegion}
          onRefresh={handleRefresh}
          lastUpdatedAt={lastUpdatedAt}
          isRefreshing={isLoading}
        />
        <Navigation selectedTab={selectedTab} onSelectTab={setSelectedTab} />
      </div>

      <main className="mx-auto flex w-full max-w-screen-xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        {SHOW_SUBMENU_TABS.has(selectedTab) ? (
          <SubMenu items={SUB_MENUS[selectedTab]} selectedId={selectedSubMenu} onSelect={setSelectedSubMenu} />
        ) : null}

        {renderContent()}
      </main>

      <footer className="border-t border-slate-200 bg-white/80 py-8 text-center text-sm text-slate-500">
        <p>&copy; {new Date().getFullYear()} KBS Disaster Media Center. All rights reserved.</p>
      </footer>
    </div>
  );
}

export default App;
