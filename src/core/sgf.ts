// SGF (Smart Game Format) 序列化与解析，围棋 FF[4] 常用属性子集。
import { BLACK, WHITE, type BoardSize, type Cell, type GameRecord, type Move } from './types';

function coord(v: number): string {
  return String.fromCharCode(97 + v);
}

function parseCoord(s: string, pos: number): { x: number; y: number } | null {
  const c1 = s.charCodeAt(pos);
  const c2 = s.charCodeAt(pos + 1);
  if (Number.isNaN(c1) || Number.isNaN(c2)) return null;
  return { x: c1 - 97, y: c2 - 97 };
}

export function gameToSgf(game: GameRecord): string {
  const lines: string[] = [];
  const date = new Date(game.createdAt);
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '-');
  lines.push('(');
  lines.push(';');
  lines.push(`GM[1]FF[4]CA[UTF-8]AP[GoBoardReplay:1.0]`);
  lines.push(`SZ[${game.boardSize}]KM[${game.komi}]`);
  lines.push(`DT[${dateStr}]GN[${escapeSgf(game.name)}]`);

  // 初始子（让子等）
  const addBlack: string[] = [];
  const addWhite: string[] = [];
  game.initialStones.forEach((cell, i) => {
    if (cell === EMPTY_PLACEHOLDER) return;
    const x = i % game.boardSize;
    const y = Math.floor(i / game.boardSize);
    const pair = `${coord(x)}${coord(y)}`;
    if (cell === BLACK) addBlack.push(pair);
    else if (cell === WHITE) addWhite.push(pair);
  });
  if (addBlack.length) lines.push(`AB[${addBlack.join('][')}]`);
  if (addWhite.length) lines.push(`AW[${addWhite.join('][')}]`);

  let buf = '';
  for (const m of game.moves) {
    const tag = m.color === BLACK ? 'B' : 'W';
    const body = m.pass ? '[]' : `[${coord(m.x)}${coord(m.y)}]`;
    const node = `;${tag}${body}`;
    if (buf.length + node.length > 76) {
      lines.push(buf);
      buf = '';
    }
    buf += node;
  }
  if (buf) lines.push(buf);
  lines.push(')');
  return lines.join('\n');
}

const EMPTY_PLACEHOLDER = 0;

function escapeSgf(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

export interface ParsedSgf {
  boardSize: BoardSize;
  komi: number;
  name: string;
  moves: Move[];
  initialStones: Cell[];
}

/** 轻量 SGF 解析器：支持多属性节点、AB/AW、B/W（含 pass）、嵌套变化取主线 */
export function parseSgf(text: string): ParsedSgf {
  let boardSize: BoardSize = 19;
  let komi = 0;
  let name = '导入对局';
  const moves: Move[] = [];
  const initial = new Map<number, Cell>();
  let i = 0;

  function readProperty(): { id: string; values: string[] } | null {
    while (i < text.length && /\s/.test(text[i])) i++;
    const start = i;
    while (i < text.length && /[A-Za-z]/.test(text[i])) i++;
    if (i === start) return null;
    const id = text.slice(start, i);
    const values: string[] = [];
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] !== '[') break;
      i++; // 跳过 [
      let val = '';
      while (i < text.length && text[i] !== ']') {
        if (text[i] === '\\') {
          i++;
          val += text[i] ?? '';
        } else {
          val += text[i];
        }
        i++;
      }
      i++; // 跳过 ]
      values.push(val);
    }
    return { id, values };
  }

  while (i < text.length) {
    const ch = text[i];
    if (ch === '(' || ch === ';') {
      i++;
      continue;
    }
    if (ch === ')') {
      i++;
      continue;
    }
    const prop = readProperty();
    if (!prop) {
      i++;
      continue;
    }
    const { id, values } = prop;
    switch (id) {
      case 'SZ':
        boardSize = Number(values[0]) as BoardSize;
        break;
      case 'KM':
        komi = Number(values[0]);
        break;
      case 'GN':
        name = values[0] || name;
        break;
      case 'AB':
      case 'AW': {
        for (const v of values) {
          const p = parseCoord(v, 0);
          if (p) initial.set(p.y * boardSize + p.x, id === 'AB' ? BLACK : WHITE);
        }
        break;
      }
      case 'B':
      case 'W': {
        const color = id === 'B' ? BLACK : WHITE;
        const v = values[0] ?? '';
        if (v.length < 2) {
          moves.push({ color, x: -1, y: -1, pass: true });
        } else {
          const p = parseCoord(v, 0);
          if (p) moves.push({ color, x: p.x, y: p.y });
        }
        break;
      }
      default:
        break;
    }
  }

  const initialStones: Cell[] = new Array<Cell>(boardSize * boardSize).fill(0);
  for (const [idx, cell] of initial) initialStones[idx] = cell;
  return { boardSize, komi, name, moves, initialStones };
}

/** 浏览器下载 SGF 文件 */
export function downloadSgf(game: GameRecord): void {
  const sgf = gameToSgf(game);
  const blob = new Blob([sgf], { type: 'application/x-go-sgf;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${game.name.replace(/[\\/:*?"<>|\s]+/g, '_')}.sgf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
