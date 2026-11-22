// 对局列表页：新建对局、查看/删除既有对局
import { el, clear, toast } from '../dom';
import { navigate } from '../router';
import { listGames, deleteGame, createGame, putGame } from '../../state/storage';
import type { BoardSize } from '../../core/types';

export async function renderGamesPage(root: HTMLElement): Promise<void> {
  clear(root);
  const games = await listGames();

  const createCard = el('div', { class: 'card' });
  const nameInput = el('input', { placeholder: '对局名称，如：周六提高班 A 组', style: 'min-width:220px' }) as HTMLInputElement;
  const sizeSelect = el('select') as HTMLSelectElement;
  for (const s of [19, 13, 9]) {
    const opt = el('option', { value: String(s) }, `${s} 路棋盘`);
    sizeSelect.append(opt);
  }
  const createBtn = el('button', {}, '新建对局');
  createBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim() || `对局 ${new Date().toLocaleString('zh-CN')}`;
    const game = createGame(name, Number(sizeSelect.value) as BoardSize);
    await putGame(game);
    toast('已创建，进入照片识别');
    navigate(`/recognize/${game.id}`);
  });
  createCard.append(
    el('h2', { style: 'margin-top:0' }, '新建对局'),
    el('div', { class: 'toolbar' }, nameInput, sizeSelect, createBtn),
    el('p', { class: 'meta' }, '家长每拍几张照片导入，系统自动透视校正、识别交叉点、按落子规则还原棋谱，最后可导出 SGF。'),
  );

  const listCard = el('div', { class: 'card' });
  listCard.append(el('h2', { style: 'margin-top:0' }, `对局列表（${games.length}）`));
  if (games.length === 0) {
    listCard.append(el('p', { class: 'meta' }, '还没有对局，先在上方新建一个。'));
  } else {
    const wrap = el('div', { class: 'game-list' });
    for (const game of games) {
      const item = el('div', { class: 'game-item' });
      const info = el('div', {},
        el('strong', {}, game.name),
        el('div', { class: 'meta' },
          `${game.boardSize} 路 · ${game.moves.length} 手 · ${game.photoIds.length} 张照片 · ${new Date(game.createdAt).toLocaleString('zh-CN')}`),
      );
      const actions = el('div', { class: 'toolbar', style: 'margin:0' });
      const openBtn = el('button', {}, '识别照片');
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigate(`/recognize/${game.id}`);
      });
      const reviewBtn = el('button', { class: 'secondary' }, '校对棋谱');
      reviewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigate(`/review/${game.id}`);
      });
      const delBtn = el('button', { class: 'danger' }, '删除');
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`确定删除「${game.name}」及其全部照片？`)) return;
        await deleteGame(game.id);
        toast('已删除');
        renderGamesPage(root);
      });
      actions.append(openBtn, reviewBtn, delBtn);
      item.append(info, actions);
      item.addEventListener('click', () => navigate(`/recognize/${game.id}`));
      wrap.append(item);
    }
    listCard.append(wrap);
  }

  root.append(createCard, listCard);
}
