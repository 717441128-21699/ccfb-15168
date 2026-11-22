// 极简哈希路由：#/games、#/recognize/:gameId、#/review/:gameId、#/export/:gameId
export type Route =
  | { name: 'games' }
  | { name: 'recognize'; gameId: string }
  | { name: 'review'; gameId: string }
  | { name: 'export'; gameId: string };

export function parseHash(): Route {
  const hash = location.hash.replace(/^#/, '') || '/games';
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'recognize' && parts[1]) return { name: 'recognize', gameId: parts[1] };
  if (parts[0] === 'review' && parts[1]) return { name: 'review', gameId: parts[1] };
  if (parts[0] === 'export' && parts[1]) return { name: 'export', gameId: parts[1] };
  return { name: 'games' };
}

export function navigate(path: string): void {
  location.hash = path;
}

export function onRouteChange(handler: (route: Route) => void): void {
  window.addEventListener('hashchange', () => handler(parseHash()));
}
