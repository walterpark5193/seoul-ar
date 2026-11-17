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
import { boundsOf, layoutBars } from "./layout";
import type { BarPlacement } from "./layout";
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
    const entry: GuEntry = { shape, mesh, outline, overview: PALETTE.guBase, fromY: 0, toY: 0 };
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
  group.add(bars);

  const labels = new Group();
  labels.name = "labels";
  group.add(labels);
  const leaderMaterial = new LineBasicMaterial({ color: PALETTE.text, transparent: true, opacity: 0.55 });

  let metric: Metric = "price";
  let summary: Record<string, Stat> | null = null;
  let focused: GuEntry | null = null;
  let focusData: GuData | null = null;
  let placements: BarPlacement[] = [];
  let labelEntries: LabelEntry[] = [];
  let leader: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;
  let elapsed = GROW_SECONDS;
  let disposed = false;

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

  function paintGus(): void {
    for (const g of gus) {
      if (!focused) {
        g.mesh.material.color.set(g.overview);
        g.outline.material.color.set(PALETTE.bg);
      } else if (g === focused) {
        g.mesh.material.color.set(PALETTE.guBase);
        g.outline.material.color.set(PALETTE.text);
      } else {
        g.mesh.material.color.set(PALETTE.guDim);
        g.outline.material.color.set(PALETTE.bg);
      }
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

  /** e: 0..1 진행도(이미 ease 적용) */
  function apply(e: number): void {
    for (const g of gus) g.mesh.position.y = g.fromY + (g.toY - g.fromY) * e;
    const base = (focused ? focused.mesh.position.y : 0) + GU_DEPTH;
    placements.forEach((p, i) => {
      tmpPos.set(p.x, base, p.z);
      tmpScale.set(p.size, Math.max(MIN_BAR_SCALE, p.height * e), p.size);
      tmpMatrix.compose(tmpPos, identity, tmpScale);
      bars.setMatrixAt(i, tmpMatrix);
    });
    bars.instanceMatrix.needsUpdate = true;

    if (!focused) return;
    const [cx, cz] = focused.shape.centroid;
    const attr = leader?.geometry.getAttribute("position");
    let k = 0;
    for (const entry of labelEntries) {
      const x = entry.bar ? entry.bar.x : cx;
      const z = entry.bar ? entry.bar.z : cz;
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

  /** 현재 위치에서 새 목표로 전환을 시작한다. */
  function retarget(): void {
    for (const g of gus) {
      g.fromY = g.mesh.position.y;
      g.toY = g === focused ? GU_LIFT : 0;
    }
    elapsed = reducedMotion ? GROW_SECONDS : 0;
    apply(reducedMotion ? 1 : 0);
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
      if (elapsed >= GROW_SECONDS) return;
      elapsed = Math.min(GROW_SECONDS, elapsed + dt);
      apply(easeOutCubic(elapsed / GROW_SECONDS));
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
      placements = [];
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
