// 全局共享类型定义（不依赖 DOM，可同时在浏览器与 Node 测试中运行）

/** 棋盘格状态：空 / 黑 / 白 */
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
/** 识别时无法判定（手遮挡、严重反光等） */
export const UNKNOWN = 3;

export type Cell = typeof EMPTY | typeof BLACK | typeof WHITE;
export type CellLabel = Cell | typeof UNKNOWN;
/** 有颜色的子（黑或白） */
export type StoneColor = typeof BLACK | typeof WHITE;

/** 棋盘尺寸（路数），标准为 19，也支持 13 / 9 */
export type BoardSize = 9 | 13 | 19;

/** 落子坐标，0 起；pass 表示停一手 */
export interface Move {
  color: typeof BLACK | typeof WHITE;
  x: number;
  y: number;
  pass?: boolean;
}

/** 一张照片识别出的棋盘状态（UNKNOWN 表示该交叉点不可判读） */
export interface PhotoObservation {
  /** 标签矩阵，行优先，长度 size*size */
  labels: Uint8Array;
  size: BoardSize;
  /** 每个交叉点的判定置信度 0..1，与 labels 对齐 */
  confidence: Float32Array;
  /** 检出的棋盘四角（原图坐标，顺序：左上、右上、右下、左下） */
  corners: Quad;
  /** 校正后图像边长（像素） */
  warpedSize: number;
  /** 单张照片管线总耗时（毫秒） */
  elapsedMs: number;
  /** 各阶段耗时，用于性能分析 */
  stageMs: Record<string, number>;
}

export interface Point {
  x: number;
  y: number;
}

/** 四边形四角，顺序固定：左上、右上、右下、左下 */
export type Quad = [Point, Point, Point, Point];

/** 两帧之间重建出的落子序列（可能给出多个候选方案） */
export interface Reconstruction {
  moves: Move[];
  /** 与识别结果的吻合程度 0..1，1 为完全吻合 */
  score: number;
  /** 本方案中处于 UNKNOWN 通配状态的交叉点数量 */
  wildcardCells: number;
}

export interface ReconstructionResult {
  reconstructions: Reconstruction[];
  /** 无法通过合法落子解释的差异点（坐标列表） */
  contradictions: Point[];
}

/** 一局棋的持久化记录 */
export interface GameRecord {
  id: string;
  name: string;
  createdAt: number;
  boardSize: BoardSize;
  moves: Move[];
  /** 初始盘面（让子等场景），行优先 */
  initialStones: Cell[];
  /** 关联的照片 id 列表（按拍摄顺序） */
  photoIds: string[];
  komi: number;
}

/** 一张导入照片的元数据 */
export interface PhotoRecord {
  id: string;
  gameId: string;
  /** IndexedDB 中缩略图/原图的键 */
  blobKey: string;
  createdAt: number;
  width: number;
  height: number;
  observation?: PhotoObservation;
  /** 人工校对覆盖：索引 -> 标签 */
  overrides?: Record<number, CellLabel>;
}
