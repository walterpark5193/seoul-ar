// 서울 25구 3D 씬 (CONTRACTS 4절). 좌표: x 동쪽, z 남쪽, y 위. 도시 전체가 [-0.5, 0.5]² 안.
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Shape,
  Vector2,
  Vector3,
} from "three";
import type { Camera, Sprite } from "three";
import type { Geo, GuShape } from "../geo/types";
import type { Stat, GuData, Metric } from "../data/types";
import { PALETTE, colorFor, normalize } from "./colors";
import { BAR_MIN_HEIGHT, boundsOf, layoutBars } from "./layout";
import { canvasTextTexture, disposeLabel, makeLabelSprite } from "./labels";

export interface SeoulScene {
  group: Group;                                                    // 부모(AR 앵커 또는 월드)에 add
  setOverview(summary: Record<string, Stat>, metric: Metric): void; // 25구 색 갱신(전체 보기)
  focus(gu: string | null, data: GuData | null, metric: Metric): void; // 구 상승 + 법정동 막대. null이면 전체 보기
  setMetric(metric: Metric): void;                                  // 현재 focus/overview를 새 지표로 다시 그림
  update(dt: number, camera: Camera): void;                         // 매 프레임: 애니메이션, 라벨 빌보드
  dispose(): void;
}
export interface SceneOptions { reducedMotion?: boolean; makeTextTexture?: (text: string, color: string) => import("three").Texture | null; }

/** 구 돌출 두께 */
export const GU_DEPTH = 0.02;
/** 선택 구 상승 높이 */
export const GU_LIFT = 0.03;
/** 성장 애니메이션 길이(초) */
export const GROW_SECONDS = 0.6;
/** 막대 인스턴스 최대 수 */
export const MAX_BARS = 128;

/** ease-out cubic: 1-(1-t)^3 */
export function easeOutCubic(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t));
  return 1 - u * u * u;
}

const MIN_BAR_SCALE = 1e-4; // 높이 0 스케일은 인스턴스 법선 계산에서 0으로 나누기가 된다
const OUTLINE_LIFT = 0.0005; // 윗면 윤곽선이 윗면과 z-fighting 하지 않게
const LABEL_TOP_N = 5;
const DONG_LABEL_H = 0.03;
const GU_LABEL_H = 0.05;
const LABEL_CLEAR = 0.03; // 가장 높은 막대 위 여백
const LABEL_STEP = 0.04; // 라벨끼리 세로 간격(> DONG_LABEL_H 이라 겹치지 않음)

interface GuEntry {
  shape: GuShape;
  mesh: Mesh<ExtrudeGeometry, MeshStandardMaterial>;
  outline: LineSegments<BufferGeometry, LineBasicMaterial>;
  overview: string; // 전체 보기 색
  fromY: number;
  toY: number;
  fromColor: Color; // 윗면 색 보간(선형 공간)
  toColor: Color;
  fromLine: Color; // 윤곽선 색 보간
  toLine: Color;
}

/** 막대 하나의 모습. h는 높이, color는 인스턴스 색(선형). */
interface BarSnap { x: number; z: number; size: number; h: number; color: Color; }

/** 이름(법정동)으로 이어지는 막대 하나. 달이 바뀌어도 같은 이름이면 같은 상태가 이어진다. */
interface BarState {
  name: string;
  value: number | null; // 대상 값(라벨용)
  from: BarSnap;
  to: BarSnap;
  cur: BarSnap; // 지금 그려진 모습
  leaving: boolean; // 대상에 없는 동: 0.02로 줄어든 뒤 애니메이션 끝에 빠진다
}

interface LabelEntry {
  sprite: Sprite;
  bar: BarState | null; // null이면 구 이름 라벨
  y: number; // 구 윗면 기준 라벨 아래쪽 높이
}

function snap(x: number, z: number, size: number, h: number, color: Color | string): BarSnap {
  return { x, z, size, h, color: new Color().set(color) };
}

function cloneSnap(a: BarSnap): BarSnap {
  return { x: a.x, z: a.z, size: a.size, h: a.h, color: a.color.clone() };
}

/** e >= 1이면 목표값을 그대로(부동소수 오차 없이) */
function mix(a: number, b: number, e: number): number {
  return e >= 1 ? b : a + (b - a) * e;
}

function mixColor(out: Color, a: Color, b: Color, e: number): void {
  if (e >= 1) out.copy(b);
  else out.lerpColors(a, b, e);
}

function guGeometry(rings: [number, number][][]): ExtrudeGeometry {
  const shapes: Shape[] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    // 모양 평면 (x, -z)에 그리고 +Z로 돌출한 뒤 X축 -90° 회전 → (x, 0..depth, z)
    shapes.push(new Shape(ring.map(([x, z]) => new Vector2(x, -z))));
  }
  const g = new ExtrudeGeometry(shapes, { depth: GU_DEPTH, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  return g;
}

function outlineGeometry(rings: [number, number][][]): BufferGeometry {
  const y = GU_DEPTH + OUTLINE_LIFT;
  const pts: number[] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      pts.push(a[0], y, a[1], b[0], y, b[1]);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pts, 3));
  return g;
}

function statValue(s: Stat | undefined, metric: Metric): number | null {
  if (!s) return null;
  return metric === "price" ? s.medPerM2 : s.n;
}

function fmtInt(v: number): string {
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function dongLabelText(name: string, value: number | null, metric: Metric): string {
  const v = value ?? 0;
  return metric === "price" ? `${name} ${fmtInt(v)}만원/㎡` : `${name} ${fmtInt(v)}건`;
}

export function createSeoulScene(geo: Geo, opts: SceneOptions = {}): SeoulScene {
  const reducedMotion = opts.reducedMotion === true;
  const makeText = opts.makeTextTexture ?? canvasTextTexture;

  const group = new Group();
  group.name = "seoul-scene";

  // 조명은 group 안에: AR 앵커 아래에서도 같이 움직인다. 방향광 target도 group에 넣어야 방향이 앵커를 따른다.
  const hemi = new HemisphereLight(0xffffff, PALETTE.bg, 1.8);
  const sun = new DirectionalLight(0xffffff, 1.8);
  sun.position.set(0.4, 1.2, 0.7);
  sun.target.position.set(0, 0, 0);
  group.add(hemi, sun, sun.target);

  // 25구: 구마다 메시 하나, 재질 하나(색이 따로 바뀐다)
  const gus: GuEntry[] = [];
  const byName = new Map<string, GuEntry>();
  for (const shape of geo.gus) {
    const mesh = new Mesh(
      guGeometry(shape.rings),
      new MeshStandardMaterial({ color: PALETTE.guBase, roughness: 0.85, metalness: 0.05 }),
    );
    mesh.name = shape.name;
    mesh.userData.gu = shape.name;
    const outline = new LineSegments(outlineGeometry(shape.rings), new LineBasicMaterial({ color: PALETTE.bg }));
    outline.name = `${shape.name}:outline`;
    mesh.add(outline);
    group.add(mesh);
    const entry: GuEntry = {
      shape, mesh, outline, overview: PALETTE.guBase, fromY: 0, toY: 0,
      fromColor: new Color(PALETTE.guBase), toColor: new Color(PALETTE.guBase),
      fromLine: new Color(PALETTE.bg), toLine: new Color(PALETTE.bg),
    };
    gus.push(entry);
    byName.set(shape.name, entry);
  }

  // 법정동 막대: 밑면이 y=0인 단위 상자를 인스턴스 행렬로 키운다.
  const barGeometry = new BoxGeometry(1, 1, 1);
  barGeometry.translate(0, 0.5, 0);
  const barMaterial = new MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
  const bars = new InstancedMesh(barGeometry, barMaterial, MAX_BARS);
  bars.name = "bars";
  bars.count = 0;
  bars.frustumCulled = false; // 인스턴스가 바뀌어도 낡은 경계 구로 잘리지 않게
  const tmpColor = new Color(1, 1, 1);
  for (let i = 0; i < MAX_BARS; i++) bars.setColorAt(i, tmpColor); // 첫 렌더 전에 instanceColor를 만들어 둔다
  bars.userData.names = [] as string[]; // 인스턴스 번호 → 법정동 이름(레이캐스트 instanceId로 찾기용)
  group.add(bars);

  const labels = new Group();
  labels.name = "labels";
  group.add(labels);
  const leaderMaterial = new LineBasicMaterial({ color: PALETTE.text, transparent: true, opacity: 0.55 });

  let metric: Metric = "price";
  let summary: Record<string, Stat> | null = null;
  let focused: GuEntry | null = null;
  let focusData: GuData | null = null;
  let barStates: BarState[] = [];
  let labelEntries: LabelEntry[] = [];
  let leader: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;
  // 두 갈래 애니메이션 시계: 구(상승·색)와 막대. 한쪽을 새로 시작해도 다른 쪽은 이어 간다.
  let guT = GROW_SECONDS;
  let barT = GROW_SECONDS;
  let disposed = false;

  const tmpMatrix = new Matrix4();
  const tmpPos = new Vector3();
  const tmpScale = new Vector3();
  const identity = new Quaternion();
  const tmpLine = new Color();

  function computeOverview(): void {
    if (!summary) {
      for (const g of gus) g.overview = PALETTE.guBase;
      return;
    }
    const s = summary;
    const ts = normalize(gus.map((g) => statValue(s[g.shape.name], metric)));
    gus.forEach((g, i) => {
      const t = ts[i];
      g.overview = t === null || t === undefined ? PALETTE.noData : colorFor(t);
    });
  }

  /** 구 목표(상승 높이, 윗면 색, 윤곽선 색)를 다시 정하고, 하나라도 바뀌었으면 지금 모습에서 보간을 시작한다. */
  function startGu(): void {
    computeOverview();
    const targets = gus.map((g) => {
      const [col, line] = !focused
        ? [g.overview, PALETTE.bg]
        : g === focused
          ? [PALETTE.guBase, PALETTE.text]
          : [PALETTE.guDim, PALETTE.bg];
      return { y: g === focused ? GU_LIFT : 0, color: new Color(col), line: new Color(line) };
    });
    const changed = gus.some((g, i) => {
      const t = targets[i]!;
      return t.y !== g.toY || !t.color.equals(g.toColor) || !t.line.equals(g.toLine);
    });
    if (!changed) return;
    gus.forEach((g, i) => {
      const t = targets[i]!;
      g.fromY = g.mesh.position.y;
      g.fromColor.copy(g.mesh.material.color);
      g.fromLine.copy(g.outline.material.color);
      g.toY = t.y;
      g.toColor.copy(t.color);
      g.toLine.copy(t.line);
    });
    guT = reducedMotion ? GROW_SECONDS : 0;
    applyAll();
  }

  function clearLabels(): void {
    for (const e of labelEntries) disposeLabel(e.sprite);
    labelEntries = [];
    if (leader) {
      leader.geometry.dispose();
      leader.removeFromParent();
      leader = null;
    }
    labels.clear();
  }

  function buildLabels(): void {
    if (!focused) return;
    const targets = barStates.filter((b) => !b.leaving);
    const maxH = targets.reduce((m, b) => Math.max(m, b.to.h), 0);
    let y = maxH + LABEL_CLEAR;
    // 상위 5개 법정동(값 있는 것만)을 아래에서 위로 쌓는다. 1위가 가장 아래(자기 막대와 가장 가깝다).
    for (const b of targets.filter((q) => q.value !== null).slice(0, LABEL_TOP_N)) {
      const sprite = makeLabelSprite(dongLabelText(b.name, b.value, metric), DONG_LABEL_H, makeText);
      if (!sprite) continue;
      labelEntries.push({ sprite, bar: b, y });
      labels.add(sprite);
      y += LABEL_STEP;
    }
    const guSprite = makeLabelSprite(focused.shape.name, GU_LABEL_H, makeText);
    if (guSprite) {
      labelEntries.push({ sprite: guSprite, bar: null, y: y + 0.01 });
      labels.add(guSprite);
    }
    const withBar = labelEntries.filter((e) => e.bar !== null).length;
    if (withBar > 0) {
      const g = new BufferGeometry();
      g.setAttribute("position", new Float32BufferAttribute(new Float32Array(withBar * 6), 3));
      leader = new LineSegments(g, leaderMaterial);
      leader.name = "leaders";
      leader.frustumCulled = false;
      labels.add(leader);
    }
  }

  function syncInstanceSet(): void {
    bars.count = barStates.length;
    bars.userData.names = barStates.map((b) => b.name);
  }

  /**
   * 막대 목표를 다시 정한다.
   * - "fresh"(구가 바뀜): 대상 칸에서 0부터 자란다. 색은 바로 대상 색.
   * - "morph"(같은 구, 다른 달·지표): 같은 이름의 동은 지금 모습(높이·색·칸)에서 새 칸·높이·색으로 보간.
   *   새 동은 새 칸에서 0.02·noData로 시작해 자라고, 사라진 동은 제자리에서 0.02·noData로 줄어든 뒤 끝에 빠진다.
   * 칸은 layoutBars가 대상 동 목록으로 다시 계산한다(정렬·격자 크기가 바뀌면 막대가 새 칸으로 미끄러진다).
   */
  function startBars(mode: "fresh" | "morph"): void {
    clearLabels();
    const placements =
      focused && focusData && focusData.gu === focused.shape.name
        ? layoutBars(focusData.dongs, boundsOf(focused.shape.rings), metric).slice(0, MAX_BARS)
        : [];
    const ts = normalize(placements.map((p) => p.value));
    const old = new Map<string, BarState>();
    if (mode === "morph") for (const b of barStates) if (!old.has(b.name)) old.set(b.name, b);

    const next: BarState[] = placements.map((p, i) => {
      const t = ts[i];
      const to = snap(p.x, p.z, p.size, p.height, t === null || t === undefined ? PALETTE.noData : colorFor(t));
      const prev = old.get(p.name);
      let from: BarSnap;
      if (prev) {
        old.delete(p.name);
        from = cloneSnap(prev.cur);
      } else if (mode === "morph") {
        from = snap(p.x, p.z, p.size, BAR_MIN_HEIGHT, PALETTE.noData);
      } else {
        from = snap(p.x, p.z, p.size, 0, to.color); // 0에서(그릴 때는 MIN_BAR_SCALE로 받친다)
      }
      return { name: p.name, value: p.value, from, to, cur: cloneSnap(from), leaving: false };
    });
    if (mode === "morph" && !reducedMotion) {
      for (const prev of old.values()) {
        if (next.length >= MAX_BARS) break;
        const from = cloneSnap(prev.cur);
        const to = snap(from.x, from.z, from.size, BAR_MIN_HEIGHT, PALETTE.noData);
        next.push({ name: prev.name, value: null, from, to, cur: cloneSnap(from), leaving: true });
      }
    }

    barStates = focused ? next : [];
    barT = reducedMotion ? GROW_SECONDS : 0;
    syncInstanceSet();
    buildLabels();
    applyAll();
  }

  /** 애니메이션이 끝나면 떠나는 막대를 인스턴스 집합에서 뺀다(항상 배열 끝에 있으므로 앞 번호는 그대로). */
  function dropLeaving(): void {
    if (!barStates.some((b) => b.leaving)) return;
    barStates = barStates.filter((b) => !b.leaving);
    syncInstanceSet();
  }

  function applyAll(): void {
    const eG = easeOutCubic(guT / GROW_SECONDS);
    const eB = easeOutCubic(barT / GROW_SECONDS);
    for (const g of gus) {
      g.mesh.position.y = mix(g.fromY, g.toY, eG);
      mixColor(g.mesh.material.color, g.fromColor, g.toColor, eG);
      mixColor(tmpLine, g.fromLine, g.toLine, eG);
      g.outline.material.color.copy(tmpLine);
    }

    const base = (focused ? focused.mesh.position.y : 0) + GU_DEPTH;
    barStates.forEach((b, i) => {
      const c = b.cur;
      c.x = mix(b.from.x, b.to.x, eB);
      c.z = mix(b.from.z, b.to.z, eB);
      c.size = mix(b.from.size, b.to.size, eB);
      c.h = mix(b.from.h, b.to.h, eB);
      mixColor(c.color, b.from.color, b.to.color, eB);
      tmpPos.set(c.x, base, c.z);
      tmpScale.set(c.size, Math.max(MIN_BAR_SCALE, c.h), c.size);
      tmpMatrix.compose(tmpPos, identity, tmpScale);
      bars.setMatrixAt(i, tmpMatrix);
      bars.setColorAt(i, c.color);
    });
    bars.instanceMatrix.needsUpdate = true;
    if (bars.instanceColor) bars.instanceColor.needsUpdate = true;

    if (!focused) return;
    const [cx, cz] = focused.shape.centroid;
    const attr = leader?.geometry.getAttribute("position");
    let k = 0;
    for (const entry of labelEntries) {
      const x = entry.bar ? entry.bar.cur.x : cx;
      const z = entry.bar ? entry.bar.cur.z : cz;
      entry.sprite.position.set(x, base + entry.y, z);
      entry.sprite.material.opacity = eB;
      if (entry.bar && attr) {
        attr.setXYZ(k++, x, base + Math.max(MIN_BAR_SCALE, entry.bar.cur.h), z);
        attr.setXYZ(k++, x, base + entry.y, z);
      }
    }
    if (attr) attr.needsUpdate = true;
    leaderMaterial.opacity = 0.55 * eB;
  }

  return {
    group,

    setOverview(next, m) {
      if (disposed) return;
      if (next === summary && m === metric) return; // 같은 요약이 다시 와도 보간을 처음부터 하지 않는다
      const metricChanged = m !== metric;
      summary = next;
      metric = m;
      startGu();
      if (focused && metricChanged) startBars("morph");
    },

    focus(gu, data, m) {
      if (disposed) return;
      const next = gu === null ? null : (byName.get(gu) ?? null);
      const nextData = next ? data : null;
      // 같은 상태가 반복돼 와도(실시간 메시지) 애니메이션을 처음부터 다시 하지 않는다.
      if (next === focused && nextData === focusData && m === metric) return;
      const guChanged = next !== focused;
      metric = m;
      focused = next;
      focusData = nextData;
      startGu();
      // 구가 바뀌면 상승·하강과 새 성장, 같은 구에서 달·지표만 바뀌면 지금 막대에서 보간(CONTRACTS 11).
      startBars(guChanged ? "fresh" : "morph");
    },

    setMetric(m) {
      if (disposed || m === metric) return;
      metric = m;
      startGu();
      if (focused) startBars("morph");
    },

    // 라벨은 Sprite라서 셰이더가 스스로 카메라를 향한다(부모 회전과 무관). 그래서 camera는 쓰지 않는다.
    update(dt, _camera) {
      if (disposed || !Number.isFinite(dt) || dt <= 0) return;
      if (guT >= GROW_SECONDS && barT >= GROW_SECONDS) return;
      guT = Math.min(GROW_SECONDS, guT + dt);
      barT = Math.min(GROW_SECONDS, barT + dt);
      applyAll();
      if (barT >= GROW_SECONDS) dropLeaving();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearLabels();
      for (const g of gus) {
        g.mesh.geometry.dispose();
        g.mesh.material.dispose();
        g.outline.geometry.dispose();
        g.outline.material.dispose();
      }
      gus.length = 0;
      byName.clear();
      barStates = [];
      focused = null;
      focusData = null;
      summary = null;
      bars.dispose();
      barGeometry.dispose();
      barMaterial.dispose();
      leaderMaterial.dispose();
      hemi.dispose();
      sun.dispose();
      group.clear();
      group.removeFromParent();
    },
  };
}
