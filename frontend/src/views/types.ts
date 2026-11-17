// 뷰가 받는 공용 의존성. 씬·AR 모듈은 main.ts가 주입한다(테스트는 가짜를 넣는다).
import type { ArSession, ArSessionOptions } from "../ar/session";
import type { AppConfig } from "../config";
import type { IndexSource } from "../data/indexSource";
import type { DataIndex, GuData } from "../data/types";
import type { RealtimeClient } from "../realtime/types";
import type { SeoulScene } from "../scene/seoulScene";
import type { Store } from "../state/store";

export interface ArDeps {
  arSupported(): boolean;
  createArSession(opts: ArSessionOptions): ArSession;
}

export interface ViewContext {
  store: Store;
  /** 지금 쓰는 index. 새 달을 가져오면 바뀌므로 쓸 때마다 읽는다(붙잡아 두지 않는다). */
  index: DataIndex;
  /** index를 다시 읽고 바뀌면 알린다(월 가져오기, 모르는 달의 원격 상태). */
  indexSource: IndexSource;
  config: AppConfig;
  realtime: RealtimeClient;
  loadGu(month: string, gu: string): Promise<GuData>;
  /** 뷰가 스스로 다른 화면으로 보낼 때(폴백). 기록을 바꿔치기한다. 일반 이동은 링크 href로 한다. */
  navigate(hash: string): void;
  toast(message: string): void;
  /** geo와 reducedMotion이 이미 묶인 씬 팩토리 */
  createScene(): SeoulScene;
  reducedMotion: boolean;
  ar: ArDeps;
  /** 해시의 "?" 뒤. main이 AR 뷰에만 넘긴다(조정 파라미터, views/arTuning.ts). */
  query?: string;
}

/** 뷰를 root에 그리고 해제 함수를 돌려준다. */
export type MountView = (root: HTMLElement, ctx: ViewContext) => () => void;
