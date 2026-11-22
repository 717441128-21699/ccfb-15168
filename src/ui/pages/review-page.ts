// 棋谱校对页：逐帧查看识别结果，人工修正标签，查看重建落子与漏拍候选。
import { el, clear, toast } from '../dom';
import { navigate } from '../router';
import { getGame, listPhotos, saveOverrides } from '../../state/storage';
import { buildSession, chooseCandidate, type Session } from '../../state/session';
import { renderBoard, legend } from '../board-view';
import { BLACK, WHITE, EMPTY, UNKNOWN, type CellLabel, type Move, type PhotoRecord } from '../../core/types';

export async function renderReviewPage(root: HTMLElement, gameId: string): Promise<void> {
  clear(root);
  const gameMaybe = await getGame(gameId);
  if (!gameMaybe) {
    root.append(el('div', { class: 'card' }, '对局不存在。'));
    return;
  }
  const game = gameMaybe;
  const photos = await listPhotos(gameId);
  if (photos.length === 0) {
    const card = el('div', { class: 'card' }, '还没有照片。');
    const btn = el('button', {}, '去导入照片');
    btn.addEventListener('click', () => navigate(`/recognize/${gameId}`));
    card.append(btn);
    root.append(card);
    return;
  }

  let frameIndex = 0;
  // 本地覆盖缓存，键为 photoId -> (index -> label)
  const overrideDraft = new Map<string, Record<number, CellLabel>>();
  let session: Session = buildSession(game, photos.map(toSessionInput));

  const boardCard = el('div', { class: 'card' });
  const infoCard = el('div', { class: 'card' });

  function currentPhoto(): PhotoRecord {
    return photos[frameIndex];
  }

  function currentLabels(): Uint8Array {
    const photo = currentPhoto();
    const draft = overrideDraft.get(photo.id);
    const base = photo.observation?.labels ?? new Uint8Array(game.boardSize * game.boardSize);
    if (!draft) return new Uint8Array(base);
    const merged = new Uint8Array(base);
    for (const [k, v] of Object.entries(draft)) merged[Number(k)] = v;
    return merged;
  }

  function render(): void {
    clear(boardCard);
    clear(infoCard);
    const photo = currentPhoto();
    const frame = session.frames[frameIndex];
    const labels = currentLabels();
    const unknownCount = [...labels].filter((l) => l === UNKNOWN).length;
    const contradictions = new Set(frame?.contradictions ?? []);

    // 顶部帧导航
    const nav = el('div', { class: 'toolbar flex-between' });
    const prev = el('button', { class: 'secondary' }, '上一张');
    prev.disabled = frameIndex === 0;
    prev.addEventListener('click', () => {
      frameIndex--;
      render();
    });
    const next = el('button', { class: 'secondary' }, '下一张');
    next.disabled = frameIndex === photos.length - 1;
    next.addEventListener('click', () => {
      frameIndex++;
      render();
    });
    const title = el('strong', {}, `第 ${frameIndex + 1}/${photos.length} 张`);
    nav.append(prev, title, next);

    // 棋盘（可点击循环切换 空->黑->白->未知->空）
    const board = renderBoard({
      size: game.boardSize,
      labels,
      highlights: contradictions,
      interactive: true,
      onCellClick: (idx) => cycleLabel(photo.id, idx),
    });
    const boardWrap = el('div', { class: 'board-wrap' }, board);

    const stats = el('div', { class: 'legend' });
    stats.append(
      el('span', {}, `黑子 ${countLabel(labels, BLACK)}`),
      el('span', {}, `白子 ${countLabel(labels, WHITE)}`),
      el('span', { class: unknownCount ? '' : '' }, `未知 ${unknownCount}`),
    );

    boardCard.append(nav, legend(), boardWrap, stats, el('p', { class: 'meta' }, '点击交叉点可循环修改：空 → 黑 → 白 → 未知。红框是规则无法解释的矛盾点。'));

    // 信息面板
    infoCard.append(el('h3', { style: 'margin-top:0' }, '本帧重建'));
    if (!frame) {
      infoCard.append(el('p', { class: 'meta' }, '该照片尚未识别。'));
    } else {
      if (frame.contradictions.length) {
        infoCard.append(el('p', {}, el('span', { class: 'badge warn' }, `矛盾点 ${frame.contradictions.length} 个（请在棋盘上核对）`)));
      } else if (!frame.ok) {
        infoCard.append(el('p', {}, el('span', { class: 'badge warn' }, '重建失败，需人工修正标签')));
      } else {
        infoCard.append(el('p', {}, el('span', { class: 'badge' }, `重建出 ${frame.intervalMoves.length} 手，无矛盾`)));
      }
      const moveTable = renderMoves(frame.intervalMoves);
      infoCard.append(moveTable);

      // 漏拍候选
      if (frame.candidates.length > 1) {
        infoCard.append(el('h4', {}, '漏拍候选走法（按可能性排序，点选采纳）'));
        frame.candidates.forEach((cand, ci) => {
          const selected = frame.intervalMoves === cand.moves || sameMoves(cand.moves, frame.intervalMoves);
          const div = el('div', { class: `candidate${selected ? ' selected' : ''}` });
          div.append(
            el('div', { class: 'flex-between' },
              el('strong', {}, `方案 ${ci + 1} · ${cand.moves.length} 手`),
              el('span', { class: 'meta' }, `吻合度 ${(cand.score * 100).toFixed(0)}%`),
            ),
            el('div', { class: 'meta' }, cand.moves.map(moveText).join('　')),
          );
          div.addEventListener('click', () => {
            session = chooseCandidate(session, frameIndex, ci);
            toast('已采纳该方案');
            render();
          });
          infoCard.append(div);
        });
      }
    }

    // 保存覆盖按钮
    const saveBtn = el('button', {}, '保存本帧校对');
    saveBtn.addEventListener('click', async () => {
      const draft = overrideDraft.get(photo.id) ?? {};
      await saveOverrides(photo.id, draft);
      photo.overrides = draft; // 回写内存，确保随后的重建读到最新覆盖
      session = buildSession(game, photos.map(toSessionInput));
      toast('校对已保存，重建已更新');
      render();
    });
    const resetBtn = el('button', { class: 'secondary' }, '还原本帧');
    resetBtn.addEventListener('click', () => {
      overrideDraft.delete(photo.id);
      photo.overrides = {};
      session = buildSession(game, photos.map(toSessionInput));
      render();
    });
    const exportBtn = el('button', { class: 'secondary' }, '去导出');
    exportBtn.addEventListener('click', () => navigate(`/export/${gameId}`));
    infoCard.append(el('div', { class: 'toolbar' }, saveBtn, resetBtn, exportBtn));
  }

  function cycleLabel(photoId: string, idx: number): void {
    const order: CellLabel[] = [EMPTY, BLACK, WHITE, UNKNOWN];
    const labels = currentLabels();
    const cur = labels[idx] as CellLabel;
    const nextLabel = order[(order.indexOf(cur) + 1) % order.length];
    const draft = overrideDraft.get(photoId) ?? {};
    draft[idx] = nextLabel;
    overrideDraft.set(photoId, draft);
    render();
  }

  render();
  root.append(boardCard, infoCard);
}

function toSessionInput(p: PhotoRecord): { id: string; observation?: PhotoRecord['observation']; overrides?: PhotoRecord['overrides'] } {
  return { id: p.id, observation: p.observation, overrides: p.overrides };
}

function countLabel(labels: ArrayLike<number>, label: number): number {
  let n = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] === label) n++;
  return n;
}

function renderMoves(moves: Move[]): HTMLElement {
  if (!moves.length) return el('p', { class: 'meta' }, '本帧与上一帧之间无新增落子。');
  const table = el('table');
  table.append(el('thead', {}, el('tr', {}, el('th', {}, '手序'), el('th', {}, '颜色'), el('th', {}, '坐标'))));
  const tbody = el('tbody');
  moves.forEach((m, i) => {
    tbody.append(
      el('tr', {},
        el('td', {}, String(i + 1)),
        el('td', {}, m.color === BLACK ? '黑' : '白'),
        el('td', {}, m.pass ? '停一手' : coordText(m.x, m.y)),
      ),
    );
  });
  table.append(tbody);
  return table;
}

function moveText(m: Move): string {
  return `${m.color === BLACK ? '黑' : '白'}${m.pass ? ' pass' : coordText(m.x, m.y)}`;
}

function sameMoves(a: Move[], b: Move[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => m.x === b[i].x && m.y === b[i].y && m.color === b[i].color);
}

function coordText(x: number, y: number): string {
  const col = String.fromCharCode(65 + x);
  return `${col}${y + 1}`;
}
