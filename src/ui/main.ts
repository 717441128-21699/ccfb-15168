// 应用入口：挂载路由与四个页面
import './styles.css';
import { el, clear } from './dom';
import { parseHash, onRouteChange, navigate, type Route } from './router';
import { renderGamesPage } from './pages/games-page';
import { renderRecognizePage } from './pages/recognize-page';
import { renderReviewPage } from './pages/review-page';
import { renderExportPage } from './pages/export-page';

const appEl = document.getElementById('app');
if (!appEl) throw new Error('找不到 #app 挂载点');
const app: HTMLElement = appEl;

function header(active: string): HTMLElement {
  const tabs: Array<[string, string, string]> = [
    ['games', '对局列表', '#/games'],
  ];
  const nav = el('nav', { class: 'tabs' });
  for (const [key, label, hash] of tabs) {
    nav.append(el('a', { href: hash, class: active === key ? 'active' : '' }, label));
  }
  return el('header', { class: 'app-header' }, el('h1', {}, '围棋复盘 · 照片棋谱还原'), nav);
}

async function route(): Promise<void> {
  const r: Route = parseHash();
  clear(app);
  app.append(header(r.name));
  const view = el('div', {});
  app.append(view);
  try {
    switch (r.name) {
      case 'games':
        await renderGamesPage(view);
        break;
      case 'recognize':
        await renderRecognizePage(view, r.gameId);
        break;
      case 'review':
        await renderReviewPage(view, r.gameId);
        break;
      case 'export':
        await renderExportPage(view, r.gameId);
        break;
    }
  } catch (err) {
    view.append(
      el('div', { class: 'card' }, `页面出错：${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

// 子页面里的导航按钮用 navigate(...) 跳转，统一在 header 提供返回列表入口
onRouteChange(() => void route());
if (!location.hash) navigate('/games');
void route();
