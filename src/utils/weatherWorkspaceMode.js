export const WORKSPACE_MODES = ['broadcast', 'record', 'edit'];

export const getWorkspaceModeFromLocation = (fallback = 'edit') => {
  const requested = new URLSearchParams(window.location.search).get('mode');
  return WORKSPACE_MODES.includes(requested) ? requested : fallback;
};

export const updateWorkspaceModeInUrl = (mode) => {
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  window.history.replaceState({}, '', url);
};
