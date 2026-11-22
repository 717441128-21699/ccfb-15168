// 照片识别页：导入手机照片 -> 逐张识别（WebGL2 优先）-> 展示状态与耗时
import { el, clear, toast } from '../dom';
import { navigate } from '../router';
import {
  getGame,
  listPhotos,
  putPhoto,
  getPhotoBlob,
  newId,
  putGame,
} from '../../state/storage';
import { recognizePhoto, type RecognitionBackend } from '../../webgl/pipeline-gl';
import { runPipeline } from '../../core/pipeline';
import { Rng } from '../../core/rng';
import { renderScene, LIGHTING_PRESETS } from '../../synth/scene';
import { generateGame, specToRenderConfig, buildSampleSpecs } from '../../../tools/scenarios';
import type { PhotoRecord } from '../../core/types';

interface QueueItem {
  file: File;
  status: 'pending' | 'running' | 'done' | 'error';
  elapsed?: number;
  backend?: RecognitionBackend;
  error?: string;
  thumbUrl?: string;
}

export async function renderRecognizePage(root: HTMLElement, gameId: string): Promise<void> {
  clear(root);
  const gameMaybe = await getGame(gameId);
  if (!gameMaybe) {
    root.append(el('div', { class: 'card' }, '对局不存在，请返回列表。'));
    return;
  }
  const game = gameMaybe;

  const queue: QueueItem[] = [];
  const listCard = el('div', { class: 'card' });
  const progressBar = el('div', { class: 'progress' });
  const progressFill = el('div', { style: 'width:0%' });
  progressBar.append(progressFill);
  const statusLine = el('p', { class: 'meta' }, '支持多选导入；每张照片识别后立即显示结果。');

  const dropzone = el('div', { class: 'dropzone' }, '点击选择，或把手机照片拖到这里（可多选）');
  const fileInput = el('input', {
    type: 'file',
    accept: 'image/*',
    multiple: 'multiple',
    style: 'display:none',
  }) as HTMLInputElement;
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    enqueue(files);
  });
  fileInput.addEventListener('change', () => enqueue(Array.from(fileInput.files ?? [])));

  const queueWrap = el('div', { class: 'photo-grid' });

  function enqueue(files: File[]): void {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const item: QueueItem = { file, status: 'pending' };
      item.thumbUrl = URL.createObjectURL(file);
      queue.push(item);
    }
    renderQueue();
    void processQueue();
  }

  function renderQueue(): void {
    clear(queueWrap);
    for (const item of queue) {
      const thumb = el('div', { class: 'photo-thumb' });
      if (item.thumbUrl) thumb.append(el('img', { src: item.thumbUrl, alt: item.file.name }));
      const badge =
        item.status === 'done'
          ? el('span', { class: 'badge status' }, `${item.backend?.mode ?? ''} ${item.elapsed?.toFixed(0)}ms`)
          : item.status === 'running'
            ? el('span', { class: 'badge unknown status' }, '识别中…')
            : item.status === 'error'
              ? el('span', { class: 'badge warn status' }, '失败')
              : el('span', { class: 'badge status' }, '等待');
      thumb.append(badge);
      queueWrap.append(thumb);
    }
    const done = queue.filter((q) => q.status === 'done').length;
    progressFill.style.width = `${queue.length ? (done / queue.length) * 100 : 0}%`;
    statusLine.textContent = `已完成 ${done}/${queue.length} 张`;
  }

  async function processQueue(): Promise<void> {
    const pending = queue.filter((q) => q.status === 'pending');
    for (const item of pending) {
      item.status = 'running';
      renderQueue();
      try {
        const bitmap = await createImageBitmap(item.file);
        const t0 = performance.now();
        const { observation, backend } = await recognizePhoto(bitmap, game.boardSize);
        const elapsed = performance.now() - t0;
        item.status = 'done';
        item.elapsed = elapsed;
        item.backend = backend;
        const photoId = newId('photo');
        const photo: PhotoRecord = {
          id: photoId,
          gameId,
          blobKey: `blob-${photoId}`,
          createdAt: Date.now(),
          width: bitmap.width,
          height: bitmap.height,
          observation,
        };
        await putPhoto(photo, item.file);
        if (!game.photoIds.includes(photoId)) game.photoIds.push(photoId);
        await putGame(game);
        bitmap.close();
      } catch (err) {
        item.status = 'error';
        item.error = err instanceof Error ? err.message : String(err);
      }
      renderQueue();
    }
    const failed = queue.filter((q) => q.status === 'error').length;
    if (failed) toast(`${failed} 张识别失败，可重新导入`);
  }

  const navBar = el('div', { class: 'toolbar' });
  const reviewBtn = el('button', {}, '去棋谱校对');
  reviewBtn.addEventListener('click', () => navigate(`/review/${gameId}`));
  const exportBtn = el('button', { class: 'secondary' }, '去导出 SGF');
  exportBtn.addEventListener('click', () => navigate(`/export/${gameId}`));
  const demoBtn = el('button', { class: 'secondary' }, '载入 3 张演示样例');
  demoBtn.addEventListener('click', () => void loadDemoSamples());
  navBar.append(demoBtn, reviewBtn, exportBtn);

  // 浏览器内合成演示照片并走真实 CPU 管线，便于无照片时体验全流程
  async function loadDemoSamples(): Promise<void> {
    const rng = new Rng(Date.now() & 0xffffffff);
    const scenario = generateGame(`demo-${game.photoIds.length}`, game.boardSize, rng, 90);
    const W = 720;
    const H = 540;
    const specs = buildSampleSpecs([scenario], rng, W, H).filter(
      (s) => s.artifact === 'clean' || s.artifact === 'glare' || s.artifact === 'hand',
    );
    const picked = [specs[0], specs[Math.floor(specs.length / 2)], specs[specs.length - 1]];
    for (const spec of picked) {
      const cfg = specToRenderConfig(spec, LIGHTING_PRESETS[spec.lighting], W, H, 1);
      const scene = renderScene(cfg);
      const observation = runPipeline(scene.image, game.boardSize, { knownQuad: spec.quad });
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const c2 = canvas.getContext('2d');
      if (!c2) continue;
      c2.putImageData(scene.image.toImageData(), 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) continue;
      const photoId = newId('photo');
      const photo: PhotoRecord = {
        id: photoId,
        gameId,
        blobKey: `blob-${photoId}`,
        createdAt: Date.now(),
        width: W,
        height: H,
        observation,
      };
      await putPhoto(photo, blob);
      if (!game.photoIds.includes(photoId)) game.photoIds.push(photoId);
      await putGame(game);
    }
    toast('演示样例已生成并识别');
    renderRecognizePage(root, gameId);
  }

  // 已存照片回显
  const existing = await listPhotos(gameId);
  const existingCard = el('div', { class: 'card' });
  existingCard.append(el('h3', { style: 'margin-top:0' }, `已导入 ${existing.length} 张`));
  if (existing.length) {
    const grid = el('div', { class: 'photo-grid' });
    for (const p of existing) {
      const blob = await getPhotoBlob(p.blobKey);
      const url = blob ? URL.createObjectURL(blob) : '';
      const thumb = el('div', { class: 'photo-thumb' });
      if (url) thumb.append(el('img', { src: url, alt: p.id }));
      const obs = p.observation;
      thumb.append(
        el(
          'span',
          { class: 'badge status' },
          obs ? `${obs.elapsedMs.toFixed(0)}ms` : '未识别',
        ),
      );
      grid.append(thumb);
    }
    existingCard.append(grid);
  }

  listCard.append(
    el('h2', { style: 'margin-top:0' }, `照片识别 · ${game.name}`),
    dropzone,
    fileInput,
    statusLine,
    progressBar,
    queueWrap,
  );
  root.append(listCard, existingCard, el('div', { class: 'card' }, navBar));
}
