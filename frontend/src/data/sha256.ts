// 문자열(UTF-8 바이트)의 SHA-256을 소문자 16진수로. WebCrypto만 쓴다(외부 라이브러리 없음).
// 용도: CloudFront OAC(SigV4)로 보호된 Lambda URL에 POST할 때 필요한 x-amz-content-sha256 헤더.

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
