// 화면 주소 만들기(순수 함수): 관객용 QR 주소와 큰 화면 주소.

type Loc = { origin: string; pathname: string };

function base(url: string): string {
  return url.replace(/index\.html$/, "").replace(/\/+$/, "");
}

/** 관객용 주소(#/ar). 배포 설정의 appUrl이 있으면 그것, 없으면 지금 주소. */
export function viewerUrl(appUrl: string | null, loc: Loc): string {
  return `${base(appUrl ?? `${loc.origin}${loc.pathname}`)}/#/ar`;
}

/** 큰 화면 3D 모드 주소(#/3d?stage=1, CONTRACTS 13). 발표자가 연 주소와 같은 출처. */
export function stageUrl(loc: Loc): string {
  return `${base(`${loc.origin}${loc.pathname}`)}/#/3d?stage=1`;
}
