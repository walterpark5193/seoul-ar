// 서울 25구 3D 씬 (CONTRACTS 4절, 무대 확장 CONTRACTS-stage 6.2). 좌표: x 동쪽, z 남쪽, y 위. 도시 전체가 [-0.5, 0.5]² 안.
import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
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
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Raycaster,
  Shape,
  Vector2,
  Vector3,
} from "three";
import type { Camera, Sprite } from "three";
import type { Geo, GuShape } from "../geo/types";
import type { Stat, GuData, Metric } from "../data/types";
import type { StageMode } from "../stage/types";
import { PALETTE, colorFor, normalize } from "./colors";
import { boundsOf, layoutBars } from "./layout";
import type { BarPlacement } from "./layout";
import { canvasTextTexture, disposeLabel, makeLabelSprite } from "./labels";
import { spreadLayout } from "./spreadLayout";
import type { SpreadSlot } from "./spreadLayout";

export interface SeoulScene {
  group: Group;                                                    // 부모(AR 앵커 또는 월드)에 add
  setOverview(summary: Record<string, Stat>, metric: Metric): void; // 25구 색 갱신(전체 보기)
  focus(gu: string | null, data: GuData | null, metric: Metric): void; // 구 상승 + 법정동 막대. null이면 전체 보기
  setMetric(metric: Metric): void;                                  // 현재 focus/overview를 새 지표로 다시 그림
  update(dt: number, camera: Camera): void;                         // 매 프레임: 애니메이션, 라벨 빌보드
  dispose(): void;
  // 무대 확장 (CONTRACTS-stage 6.2)
  setHover(gu: string | null): void;                                // 테두리 밝게 + y +0.01
  lift(gu: string | null): void;                                    // y LIFT_Y까지 상승, 아래 그림자 원판, 나머지 guDim. null이면 내려놓음
  setLayout(mode: StageMode, summary: Record<string, Stat>, metric: Metric): void; // spread: centroid→slot, 높이 slot.height. map: 원위치
  pick(ndcX: number, ndcY: number, camera: Camera): string | null;  // 구 메시만 레이캐스트(윤곽선·라벨·막대 제외)
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
/** 들어올린 구 높이(바닥 기준) */
export const LIFT_Y = 0.12;
/** 지도↔펼치기 보간 길이(초) */
export const LAYOUT_SECONDS = 0.8;

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

const HOVER_Y = 0.01; // hover 때 더 오르는 높이
const RAISE_SECONDS = 0.3; // hover·들어올림 보간 길이
// 펼칠 때 구 바닥 크기 비율(모양 유지). 호 위 이웃 간격(2R·sin(100°/48) ≈ 0.065)에 실제 구 폭(0.11~0.30)이 들어가게.
// 실제 경계로 202611 두 지표 모두 이웃 경계 상자 겹침 0.013 이하, 평균 폭 0.041.
const SPREAD_FOOTPRINT = 0.22;
const SHADOW_OPACITY = 0.35;
const SHADOW_Y = 0.001; // 바닥 바로 위
const SHADOW_FILL = 0.9; // 원판 반지름 = 구 경계 상자 긴 변의 절반 × 이 값
const RANK_LABEL_H = 0.028;
const NAME_LABEL_H = 0.02;
const SPREAD_LABEL_GAP = 0.01; // 순위 라벨은 기둥 윗면 위, 이름 라벨은 밑면 아래로 이만큼 띄운다

/** 메시 위치 오프셋(x, z)과 스케일(sx는 x·z 공통, sy는 높이) */
interface Xform { x: number; z: number; sx: number; sy: number; }
const HOME: Readonly<Xform> = { x: 0, z: 0, sx: 1, sy: 1 };

interface GuEntry {
  shape: GuShape;
  mesh: Mesh<ExtrudeGeometry, MeshStandardMaterial>;
  outline: LineSegments<BufferGeometry, LineBasicMaterial>;
  overview: string; // 전체 보기 색
  halfSpan: number; // 경계 상자 긴 변의 절반(그림자 크기)
  // focus 상승(GROW_SECONDS). y는 현재값
  fromY: number;
  toY: number;
  y: number;
  // hover·들어올림 상승(RAISE_SECONDS). focus 상승 위에 더한다
  fromR: number;
  toR: number;
  r: number;
  // 지도↔펼치기 이동(LAYOUT_SECONDS)
  from: Readonly<Xform>;
  to: Readonly<Xform>;
}

interface SpreadLabelEntry {
  sprite: Sprite;
  gu: GuEntry;
  kind: "rank" | "name"; // rank는 기둥 위, name은 밑면 아래
}

/** t>=1이면 b 그대로(끝값이 부동소수 오차 없이 맞게) */
function mix(a: number, b: number, t: number): number {
  return t >= 1 ? b : a + (b - a) * t;
}

interface LabelEntry {
  sprite: Sprite;
  bar: BarPlacement | null; // null이면 구 이름 라벨
  y: number; // 구 윗면 기준 라벨 아래쪽 높이
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

function dongLabelText(p: BarPlacement, metric: Metric): string {
  const v = p.value ?? 0;
  return metric === "price" ? `${p.name} ${fmtInt(v)}만원/㎡` : `${p.name} ${fmtInt(v)}건`;
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
  const meshes: Mesh[] = []; // pick 대상: 구 메시만
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
    const b = boundsOf(shape.rings);
    const entry: GuEntry = {
      shape, mesh, outline, overview: PALETTE.guBase,
      halfSpan: Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2,
      fromY: 0, toY: 0, y: 0, fromR: 0, toR: 0, r: 0, from: HOME, to: HOME,
    };
    gus.push(entry);
    byName.set(shape.name, entry);
    meshes.push(mesh);
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
  group.add(bars);

  const labels = new Group();
  labels.name = "labels";
  group.add(labels);
  const leaderMaterial = new LineBasicMaterial({ color: PALETTE.text, transparent: true, opacity: 0.55 });

  // 들어올린 구 아래 그림자 원판(반지름 1, 바닥에 눕힘). 구 메시가 아니라 pick 대상이 아니다.
  const shadowGeometry = new CircleGeometry(1, 48);
  shadowGeometry.rotateX(-Math.PI / 2);
  const shadowMaterial = new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false });
  const shadow = new Mesh(shadowGeometry, shadowMaterial);
  shadow.name = "lift-shadow";
  shadow.visible = false;
  group.add(shadow);

  const spreadLabels = new Group();
  spreadLabels.name = "spread-labels";
  group.add(spreadLabels);

  const raycaster = new Raycaster();
  const ndc = new Vector2();

  let metric: Metric = "price";
  let summary: Record<string, Stat> | null = null;
  let focused: GuEntry | null = null;
  let focusData: GuData | null = null;
  let placements: BarPlacement[] = [];
  let labelEntries: LabelEntry[] = [];
  let leader: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;
  let elapsed = GROW_SECONDS;
  let disposed = false;
  // 무대 확장 상태
  let hovered: GuEntry | null = null;
  let lifted: GuEntry | null = null;
  let layoutMode: StageMode = "map";
  let layoutSummary: Record<string, Stat> | null = null;
  let layoutMetric: Metric = "price";
  let spreadEntries: SpreadLabelEntry[] = [];
  let spreadFadeFrom = 0; // 펼치기 라벨 불투명도 시작값(지도에서 들어오면 0, 펼친 채 다시 정렬하면 1)
  let raiseElapsed = RAISE_SECONDS;
  let layoutElapsed = LAYOUT_SECONDS;
  let shadowGu: GuEntry | null = null; // 내려놓는 동안에도 그 구 아래에서 옅어진다
  let shadowFrom = 0;
  let shadowTo = 0;

  const tmpMatrix = new Matrix4();
  const tmpPos = new Vector3();
  const tmpScale = new Vector3();
  const identity = new Quaternion();

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

  /** 펼치기 중에는 focus 모습(상승·막대·어둡게)을 쉰다. focus 값은 두었다가 지도로 돌아오면 다시 보인다. */
  function focusShown(): GuEntry | null {
    return layoutMode === "map" ? focused : null;
  }

  function paintGus(): void {
    const shown = focusShown();
    const lead = lifted ?? shown; // 들어올린 구가 있으면 그 구 말고 나머지를 어둡게
    for (const g of gus) {
      let fill: string;
      let edge: string;
      if (!lead) {
        fill = g.overview;
        edge = PALETTE.bg;
      } else if (g === lead) {
        fill = g === shown ? PALETTE.guBase : g.overview;
        edge = PALETTE.text;
      } else {
        fill = PALETTE.guDim;
        edge = PALETTE.bg;
      }
      g.mesh.material.color.set(fill);
      g.outline.material.color.set(g === hovered ? PALETTE.text : edge);
    }
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
    const maxH = placements.reduce((m, p) => Math.max(m, p.height), 0);
    let y = maxH + LABEL_CLEAR;
    // 상위 5개 법정동(값 있는 것만)을 아래에서 위로 쌓는다. 1위가 가장 아래(자기 막대와 가장 가깝다).
    for (const p of placements.filter((q) => q.value !== null).slice(0, LABEL_TOP_N)) {
      const sprite = makeLabelSprite(dongLabelText(p, metric), DONG_LABEL_H, makeText);
      if (!sprite) continue;
      labelEntries.push({ sprite, bar: p, y });
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

  function buildBars(): void {
    clearLabels();
    placements = [];
    if (focused && focusData && focusData.gu === focused.shape.name) {
      placements = layoutBars(focusData.dongs, boundsOf(focused.shape.rings), metric).slice(0, MAX_BARS);
    }
    bars.count = placements.length;
    const ts = normalize(placements.map((p) => p.value));
    placements.forEach((_, i) => {
      const t = ts[i];
      tmpColor.set(t === null || t === undefined ? PALETTE.noData : colorFor(t));
      bars.setColorAt(i, tmpColor);
    });
    if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
    buildLabels();
  }

  /** 세 보간(focus 상승, hover·들어올림, 지도↔펼치기)의 현재 진행도로 모든 것을 놓는다. */
  function apply(): void {
    const eGrow = easeOutCubic(elapsed / GROW_SECONDS);
    const eRaise = easeOutCubic(raiseElapsed / RAISE_SECONDS);
    const eLayout = easeOutCubic(layoutElapsed / LAYOUT_SECONDS);
    for (const g of gus) {
      g.y = mix(g.fromY, g.toY, eGrow);
      g.r = mix(g.fromR, g.toR, eRaise);
      const sx = mix(g.from.sx, g.to.sx, eLayout);
      const sy = mix(g.from.sy, g.to.sy, eLayout);
      g.mesh.position.set(mix(g.from.x, g.to.x, eLayout), g.y + g.r, mix(g.from.z, g.to.z, eLayout));
      g.mesh.scale.set(sx, sy, sx);
      g.outline.position.y = OUTLINE_LIFT / sy - OUTLINE_LIFT; // 늘인 뒤에도 윗면 위 OUTLINE_LIFT
    }
    applyBars(eGrow);
    applyShadow(eRaise);
    applySpreadLabels(eLayout);
  }

  /** 막대와 라벨은 focus 구의 변환(이동·바닥 스케일·윗면 높이)을 따라간다. e: 성장 진행도 */
  function applyBars(e: number): void {
    const fm = focused ? focused.mesh : null;
    const ox = fm ? fm.position.x : 0;
    const oz = fm ? fm.position.z : 0;
    const s = fm ? fm.scale.x : 1;
    const base = fm ? fm.position.y + GU_DEPTH * fm.scale.y : GU_DEPTH;
    placements.forEach((p, i) => {
      tmpPos.set(ox + p.x * s, base, oz + p.z * s);
      tmpScale.set(p.size * s, Math.max(MIN_BAR_SCALE, p.height * e), p.size * s);
      tmpMatrix.compose(tmpPos, identity, tmpScale);
      bars.setMatrixAt(i, tmpMatrix);
    });
    bars.instanceMatrix.needsUpdate = true;

    if (!focused) return;
    const [cx, cz] = focused.shape.centroid;
    const attr = leader?.geometry.getAttribute("position");
    let k = 0;
    for (const entry of labelEntries) {
      const x = ox + (entry.bar ? entry.bar.x : cx) * s;
      const z = oz + (entry.bar ? entry.bar.z : cz) * s;
      entry.sprite.position.set(x, base + entry.y, z);
      entry.sprite.material.opacity = e;
      if (entry.bar && attr) {
        attr.setXYZ(k++, x, base + Math.max(MIN_BAR_SCALE, entry.bar.height * e), z);
        attr.setXYZ(k++, x, base + entry.y, z);
      }
    }
    if (attr) attr.needsUpdate = true;
    leaderMaterial.opacity = 0.55 * e;
  }

  function applyShadow(e: number): void {
    const opacity = mix(shadowFrom, shadowTo, e);
    shadowMaterial.opacity = opacity;
    shadow.visible = shadowGu !== null && opacity > 0;
    if (!shadowGu) return;
    const m = shadowGu.mesh;
    const [cx, cz] = shadowGu.shape.centroid;
    const radius = shadowGu.halfSpan * SHADOW_FILL * m.scale.x;
    shadow.position.set(m.position.x + cx * m.scale.x, SHADOW_Y, m.position.z + cz * m.scale.z);
    shadow.scale.set(radius, 1, radius);
  }

  function applySpreadLabels(e: number): void {
    const opacity = mix(spreadFadeFrom, 1, e);
    for (const entry of spreadEntries) {
      const m = entry.gu.mesh;
      const [cx, cz] = entry.gu.shape.centroid;
      const y =
        entry.kind === "rank"
          ? m.position.y + GU_DEPTH * m.scale.y + SPREAD_LABEL_GAP
          : m.position.y - NAME_LABEL_H - SPREAD_LABEL_GAP;
      entry.sprite.position.set(m.position.x + cx * m.scale.x, y, m.position.z + cz * m.scale.z);
      entry.sprite.material.opacity = opacity;
    }
  }

  /** 현재 위치에서 새 목표로 전환을 시작한다(focus 상승과 막대 성장). */
  function retarget(): void {
    const shown = focusShown();
    for (const g of gus) {
      g.fromY = g.y;
      g.toY = g === shown ? GU_LIFT : 0;
    }
    elapsed = reducedMotion ? GROW_SECONDS : 0;
    if (lifted) retargetRaise(); // 들어올린 구는 focus 목표가 바뀌어도 LIFT_Y에 머물게
    else apply();
  }

  /** 들어올린 구는 바닥 기준 LIFT_Y(focus 상승을 빼고 더함), hover 구는 +HOVER_Y. */
  function raiseTarget(g: GuEntry): number {
    if (g === lifted) return LIFT_Y - g.toY;
    return g === hovered ? HOVER_Y : 0;
  }

  /** hover·들어올림 전환을 현재 위치에서 시작한다. */
  function retargetRaise(): void {
    for (const g of gus) {
      g.fromR = g.r;
      g.toR = raiseTarget(g);
    }
    shadowFrom = shadowMaterial.opacity;
    shadowTo = lifted ? SHADOW_OPACITY : 0;
    if (lifted) shadowGu = lifted;
    raiseElapsed = reducedMotion ? RAISE_SECONDS : 0;
    apply();
  }

  /** 지도↔펼치기 이동을 현재 위치에서 시작한다. slots가 없는 구는 원위치로. world(centroid) = 위치 + 스케일·centroid */
  function retargetLayout(slots: ReadonlyMap<string, SpreadSlot>): void {
    for (const g of gus) {
      g.from = { x: g.mesh.position.x, z: g.mesh.position.z, sx: g.mesh.scale.x, sy: g.mesh.scale.y };
      const slot = slots.get(g.shape.name);
      const [cx, cz] = g.shape.centroid;
      g.to = slot
        ? { x: slot.x - SPREAD_FOOTPRINT * cx, z: slot.z - SPREAD_FOOTPRINT * cz, sx: SPREAD_FOOTPRINT, sy: slot.height / GU_DEPTH }
        : HOME;
    }
    layoutElapsed = reducedMotion ? LAYOUT_SECONDS : 0;
  }

  function clearSpreadLabels(): void {
    for (const e of spreadEntries) disposeLabel(e.sprite);
    spreadEntries = [];
    spreadLabels.clear();
  }

  function addSpreadLabel(text: string, height: number, gu: GuEntry, kind: SpreadLabelEntry["kind"]): void {
    const sprite = makeLabelSprite(text, height, makeText);
    if (!sprite) return;
    spreadEntries.push({ sprite, gu, kind });
    spreadLabels.add(sprite);
  }

  function findGu(gu: string | null): GuEntry | null {
    return gu === null ? null : (byName.get(gu) ?? null);
  }

  return {
    group,

    setOverview(next, m) {
      if (disposed) return;
      const metricChanged = m !== metric;
      summary = next;
      metric = m;
      computeOverview();
      paintGus();
      if (focused && metricChanged) {
        buildBars();
        retarget();
      }
    },

    focus(gu, data, m) {
      if (disposed) return;
      const next = gu === null ? null : (byName.get(gu) ?? null);
      const nextData = next ? data : null;
      // 같은 상태가 반복돼 와도(실시간 메시지) 애니메이션을 처음부터 다시 하지 않는다.
      if (next === focused && nextData === focusData && m === metric) return;
      metric = m;
      focused = next;
      focusData = nextData;
      computeOverview();
      paintGus();
      buildBars();
      retarget();
    },

    setMetric(m) {
      if (disposed || m === metric) return;
      metric = m;
      computeOverview();
      paintGus();
      if (focused) {
        buildBars();
        retarget();
      }
    },

    // 라벨은 Sprite라서 셰이더가 스스로 카메라를 향한다(부모 회전과 무관). 그래서 camera는 쓰지 않는다.
    update(dt, _camera) {
      if (disposed || !Number.isFinite(dt) || dt <= 0) return;
      if (elapsed >= GROW_SECONDS && raiseElapsed >= RAISE_SECONDS && layoutElapsed >= LAYOUT_SECONDS) return;
      elapsed = Math.min(GROW_SECONDS, elapsed + dt);
      raiseElapsed = Math.min(RAISE_SECONDS, raiseElapsed + dt);
      layoutElapsed = Math.min(LAYOUT_SECONDS, layoutElapsed + dt);
      apply();
    },

    setHover(gu) {
      if (disposed) return;
      const next = findGu(gu);
      if (next === hovered) return; // 커서가 매 프레임 같은 구를 알려 와도 다시 시작하지 않는다
      hovered = next;
      paintGus();
      retargetRaise();
    },

    lift(gu) {
      if (disposed) return;
      const next = findGu(gu);
      if (next === lifted) return;
      lifted = next;
      paintGus();
      retargetRaise();
    },

    setLayout(mode, next, m) {
      if (disposed) return;
      if (mode === layoutMode && (mode === "map" || (next === layoutSummary && m === layoutMetric))) return;
      const wasSpread = layoutMode === "spread";
      layoutMode = mode;
      layoutSummary = mode === "spread" ? next : null;
      layoutMetric = m;
      clearSpreadLabels();
      const slots = mode === "spread" ? spreadLayout(next, m, gus.map((g) => g.shape.name)) : [];
      for (const slot of slots) {
        const g = byName.get(slot.gu);
        if (!g) continue;
        if (slot.rank !== null) addSpreadLabel(`${slot.rank}위`, RANK_LABEL_H, g, "rank");
        addSpreadLabel(slot.gu, NAME_LABEL_H, g, "name");
      }
      spreadFadeFrom = wasSpread && mode === "spread" ? 1 : 0;
      retargetLayout(new Map(slots.map((slot) => [slot.gu, slot])));
      bars.visible = mode === "map";
      labels.visible = mode === "map";
      paintGus();
      if (focused) retarget(); // 펼치면 focus 구가 내려앉고, 돌아오면 다시 오르며 막대가 자란다
      else apply();
    },

    pick(ndcX, ndcY, cam) {
      if (disposed || !Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return null;
      const kind = cam as { isPerspectiveCamera?: boolean; isOrthographicCamera?: boolean };
      if (!kind.isPerspectiveCamera && !kind.isOrthographicCamera) return null;
      // 렌더 전에 불려도 이번 프레임 위치로 맞히게 행렬을 갱신한다(렌더러가 하는 일과 같다).
      cam.updateMatrixWorld();
      group.updateWorldMatrix(true, true);
      ndc.set(ndcX, ndcY);
      raycaster.setFromCamera(ndc, cam);
      // 구 메시만, 자식(윤곽선) 없이. 막대·라벨·지시선·그림자는 대상 목록에 없다.
      const hit = raycaster.intersectObjects(meshes, false)[0];
      const name: unknown = hit?.object.userData.gu;
      return typeof name === "string" ? name : null;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearLabels();
      clearSpreadLabels();
      for (const g of gus) {
        g.mesh.geometry.dispose();
        g.mesh.material.dispose();
        g.outline.geometry.dispose();
        g.outline.material.dispose();
      }
      gus.length = 0;
      byName.clear();
      meshes.length = 0;
      placements = [];
      focused = null;
      focusData = null;
      summary = null;
      hovered = null;
      lifted = null;
      shadowGu = null;
      layoutSummary = null;
      bars.dispose();
      barGeometry.dispose();
      barMaterial.dispose();
      leaderMaterial.dispose();
      shadowGeometry.dispose();
      shadowMaterial.dispose();
      hemi.dispose();
      sun.dispose();
      group.clear();
      group.removeFromParent();
    },
  };
}
