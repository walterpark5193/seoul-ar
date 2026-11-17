// AR 화면의 손가락 조작(Task 4g): 그림 위 도시를 제자리에서 돌리고(한 손가락 가로 끌기) 키운다(두 손가락).
// 순수 계산과, 포인터 정보만 받는 작은 컨트롤러. DOM은 arView가 잇는다.
// 대상은 세션 anchor(+π/2 안쪽 그룹)에 붙인 씬 그룹이다. 그 그룹의 로컬 Y가 도시의 "위"라서
// rotation.y를 돌리면 도시가 그림 위에서 돈다. 세로 끌기는 무시한다(도시는 그림에 평평하게 둔다).

export interface CityPose { rotY: number; scale: number; }

export const DEFAULT_POSE: CityPose = Object.freeze({ rotY: 0, scale: 1 });
export const DRAG_RAD_PER_PX = 0.012;
export const MIN_SCALE = 0.6;
export const MAX_SCALE = 1.6;
export const RESET_SECONDS = 0.6;

/** 포인터가 시작된 곳이 이 안이면 조작으로 받지 않는다(시트, 도구, 링크, 버튼, 입력). */
export const IGNORE_SELECTOR = "button, a, select, input, label, .sheet-host, .sheet-frame, .ar-tools, .back";

const TAU = Math.PI * 2;

/** (-π, π]로 감는다. */
export function wrapAngle(a: number): number {
  return a - TAU * Math.ceil((a - Math.PI) / TAU);
}

export function applyDrag(p: CityPose, dx: number): CityPose {
  if (!Number.isFinite(dx)) return p;
  return { ...p, rotY: wrapAngle(p.rotY + dx * DRAG_RAD_PER_PX) };
}

export function applyPinch(p: CityPose, ratio: number): CityPose {
  if (!Number.isFinite(ratio) || ratio <= 0) return p;
  return { ...p, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, p.scale * ratio)) };
}

export function isDefaultPose(p: CityPose, eps = 1e-3): boolean {
  return Math.abs(p.rotY) < eps && Math.abs(p.scale - 1) < eps;
}

/** 회전은 짧은 쪽으로 돈다. */
export function lerpPose(from: CityPose, to: CityPose, t: number): CityPose {
  const k = Math.min(1, Math.max(0, t));
  return { rotY: from.rotY + wrapAngle(to.rotY - from.rotY) * k, scale: from.scale + (to.scale - from.scale) * k };
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** three의 Group 중 쓰는 부분만(테스트에서 가짜를 넣는다). */
export interface PoseTarget { rotation: { y: number }; scale: { setScalar(s: number): unknown }; }
export interface StartTarget { closest(selector: string): unknown; }

export interface CityGestures {
  readonly pose: CityPose;
  /** 조작으로 받으면 true(이때 DOM 쪽은 포인터를 붙잡는다). */
  pointerDown(id: number, x: number, y: number, start: StartTarget | null): boolean;
  pointerMove(id: number, x: number, y: number): void;
  pointerUp(id: number): void;
  /** 원위치: 0.6초 ease-out(reducedMotion이면 즉시) */
  reset(): void;
  /** 렌더 루프 틱(초). 고정 중에도 루프는 돈다. */
  tick(dt: number): void;
  isDefault(): boolean;
}

export interface CityGesturesOptions {
  group: PoseTarget;
  reducedMotion: boolean;
  onChange?(pose: CityPose, isDefault: boolean): void;
}

export function createCityGestures(o: CityGesturesOptions): CityGestures {
  let pose: CityPose = { ...DEFAULT_POSE };
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist: number | null = null;
  let anim: { from: CityPose; t: number } | null = null;

  const apply = (next: CityPose) => {
    pose = next;
    o.group.rotation.y = pose.rotY;
    o.group.scale.setScalar(pose.scale);
    o.onChange?.(pose, isDefaultPose(pose));
  };

  const distance = (): number | null => {
    if (pointers.size < 2) return null;
    const [a, b] = [...pointers.values()];
    return Math.hypot(a!.x - b!.x, a!.y - b!.y);
  };

  return {
    get pose() { return pose; },
    pointerDown(id, x, y, start) {
      if (start?.closest(IGNORE_SELECTOR)) return false;
      if (pointers.size >= 2) return false; // 세 번째 손가락은 무시
      anim = null; // 손대면 원위치 애니메이션을 멈춘다
      pointers.set(id, { x, y });
      pinchDist = distance();
      return true;
    },
    pointerMove(id, x, y) {
      const prev = pointers.get(id);
      if (!prev) return;
      pointers.set(id, { x, y });
      if (pointers.size >= 2) {
        const d = distance();
        if (d !== null && pinchDist !== null && pinchDist > 0) apply(applyPinch(pose, d / pinchDist));
        pinchDist = d;
        return;
      }
      apply(applyDrag(pose, x - prev.x)); // 가로만. 세로 이동은 버린다
    },
    pointerUp(id) {
      if (!pointers.delete(id)) return;
      pinchDist = distance(); // 한 손가락이 남으면 그 손가락의 지금 위치부터 다시 끈다
    },
    reset() {
      pointers.clear();
      pinchDist = null;
      if (o.reducedMotion) { anim = null; apply({ ...DEFAULT_POSE }); return; }
      anim = { from: pose, t: 0 };
    },
    tick(dt) {
      if (!anim) return;
      anim.t += Math.max(0, dt) / RESET_SECONDS;
      if (anim.t >= 1) {
        anim = null;
        apply({ ...DEFAULT_POSE });
        return;
      }
      apply(lerpPose(anim.from, DEFAULT_POSE, easeOut(anim.t)));
    },
    isDefault: () => isDefaultPose(pose),
  };
}
