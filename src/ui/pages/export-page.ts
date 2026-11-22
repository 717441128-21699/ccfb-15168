// 导出页：棋谱摘要、SGF 预览、下载
import { el, clear, toast } from '../dom';
import { navigate } from '../router';
import { getGame, listPhotos } from '../../state/storage';
import { buildSession } from '../../state/session';
import { gameToSgf, downloadSgf, parseSgf } from '../../core/sgf';
import { renderBoard } from '../board-view';
import { currentBoard } from '../../state/session';
import { BLACK, WHITE } from '../../core/types';

export async function renderExportPage(root: HTMLElement, gameId: string): Promise<void> {
  clear(root);
  const game = await getGame(gameId);
  if (!game) {
    root.append(el('div', { class: 'card' }, '对局不存在。'));
    return;
  }
  const photos = await listPhotos(gameId);
  const session = buildSession(game, photos.map((p) => ({ id: p.id, observation: p.observation, overrides: p.overrides })));
  // 用会话重建出的落子更新一份临时 game 用于导出
  const exportGame = { ...game, moves: session.moves };
  const sgf = gameToSgf(exportGame);
  const board = currentBoard(session.moves, game.boardSize, game.initialStones);

  const summary = el('div', { class: 'card' });
  const blackCap = board.captures[BLACK] ?? 0;
  const whiteCap = board.captures[WHITE] ?? 0;
  summary.append(
    el('h2', { style: 'margin-top:0' }, game.name),
    el('p', { class: 'meta' },
      `${game.boardSize} 路 · 共 ${session.moves.length} 手 · ${photos.length} 张照片 · 贴目 ${game.komi} · 黑提 ${blackCap} / 白提 ${whiteCap}`),
  );
  const unresolved = session.frames.filter((f) => !f.ok).length;
  if (unresolved) {
    summary.append(el('p', {}, el('span', { class: 'badge warn' }, `还有 ${unresolved} 帧存在矛盾，建议先回校对页修正`)));
  } else {
    summary.append(el('p', {}, el('span', { class: 'badge' }, '全部帧重建无矛盾，可以导出')));
  }

  const boardCard = el('div', { class: 'card' });
  boardCard.append(el('h3', { style: 'margin-top:0' }, '最终盘面'));
  boardCard.append(el('div', { class: 'board-wrap' }, renderBoard({ size: game.boardSize, labels: board.stones })));

  const sgfCard = el('div', { class: 'card' });
  const pre = el('textarea', {
    readonly: 'true',
    style: 'width:100%;min-height:220px;font-family:monospace;font-size:12px;',
  }) as HTMLTextAreaElement;
  pre.value = sgf;
  const roundtrip = parseSgf(sgf);
  const toolbar = el('div', { class: 'toolbar' });
  const downloadBtn = el('button', {}, '下载 SGF 文件');
  downloadBtn.addEventListener('click', () => {
    downloadSgf(exportGame);
    toast('SGF 已下载');
  });
  const copyBtn = el('button', { class: 'secondary' }, '复制 SGF 文本');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(sgf);
      toast('已复制到剪贴板');
    } catch {
      toast('复制失败，请手动选择文本');
    }
  });
  const reviewBtn = el('button', { class: 'secondary' }, '返回校对');
  reviewBtn.addEventListener('click', () => navigate(`/review/${gameId}`));
  toolbar.append(downloadBtn, copyBtn, reviewBtn);
  sgfCard.append(
    el('h3', { style: 'margin-top:0' }, 'SGF 预览'),
    pre,
    el('p', { class: 'meta' }, `解析回读校验：${roundtrip.moves.length} 手（与导出一致：${roundtrip.moves.length === session.moves.length ? '是' : '否'}）`),
    toolbar,
  );

  root.append(summary, boardCard, sgfCard);
}
