// 개발 전용: 숨김 탭(백그라운드)에서는 requestAnimationFrame이 완전히 멈춰
// MapLibre 렌더·load 이벤트가 진행되지 않는다. 자동화된 검증(헤드리스 브라우저
// 패널)에서 지도를 확인할 수 있도록, localStorage.rafShim === '1'일 때만
// rAF를 setTimeout 기반으로 대체한다. 운영 번들에서는 아무 것도 하지 않는다.
if (import.meta.env.DEV && window.localStorage?.getItem('rafShim') === '1') {
  window.requestAnimationFrame = (callback) =>
    window.setTimeout(() => callback(performance.now()), 33);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  console.log('[devRafShim] requestAnimationFrame -> setTimeout 대체 활성');
}
