import { useEffect, useMemo, useState } from 'react';
import Header from './components/Header';
import Navigation from './components/Navigation';
import WeatherTable from './components/WeatherTable';
import ForecastCard from './components/ForecastCard';
import SubMenu from './components/SubMenu';
import ObservationTimeSelector from './components/ObservationTimeSelector';
import {
  fetchWeatherCommentary,
  fetchWeatherDoc,
  fetchWeatherWarnings,
  getWarningImageUrl,
  fetchWarningImageUrls,
  fetchSnowData,
  fetchServerTemperatureCurrentRankings,
  fetchServerTemperatureTodayRankings,
  fetchServerPrecipitationCurrentRankings,
  fetchServerPrecipitationSinceYesterdayRankings,
  clearWeatherApiCaches,
} from './api/weatherApi';
import { REGIONS, SUB_MENUS } from './data/mockData';

const DEFAULT_UPDATED_AT = new Date();

const EMPTY_STATE_MESSAGE = {
  precipitation: '현재 강수 기록이 있는 지점이 없습니다.',
  snow: '현재 적설 기록이 있는 지점이 없습니다.',
  default: '해당 조건의 데이터가 없습니다.',
};

const SHOW_SUBMENU_TABS = new Set(['forecast', 'warning', 'precipitation', 'minTemp', 'maxTemp', 'snow']);
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const OBSERVATION_TIME_OPTION_COUNT = 4;
const LATEST_OBSERVATION_VALUE = 'latest';
const SNOW_TEST_TIME = '202603021800';
const RANKING_COLLAPSED_LIMIT = 10;
const RANKING_EXPANDED_LIMIT = 30;

const padZero = (value) => value.toString().padStart(2, '0');

const getKstNow = () => new Date(Date.now() + KST_OFFSET_MS);

const formatKmaMinuteTime = (date) => {
  const year = date.getUTCFullYear();
  const month = padZero(date.getUTCMonth() + 1);
  const day = padZero(date.getUTCDate());
  const hour = padZero(date.getUTCHours());
  const minute = padZero(date.getUTCMinutes());
  return `${year}${month}${day}${hour}${minute}`;
};

const formatObservationOptionLabel = (timestamp) => `${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}`;

const floorToQuarterHour = (date) => {
  const rounded = new Date(date);
  rounded.setUTCMinutes(Math.floor(rounded.getUTCMinutes() / 15) * 15, 0, 0);
  return rounded;
};

const buildObservationTimeOptions = (baseDate, selectedValue = LATEST_OBSERVATION_VALUE) => {
  const roundedBase = floorToQuarterHour(baseDate);
  const options = Array.from({ length: OBSERVATION_TIME_OPTION_COUNT }, (_, index) => {
    const optionDate = new Date(roundedBase.getTime() - index * 15 * 60 * 1000);
    const value = formatKmaMinuteTime(optionDate);
    return {
      value,
      label: formatObservationOptionLabel(value),
    };
  });

  if (
    selectedValue &&
    selectedValue !== LATEST_OBSERVATION_VALUE &&
    !options.some((option) => option.value === selectedValue)
  ) {
    options.push({
      value: selectedValue,
      label: `${formatObservationOptionLabel(selectedValue)} 선택됨`,
    });
  }

  return options;
};

function App() {
  const [selectedRegion, setSelectedRegion] = useState('all');
  const [selectedTab, setSelectedTab] = useState('forecast');
  const [selectedSubMenu, setSelectedSubMenu] = useState(SUB_MENUS.forecast[0].id);
  const [apiData, setApiData] = useState([]);
  const [docApiData, setDocApiData] = useState([]);
  const [warningApiData, setWarningApiData] = useState({ current: [], preliminary: [] });
  const [warningImageUrls, setWarningImageUrls] = useState({ current: '', preliminary: '' });
  const [snowApiData, setSnowApiData] = useState({ tot: [], day: [] });
  const [temperatureApiData, setTemperatureApiData] = useState({
    observedAt: '',
    observedLabel: '',
    minCurrent: [],
    maxCurrent: [],
    minToday: [],
    maxToday: [],
  });
  const [precipitationApiData, setPrecipitationApiData] = useState({
    observedAt: '',
    observedLabel: '',
    oneHour: [],
    today: [],
    sinceYesterday: [],
  });
  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [observationTimeMode, setObservationTimeMode] = useState(LATEST_OBSERVATION_VALUE);
  const [observationTimeBase, setObservationTimeBase] = useState(() => getKstNow());
  const [testTime, setTestTime] = useState(null);
  const [snowTestRefreshKey, setSnowTestRefreshKey] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(DEFAULT_UPDATED_AT);
  const [isRankingExpanded, setIsRankingExpanded] = useState(false);

  const handleRefresh = () => {
    clearWeatherApiCaches();
    setObservationTimeBase(getKstNow());
    setRefreshTrigger((previous) => previous + 1);
    setLastUpdatedAt(new Date());
  };

  const handleLoadSnowTestData = () => {
    clearWeatherApiCaches();
    setTestTime(SNOW_TEST_TIME);
    setSnowTestRefreshKey((previous) => previous + 1);
  };

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setObservationTimeBase(getKstNow());
    }, 60 * 1000);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  const selectedObservationTime =
    observationTimeMode === LATEST_OBSERVATION_VALUE ? '' : observationTimeMode;

  const observationTimeOptions = useMemo(
    () => buildObservationTimeOptions(observationTimeBase, observationTimeMode),
    [observationTimeBase, observationTimeMode],
  );

  const isObservationTimeControlVisible =
    selectedTab === 'precipitation' ||
    ((selectedTab === 'minTemp' || selectedTab === 'maxTemp') && selectedSubMenu === 'current');

  const renderObservationTimeControl = () =>
    isObservationTimeControlVisible ? (
      <ObservationTimeSelector
        value={observationTimeMode}
        options={observationTimeOptions}
        onChange={(value) => setObservationTimeMode(value)}
        disabled={isLoading}
      />
    ) : null;

  useEffect(() => {
    const refreshOptions = refreshTrigger > 0 ? { refreshToken: String(refreshTrigger) } : {};
    const timerId = window.setTimeout(() => {
      Promise.allSettled([
        fetchServerTemperatureCurrentRankings(refreshOptions),
        fetchServerTemperatureTodayRankings(refreshOptions),
        fetchServerPrecipitationCurrentRankings(refreshOptions),
        fetchServerPrecipitationSinceYesterdayRankings(refreshOptions),
      ]).catch(() => {});
    }, 1200);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [refreshTrigger]);

  useEffect(() => {
    if (SHOW_SUBMENU_TABS.has(selectedTab)) {
      setSelectedSubMenu(SUB_MENUS[selectedTab][0].id);
    }

    if (selectedTab !== 'snow') {
      setTestTime(null);
    }
  }, [selectedTab]);

  useEffect(() => {
    setIsRankingExpanded(false);
  }, [observationTimeMode, selectedRegion, selectedSubMenu, selectedTab, testTime]);

  useEffect(() => {
    const isCommentary = selectedTab === 'forecast' && selectedSubMenu === 'commentary';
    const isDoc = selectedTab === 'forecast' && selectedSubMenu === 'doc';
    const isWarning = selectedTab === 'warning';

    if (!isCommentary && !isDoc && !isWarning) {
      return undefined;
    }

    let isActive = true;

    const loadApiData = async () => {
      const refreshOptions = refreshTrigger > 0 ? { refreshToken: String(refreshTrigger) } : {};
      setIsLoading(true);
      setApiError(null);

      try {
        if (isCommentary) {
          const data = await fetchWeatherCommentary(selectedRegion, refreshOptions);
          if (isActive) {
            setApiData(data);
          }
        } else if (isDoc) {
          const data = await fetchWeatherDoc(selectedRegion, refreshOptions);
          if (isActive) {
            setDocApiData(data);
          }
        } else if (isWarning) {
          const [data, imageUrls] = await Promise.all([
            fetchWeatherWarnings(selectedRegion, refreshOptions),
            fetchWarningImageUrls(refreshOptions),
          ]);
          if (isActive) {
            setWarningApiData(data);
            setWarningImageUrls(imageUrls);
          }
        }

        if (isActive) {
          setLastUpdatedAt(new Date());
        }
      } catch (error) {
        if (isActive) {
          setApiError(error.message);
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    };

    loadApiData();

    return () => {
      isActive = false;
    };
  }, [refreshTrigger, selectedRegion, selectedSubMenu, selectedTab]);

  useEffect(() => {
    if (selectedTab !== 'minTemp' && selectedTab !== 'maxTemp') {
      return undefined;
    }

    let isActive = true;

    const loadTemperatureData = async () => {
      const refreshOptions = refreshTrigger > 0 ? { refreshToken: String(refreshTrigger) } : {};
      const currentRankingOptions =
        selectedSubMenu === 'current' && selectedObservationTime
          ? { ...refreshOptions, observedAt: selectedObservationTime }
          : refreshOptions;
      setIsLoading(true);
      setApiError(null);

      try {
        const data =
          selectedSubMenu === 'today'
            ? await fetchServerTemperatureTodayRankings(refreshOptions)
            : await fetchServerTemperatureCurrentRankings(currentRankingOptions);
        if (isActive) {
          setTemperatureApiData((previous) => ({
            ...previous,
            ...data,
          }));
          setLastUpdatedAt(new Date());
        }
      } catch (error) {
        if (isActive) {
          setApiError(error.message);
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    };

    loadTemperatureData();

    return () => {
      isActive = false;
    };
  }, [refreshTrigger, selectedObservationTime, selectedSubMenu, selectedTab]);

  useEffect(() => {
    if (selectedTab !== 'precipitation') {
      return undefined;
    }

    let isActive = true;

    const loadPrecipitationData = async () => {
      const refreshOptions = refreshTrigger > 0 ? { refreshToken: String(refreshTrigger) } : {};
      const rankingOptions = selectedObservationTime
        ? { ...refreshOptions, observedAt: selectedObservationTime }
        : refreshOptions;
      setIsLoading(true);
      setApiError(null);

      try {
        const data =
          selectedSubMenu === 'since_yesterday'
            ? await fetchServerPrecipitationSinceYesterdayRankings(rankingOptions)
            : await fetchServerPrecipitationCurrentRankings(rankingOptions);
        if (isActive) {
          setPrecipitationApiData((previous) => ({
            ...previous,
            ...data,
          }));
          setLastUpdatedAt(new Date());
        }
      } catch (error) {
        if (isActive) {
          setApiError(error.message);
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    };

    loadPrecipitationData();

    return () => {
      isActive = false;
    };
  }, [refreshTrigger, selectedObservationTime, selectedSubMenu, selectedTab]);

  useEffect(() => {
    if (selectedTab !== 'snow') {
      return undefined;
    }

    let isActive = true;

    const loadSnowData = async () => {
      const refreshOptions = refreshTrigger > 0 ? { refreshToken: String(refreshTrigger) } : {};
      const snowRefreshOptions = testTime
        ? {
            ...refreshOptions,
            refreshToken: `snow-test-${testTime}-${refreshTrigger}-${snowTestRefreshKey}`,
          }
        : refreshOptions;
      setIsLoading(true);
      setApiError(null);

      try {
        const [totResult, dayResult] = await Promise.allSettled([
          fetchSnowData('tot', testTime, snowRefreshOptions),
          fetchSnowData('day', testTime, snowRefreshOptions),
        ]);

        if (isActive) {
          const totData = totResult.status === 'fulfilled' ? totResult.value : [];
          const dayData = dayResult.status === 'fulfilled' ? dayResult.value : [];

          setSnowApiData({ tot: totData, day: dayData });
          if (totResult.status === 'rejected' && dayResult.status === 'rejected') {
            setApiError(totResult.reason?.message || dayResult.reason?.message);
          } else if (totResult.status === 'rejected' || dayResult.status === 'rejected') {
            setApiError('일부 적설 데이터를 불러오지 못했습니다. 새로고침하면 다시 시도합니다.');
          }
          setLastUpdatedAt(new Date());
        }
      } catch (error) {
        if (isActive) {
          setApiError(error.message);
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    };

    loadSnowData();

    return () => {
      isActive = false;
    };
  }, [refreshTrigger, selectedTab, snowTestRefreshKey, testTime]);

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
      const isExcluded = targetRegion.excludeKeywords?.some((keyword) => searchText.includes(keyword));
      if (isExcluded) {
        return false;
      }

      return targetRegion.keywords.some((keyword) => searchText.includes(keyword));
    });

    if (filtered.length > 0 && filtered[0].rank !== undefined) {
      return filtered.map((item, index) => ({ ...item, rank: index + 1 }));
    }

    return filtered;
  };

  const precipitationData = useMemo(() => {
    if (selectedSubMenu === '1h') return precipitationApiData.oneHour;
    if (selectedSubMenu === 'today') return precipitationApiData.today;
    return precipitationApiData.sinceYesterday;
  }, [precipitationApiData, selectedSubMenu]);

  const snowData = selectedSubMenu === 'current' ? snowApiData.tot : snowApiData.day;
  const rankingLimit = isRankingExpanded ? RANKING_EXPANDED_LIMIT : RANKING_COLLAPSED_LIMIT;
  const getVisibleRankings = (dataArray = []) => dataArray.slice(0, rankingLimit);
  const getRankingExpandProps = (dataArray = []) => ({
    totalCount: dataArray.length,
    canExpand: dataArray.length > RANKING_COLLAPSED_LIMIT,
    isExpanded: isRankingExpanded,
    onToggleExpanded: () => setIsRankingExpanded((previous) => !previous),
  });

  const renderEmptyState = (message, headerAction = null) => (
    <section className="space-y-3">
      {headerAction ? <div className="flex justify-end">{headerAction}</div> : null}
      <div className="rounded-3xl border border-slate-200 bg-white px-6 py-12 text-center text-slate-500 shadow-sm">
        {message}
      </div>
    </section>
  );

  const renderContent = () => {
    if (selectedTab === 'minTemp') {
      if (isLoading) {
        return renderEmptyState('최저기온 데이터를 불러오는 중입니다.', renderObservationTimeControl());
      }

      const tableData =
        selectedSubMenu === 'today' ? temperatureApiData.minToday : temperatureApiData.minCurrent;
      const fullData = filterByRegion(tableData);
      const filteredData = getVisibleRankings(fullData);

      return filteredData.length > 0 ? (
        <WeatherTable
          title="최저기온 Top 10"
          subtitle={
            temperatureApiData.observedLabel
              ? `${selectedSubMenu === 'today' ? '금일 최저기온' : '실시간 관측'} 기준입니다. ${temperatureApiData.observedLabel}`
              : `${selectedSubMenu === 'today' ? '금일 최저기온' : '실시간 관측'} 기준입니다.`
          }
          data={filteredData}
          headerAction={renderObservationTimeControl()}
          {...getRankingExpandProps(fullData)}
        />
      ) : (
        renderEmptyState(EMPTY_STATE_MESSAGE.default, renderObservationTimeControl())
      );
    }

    if (selectedTab === 'maxTemp') {
      if (isLoading) {
        return renderEmptyState('최고기온 데이터를 불러오는 중입니다.', renderObservationTimeControl());
      }

      const tableData =
        selectedSubMenu === 'today' ? temperatureApiData.maxToday : temperatureApiData.maxCurrent;
      const fullData = filterByRegion(tableData);
      const filteredData = getVisibleRankings(fullData);

      return filteredData.length > 0 ? (
        <WeatherTable
          title="최고기온 Top 10"
          subtitle={
            temperatureApiData.observedLabel
              ? `${selectedSubMenu === 'today' ? '금일 최고기온' : '실시간 관측'} 기준입니다. ${temperatureApiData.observedLabel}`
              : `${selectedSubMenu === 'today' ? '금일 최고기온' : '실시간 관측'} 기준입니다.`
          }
          data={filteredData}
          headerAction={renderObservationTimeControl()}
          {...getRankingExpandProps(fullData)}
        />
      ) : (
        renderEmptyState(EMPTY_STATE_MESSAGE.default, renderObservationTimeControl())
      );
    }

    if (selectedTab === 'precipitation') {
      if (isLoading) {
        return renderEmptyState('강수량 데이터를 불러오는 중입니다.', renderObservationTimeControl());
      }

      const fullData = filterByRegion(precipitationData);
      const filteredData = getVisibleRankings(fullData);
      return filteredData.length > 0 ? (
        <WeatherTable
          title="강수량 Top 10"
          subtitle={
            precipitationApiData.observedLabel
              ? `선택한 기준으로 가장 높은 강수 기록을 보여줍니다. ${precipitationApiData.observedLabel}`
              : '선택한 기준으로 가장 높은 강수 기록을 보여줍니다.'
          }
          data={filteredData}
          headerAction={renderObservationTimeControl()}
          {...getRankingExpandProps(fullData)}
        />
      ) : (
        renderEmptyState(EMPTY_STATE_MESSAGE.precipitation, renderObservationTimeControl())
      );
    }

    if (selectedTab === 'snow') {
      const fullData = testTime ? snowData : filterByRegion(snowData);
      const filteredData = getVisibleRankings(fullData);

      return (
        <section className="space-y-4">
          {!testTime ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleLoadSnowTestData}
                className="rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-100"
              >
                테스트 데이터 불러오기 (2026.03.02 18:00)
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              <div className="rounded-full border border-blue-200 bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-700">
                현재 테스트 시점: 2026년 3월 2일 18시
              </div>
              <button
                type="button"
                onClick={handleLoadSnowTestData}
                className="rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-100"
              >
                테스트 데이터 다시 불러오기
              </button>
            </div>
          )}

          {isLoading ? (
            renderEmptyState('적설 데이터를 불러오는 중입니다.')
          ) : filteredData.length > 0 ? (
            <WeatherTable
              title="적설량 Top 10"
              subtitle="현재 적설량과 오늘 신적설량을 탭으로 전환해 확인할 수 있습니다."
              data={filteredData}
              headerAction={renderObservationTimeControl()}
              {...getRankingExpandProps(fullData)}
            />
          ) : (
            renderEmptyState(apiError || EMPTY_STATE_MESSAGE.snow)
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
              src={
                warningImageUrls[selectedSubMenu] ||
                getWarningImageUrl(selectedSubMenu, refreshTrigger)
              }
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
        <p>&copy; {new Date().getFullYear()} KBS Public Safety News Center. All rights reserved.</p>
      </footer>
    </div>
  );
}

export default App;
