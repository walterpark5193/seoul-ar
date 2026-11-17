// 한글 라벨: 캔버스에 그린 글자를 스프라이트로 띄운다. 스프라이트는 셰이더에서 스스로 카메라를 향한다.
import { CanvasTexture, SRGBColorSpace, Sprite, SpriteMaterial } from "three";
import type { Texture } from "three";
import { PALETTE } from "./colors";

export const FONT_STACK = '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif';

export type TextTextureFactory = (text: string, color: string) => Texture | null;

const FONT_PX = 48;
const PAD_X = 20;
const PAD_Y = 10;

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
}

/** 기본 팩토리. `document`가 없거나(노드, 워커) 2D 컨텍스트를 못 얻으면 null. */
export function canvasTextTexture(text: string, color: string): Texture | null {
  if (typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const font = `600 ${FONT_PX}px ${FONT_STACK}`;
    ctx.font = font;
    const width = Math.ceil(ctx.measureText(text).width) + PAD_X * 2;
    const height = Math.ceil(FONT_PX * 1.3) + PAD_Y * 2;
    canvas.width = width;
    canvas.height = height;
    // 크기를 바꾸면 컨텍스트 상태가 초기화된다.
    ctx.font = font;
    ctx.fillStyle = rgba(PALETTE.bg, 0.82); // 어두운 바탕 위 밝은 글자: 대비 4.5:1 이상
    const r = height / 2;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(0, 0, width, height, r);
    else ctx.rect(0, 0, width, height);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, width / 2, height / 2 + 2);
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    return tex;
  } catch {
    return null;
  }
}

function aspectOf(tex: Texture): number {
  const img = tex.image as { width?: unknown; height?: unknown } | null | undefined;
  return img && typeof img.width === "number" && typeof img.height === "number" && img.width > 0 && img.height > 0
    ? img.width / img.height
    : 4;
}

/** 팩토리가 null을 주면 라벨 없이 진행(null). 아래 가운데가 기준점, 세로 크기 worldHeight. */
export function makeLabelSprite(text: string, worldHeight: number, factory: TextTextureFactory): Sprite | null {
  const tex = factory(text, PALETTE.text);
  if (!tex) return null;
  const material = new SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new Sprite(material);
  sprite.name = `label:${text}`;
  sprite.center.set(0.5, 0);
  sprite.scale.set(worldHeight * aspectOf(tex), worldHeight, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** 같은 스프라이트에 새 글을 입힌다(텍스처만 교체, 이전 텍스처는 해제). 팩토리가 null이면 false, 스프라이트는 그대로. */
export function retextLabelSprite(sprite: Sprite, text: string, worldHeight: number, factory: TextTextureFactory): boolean {
  const tex = factory(text, PALETTE.text);
  if (!tex) return false;
  sprite.material.map?.dispose();
  sprite.material.map = tex;
  sprite.name = `label:${text}`;
  sprite.scale.set(worldHeight * aspectOf(tex), worldHeight, 1);
  return true;
}

/** 스프라이트 지오메트리는 three가 모든 Sprite에 공유하므로 버리지 않는다. 텍스처와 재질만. */
export function disposeLabel(sprite: Sprite): void {
  sprite.material.map?.dispose();
  sprite.material.dispose();
  sprite.removeFromParent();
}
