// 뷰가 받는 공용 의존성. 씬·AR 모듈은 main.ts가 주입한다(테스트는 가짜를 넣는다).
import type { ArSession, ArSessionOptions } from "../ar/session";
import type { AppConfig } from "../config";
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
  index: DataIndex;
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
}

/** 뷰를 root에 그리고 해제 함수를 돌려준다. */
export type MountView = (root: HTMLElement, ctx: ViewContext) => () => void;
